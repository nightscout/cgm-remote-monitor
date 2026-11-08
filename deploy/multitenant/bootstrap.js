#!/usr/bin/env node
'use strict';

// One-shot provisioning for a dedicated synthetic Compose database. Serving
// processes never import this module and receive no provisioning credential.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const plan=require('./config');
const random=()=>crypto.randomBytes(32).toString('hex');
const sha1=value=>crypto.createHash('sha1').update(value).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
function input(env=process.env) {
  if(env.NS_COMPOSE_BOOTSTRAP!=='1'||!/^\/[\w/.-]+$/.test(env.NS_BOOTSTRAP_OUTPUT||'')||! /^[a-f0-9]{40}$/.test(env.NS_SOURCE_COMMIT||''))throw fail('EXPLICIT_COMPOSE_BOOTSTRAP_REQUIRED');
  let pg;
  if(env.NS_BOOTSTRAP_POSTGRES_URL)pg=new URL(env.NS_BOOTSTRAP_POSTGRES_URL);
  else {
    const password=fs.readFileSync(env.NS_POSTGRES_PASSWORD_FILE,'utf8').trim();
    if(!password)throw fail('BOOTSTRAP_POSTGRES_PASSWORD_REQUIRED');
    pg=new URL('postgres://postgres@postgres:5432/nightscout_compose_test');pg.password=password;
  }
  if(!['postgres:','postgresql:'].includes(pg.protocol)||!pg.username||!pg.password||decodeURIComponent(pg.pathname)!=='/nightscout_compose_test'||pg.search||pg.hash)throw fail('DEDICATED_SYNTHETIC_DATABASE_REQUIRED');
  const vault=new URL(env.VAULT_ADDR||'https://vault:8200');
  if(vault.protocol!=='https:'||vault.username||vault.password||vault.pathname!=='/'||vault.search||vault.hash)throw fail('BOOTSTRAP_VAULT_HTTPS_REQUIRED');
  const uid=Number(env.NS_RUNTIME_UID||1000),gid=Number(env.NS_RUNTIME_GID||1000);
  if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)throw fail('BOOTSTRAP_RUNTIME_ID_REQUIRED');
  return {pg,vault,output:path.resolve(env.NS_BOOTSTRAP_OUTPUT),sourceCommit:env.NS_SOURCE_COMMIT,uid,gid};
}
function writePrivate(filename,value,{uid,gid}={}) {
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  fs.writeFileSync(filename,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  if(uid!==undefined){fs.chownSync(path.dirname(filename),uid,gid);fs.chownSync(filename,uid,gid);}
}
async function bootstrap(options) {
  const {pg,vault,output,sourceCommit,uid,gid}=options;
  const privateDirectory=path.join(output,'bootstrap');fs.mkdirSync(privateDirectory,{recursive:true,mode:0o700});
  const initFile=path.join(privateDirectory,'vault-init.json'),completeFile=path.join(privateDirectory,'complete.json'),startedFile=path.join(privateDirectory,'started.json');
  async function request(resource,body,token,method=body===undefined?'GET':'POST'){
    const response=await fetch(vault.origin+'/v1/'+resource,{method,headers:{'Content-Type':'application/json',...(token?{'X-Vault-Token':token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(!response.ok){await response.body?.cancel();throw fail('BOOTSTRAP_VAULT_REFUSED');}
    return response.status===204?{}:response.json();
  }
  let initialization;
  const status=await request('sys/init');
  if(!status.initialized){
    if(fs.existsSync(initFile))throw fail('BOOTSTRAP_VAULT_STATE_CHANGED');
    initialization=await request('sys/init',{secret_shares:1,secret_threshold:1});
    writePrivate(initFile,initialization);
  }else{
    if(!fs.existsSync(initFile))throw fail('BOOTSTRAP_VAULT_CUSTODY_MISSING');
    initialization=JSON.parse(fs.readFileSync(initFile,'utf8'));
  }
  const seal=await request('sys/seal-status');
  if(seal.sealed){const unsealed=await request('sys/unseal',{key:initialization.keys_base64[0]});if(unsealed.sealed)throw fail('BOOTSTRAP_VAULT_UNSEAL_REFUSED');}
  if(fs.existsSync(completeFile)){
    const complete=JSON.parse(fs.readFileSync(completeFile,'utf8'));
    if(complete.version!==1||complete.sourceCommit!==sourceCommit)throw fail('BOOTSTRAP_SOURCE_CHANGED_RECREATE_DEMO');
    return {state:'existing-demo-unsealed',sourceCommit};
  }
  if(fs.existsSync(startedFile))throw fail('BOOTSTRAP_PARTIAL_RECREATE_DEMO');
  writePrivate(startedFile,{version:1,sourceCommit});
  const l=plan.layout(),q=plan.quote,allCatalogues=plan.catalogues(),roleURLs={};
  const {Client}=require('pg'),admin=new Client({connectionString:pg.toString(),connectionTimeoutMillis:10000,statement_timeout:10000});
  await admin.connect();
  try{
    // This script owns a dedicated database. It never adopts existing application
    // schemas/roles; a partial run must be inspected and its demo volumes replaced.
    const preexisting=await admin.query('SELECT nspname FROM pg_namespace WHERE nspname LIKE $1',[l.prefix+'_%']);
    const roles=await admin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1',[l.prefix+'_%']);
    if(preexisting.rows.length||roles.rows.length)throw fail('BOOTSTRAP_OBJECTS_ALREADY_EXIST');
    await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await admin.query('REVOKE CREATE ON DATABASE '+q(decodeURIComponent(pg.pathname.slice(1)))+' FROM PUBLIC');
    await admin.query('CREATE ROLE '+q(l.owner)+' NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
    for(const [kind,role]of Object.entries(l.roles)){
      const password=random();await admin.query('CREATE ROLE '+q(role)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'");
      const url=new URL(pg);url.username=role;url.password=password;roleURLs[kind]=url.toString();
    }
    const {run}=require('../../lib/migrations/postgres');
    for(const [kind,catalogue]of Object.entries(allCatalogues)){
      const namespace=l.namespaces[kind];await admin.query('CREATE SCHEMA '+q(namespace));
      await run('up',{direct:true,connectionString:pg.toString(),namespace,catalogue,statementTimeoutMs:10000});
      // Readiness requires immutable catalogue owners without LOGIN/bypass.
      const tables=await admin.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[namespace]);
      for(const row of tables.rows)await admin.query('ALTER TABLE '+q(namespace)+'.'+q(row.tablename)+' OWNER TO '+q(l.owner));
      const functions=await admin.query('SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1',[namespace]);
      for(const row of functions.rows){if(row.args!=='')throw fail('BOOTSTRAP_UNREVIEWED_FUNCTION_SIGNATURE');await admin.query('ALTER FUNCTION '+q(namespace)+'.'+q(row.proname)+'() OWNER TO '+q(l.owner));}
      await admin.query('ALTER SCHEMA '+q(namespace)+' OWNER TO '+q(l.owner));
    }
    for(const sql of plan.grants(l))await admin.query(sql);
    const rootToken=initialization.root_token;
    await request('sys/mounts/'+l.mount,{type:'transit'},rootToken);
    const tokens=[],publicKeys=[],managementKeys=[],roots=[random(),random()];
    for(const [i,tenant]of [plan.A,plan.B].entries()){
      for(const purpose of ['data','signing'])await request(l.mount+'/keys/tenant-'+i+'-'+purpose,{type:'aes256-gcm96',exportable:false},rootToken);
      for(const purpose of ['access','management']){
        await request(l.mount+'/keys/tenant-'+i+'-'+purpose,{type:'ed25519',exportable:false},rootToken);
        const key=(await request(l.mount+'/keys/tenant-'+i+'-'+purpose,undefined,rootToken)).data.keys['1'].public_key;
        (purpose==='access'?publicKeys:managementKeys).push({tenant,kid:purpose==='access'?'key1':'management1',publicKey:key});
      }
      const policy=l.prefix+'_tenant_'+i;
      const rules=[`path "${l.mount}/decrypt/tenant-${i}-data" { capabilities = ["update"] }`,
        ...['hmac','verify'].map(op=>`path "${l.mount}/${op}/tenant-${i}-signing" { capabilities = ["update"] }`),
        `path "${l.mount}/sign/tenant-${i}-access" { capabilities = ["update"] }`];
      await request('sys/policies/acl/'+policy,{policy:rules.join('\n')},rootToken);
      const token=(await request('auth/token/create',{policies:[policy],no_default_policy:true,ttl:'24h',renewable:false},rootToken)).auth.client_token;
      if(typeof token!=='string'||!token)throw fail('BOOTSTRAP_SCOPED_TOKEN_MISSING');tokens.push(token);
    }
    const scope=require('../../lib/storage/tenant-scope');scope.setTenancyMode('multi');
    const persistence=await require('../../lib/secrets/postgres').createPostgresSecrets({connectionString:roleURLs.api,namespace:l.namespaces.secrets});
    try{
      const providers=roots.map((_,i)=>require('../../lib/secrets/vault-transit').createVaultTransit({address:vault.origin,mount:l.mount,encryptionKey:'tenant-'+i+'-data',signingKey:'tenant-'+i+'-signing',signingVersion:1,getToken:async()=>rootToken}));
      const secrets=require('../../lib/secrets/component').createSecrets({...persistence,maxTokenLifetimeSeconds:28800,
        providerFor:async tenant=>providers[tenant===plan.A?0:tenant===plan.B?1:(()=>{throw fail('BOOTSTRAP_TENANT_REFUSED');})()],
        authorize:async(identity,action)=>identity.principal==='bootstrap-operator'&&identity.consumer==='compose-demo'&&action.operation==='encrypt'});
      for(const [i,tenant]of [plan.A,plan.B].entries())await secrets.encrypt({tenant,principal:'bootstrap-operator',consumer:'compose-demo'},'root-'+i,Buffer.from(roots[i]));
    }finally{await persistence.close();}
    const docs=plan.documents({layout:l,urls:roleURLs,tokens,publicKeys,managementKeys,vaultAddress:vault.origin});
    const ns=l.namespaces,t=(name,table)=>q(ns[name])+'.'+q(table),demoTokens=[],managementTokens=[];
    const now=Date.now(),exp=Math.floor(now/1000)+600,permissions=['api:*:read','api:*:create,update,delete','notifications:*:ack'];
    const catalogue=['api:entries:read'],digest=require('../../lib/subject-admin/owner-policy').catalogueDigest(catalogue);
    for(const [i,tenant]of [plan.A,plan.B].entries()){
      await admin.query('BEGIN');
      try{
        await admin.query("SELECT set_config('app.current_tenant_id',$1,true)",[tenant]);
        await admin.query('INSERT INTO '+t('legacy','legacy_credential_config')+'(tenant_id,root_reference_id) VALUES($1,$2)',[tenant,'root-'+i]);
        await admin.query('INSERT INTO '+t('authorization','tenant_authorization_config')+'(tenant_id,anonymous_roles) VALUES($1,ARRAY[\'denied\'])',[tenant]);
        await admin.query('INSERT INTO '+t('authorization','tenant_authorization_roles')+'(tenant_id,name,permissions) VALUES($1,\'demo\',$2)',[tenant,permissions]);
        await admin.query('INSERT INTO '+t('authorization','tenant_authorization_subjects')+'(tenant_id,subject_id,display_name) VALUES($1,$2,\'Synthetic demo uploader\')',[tenant,plan.subject]);
        await admin.query('INSERT INTO '+t('authorization','tenant_authorization_subject_roles')+' VALUES($1,$2,\'demo\')',[tenant,plan.subject]);
        await admin.query('INSERT INTO '+t('legacy','legacy_credential_subjects')+' VALUES($1,$2,\'demo\')',[tenant,plan.subject]);
        await admin.query('INSERT INTO '+t('authorization','tenant_owner_policy')+'(tenant_id,catalogue_digest,ceiling) VALUES($1,$2,$3)',[tenant,digest,catalogue]);
        await admin.query('INSERT INTO '+t('authorization','tenant_owner_actors')+'(tenant_id,principal,consumer,active,can_update,delegable) VALUES($1,$2,\'compose-owner\',true,true,$3)',[tenant,plan.subject,catalogue]);
        await admin.query('INSERT INTO '+t('access','access_tenants')+' VALUES($1,true)',[tenant]);
        await admin.query('INSERT INTO '+t('access','access_keys')+' VALUES($1,\'key1\',\'data\',true),($1,\'management1\',\'management\',true)',[tenant]);
        await admin.query('INSERT INTO '+t('access','access_credentials')+' VALUES($1,$2,$2,1,true)',[tenant,plan.subject]);
        await admin.query('INSERT INTO '+t('access','access_sessions')+' VALUES($1,\'compose-management\',$2,$2,1,$3,true,\'management\')',[tenant,plan.subject,exp]);
        const doc={_id:'synthetic-reading-'+i,type:'sgv',sgv:i?177:123,date:now-1000,dateString:new Date(now-1000).toISOString(),direction:'Flat',device:'synthetic-compose-demo',srvModified:now};
        await admin.query('INSERT INTO '+t('entries','entries')+'(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[tenant,JSON.stringify(doc)]);
        await admin.query('INSERT INTO '+t('clock','tenant_write_clock')+' VALUES($1,$2)',[tenant,now]);
        for(const [kind,document]of [['rt_checkpoint',docs.configs.realtime],['eval_checkpoint',docs.configs.evaluator]]){
          const replay=require('../../lib/storage/postgres-durable-replay')({connection:{query(){throw fail('CONSTRUCTOR_ONLY');},snapshotTransaction(){throw fail('CONSTRUCTOR_ONLY');}},
            checkpointTable:ns[kind]+'.tenant_consumer_checkpoint',clockTable:ns.clock+'.tenant_write_clock',consumer:document.consumer,
            domains:Object.fromEntries(plan.clinical.map(d=>[d,ns[d]+'.'+d])),projectionVersion:kind==='rt_checkpoint'?'realtime-current-rows-v1':'clinical-current-rows-v1',pageSize:100,maxRows:10000});
          await admin.query('INSERT INTO '+t(kind,'tenant_consumer_checkpoint')+'(tenant_id,consumer,contract_digest,checkpoint,projection) VALUES($1,$2,$3,0,NULL)',[tenant,document.consumer,replay.digest]);
        }
        await admin.query('INSERT INTO '+t('control','tenant_lifecycle_windows')+'(tenant_id,lock_key,phase,generation) VALUES($1,$2,\'active\',1)',[tenant,docs.locks[i].key]);
        if(i===0)await admin.query('INSERT INTO '+t('control','tenant_lifecycle_restore_authority')+'(tenant_id,role_oid,active) VALUES($1,$2::regrole::oid,true)',[tenant,l.roles.operator]);
        await admin.query('COMMIT');
      }catch(error){await admin.query('ROLLBACK');throw error;}
      demoTokens.push('demo-'+sha1(sha1(roots[i])+plan.subject).slice(0,16));
      const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'ns-access+jwt',kid:'management1'})).toString('base64url');
      const claims={iss:'nightscout-compose-management',aud:'nightscout-management',tid:tenant,purpose:'management',sub:plan.subject,sid:'compose-management',cv:1,iat:Math.floor(now/1000),nbf:Math.floor(now/1000),exp};
      const payload=header+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature=(await request(l.mount+'/sign/tenant-'+i+'-management',{input:Buffer.from(payload).toString('base64'),key_version:1},rootToken)).data.signature;
      managementTokens.push(payload+'.'+Buffer.from(signature.split(':')[2],'base64').toString('base64url'));
    }
    const own={uid,gid};
    for(const role of plan.serviceRoles){
      const directory=path.join(output,role);writePrivate(path.join(directory,'env.json'),docs.environments[role],own);
      writePrivate(path.join(directory,'config.json'),docs.configs[role],own);writePrivate(path.join(directory,'operation.json'),docs.operations[role],own);
      if(role==='api'){writePrivate(path.join(directory,'evaluator-metadata.json'),docs.configs.evaluator,own);writePrivate(path.join(directory,'admission.json'),docs.admission,own);}
      if(role==='realtime')writePrivate(path.join(directory,'admission.json'),docs.admission,own);
    }
    plan.validateFiles(output,docs);
    writePrivate(path.join(output,'ui','config.json'),docs.ui,own);
    const lifecycle=plan.lifecycle(l);
    const operatorConfig={version:1,drainTimeoutMs:10000,tenants:[plan.A,plan.B].map((id,i)=>({id,host:docs.configs.api.tenants[i].aliases[0],tokenEnv:i?'NS_DEMO_TOKEN_B':'NS_DEMO_TOKEN_A'})),
      apiOrigin:'http://api:1337',control:{namespace:ns.control,locks:docs.locks,participants:docs.remote},...lifecycle};
    writePrivate(path.join(output,'ops','config.json'),operatorConfig,own);
    writePrivate(path.join(output,'ops','env.json'),{NS_OPERATOR_PG:roleURLs.operator,NS_DEMO_TOKEN_A:demoTokens[0],NS_DEMO_TOKEN_B:demoTokens[1],NS_SOURCE_COMMIT:sourceCommit},own);
    writePrivate(path.join(output,'ops','tenants.json'),{version:1,tenants:[plan.A,plan.B].map((id,i)=>({id,host:docs.configs.api.tenants[i].aliases[0],dataToken:demoTokens[i],managementToken:managementTokens[i],managementExpiresAt:exp}))},own);
    writePrivate(path.join(output,'bootstrap','layout.json'),l);
    writePrivate(completeFile,{version:1,sourceCommit});
    return {state:'synthetic-demo-provisioned',sourceCommit};
  }finally{await admin.end();}
}
if(require.main===module){Promise.resolve().then(()=>bootstrap(input())).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(JSON.stringify({error:/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'COMPOSE_BOOTSTRAP_FAILED'})+'\n');process.exitCode=1;});}
module.exports={input,writePrivate,bootstrap};
