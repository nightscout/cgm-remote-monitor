'use strict';

// Parent-owned endpoint bootstrap only. No containers, process spawning, service
// discovery, listener, retry/fallback or import-time I/O. Credentials stay memory.
const fs=require('node:fs'), path=require('node:path'),crypto=require('node:crypto');
const plan=require('./bootstrap-plan'), provisioning=require('./bootstrap-grants');
const {quote:q}=provisioning;
const random=()=>crypto.randomBytes(24).toString('hex');
const sha1=value=>crypto.createHash('sha1').update(value).digest('hex');
module.exports=async function bootstrap(input) {
  const selected=plan.parse(input);
  if(input.env.NS_RT_BOOTSTRAP_NATIVE!=='1')throw new Error('EXPLICIT_PARENT_BOOTSTRAP_REQUIRED');
  const {Client}=require('pg'),{MongoClient}=require('mongodb'),{run}=require('../../../lib/migrations/postgres');
  const l=plan.layout(),ns=l.namespaces,o=selected.options;
  const reset=plan.resetPlan(l,provisioning.catalogues());
  const schemas=[],roles=[],policies=[],tokens=[],publicKeys=[],rootSecrets=[random(),random()];
  let admin,mongo,mounted=false,connected=false,mongoConnected=false,mongoOwned=false,closing,activePhase,step='connect';
  const roleURLs={},phaseEnvironment={},paths=Object.fromEntries(['api','evaluator','realtime','admission'].map(name=>[name,path.join(selected.directory.path,name+'.json')]));
  const socketPaths={api:path.join(selected.directory.path,'api.sock'),alarm:path.join(selected.directory.path,'alarm.sock')};
  const observe=async value=>input.onObservation(structuredClone({classification:'synthetic parent-owned bootstrap; no client verdict',...value}));
  const safeCode=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'BOOTSTRAP_REFUSAL';
  async function vault(resource,body,credential=input.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN,method=body===undefined?'GET':'POST') {
    let response;
    try {
      response=await fetch(selected.vault.url.origin+'/v1/'+resource,{method,redirect:'manual',headers:{'X-Vault-Token':credential,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(o.timeoutMs)});
      if(!response.ok){await response.body?.cancel();throw new Error('VAULT_BOOTSTRAP_REFUSED');}
      return response.status===204?{}:await response.json();
    }catch{throw new Error('JOINED_BOOTSTRAP_VAULT_REFUSED');}
  }
  async function close() {
    if(closing)return closing;
    closing=(async()=>{
      const errors=[];
      if(mongoConnected&&mongoOwned)try{await mongo.db(l.mongoDatabase).dropDatabase();}catch(error){errors.push(safeCode(error));}
      if(mongo)try{await mongo.close();}catch(error){errors.push(safeCode(error));}
      // Only objects successfully created by this bootstrap are removed.
      if(connected) {
        for(const name of [...schemas].reverse())try{await admin.query('DROP SCHEMA '+q(name)+' CASCADE');}catch(error){errors.push(safeCode(error));}
        for(const name of [...roles].reverse())try{await admin.query('DROP OWNED BY '+q(name));await admin.query('DROP ROLE '+q(name));}catch(error){errors.push(safeCode(error));}
      }
      for(const token of tokens)try{await vault('auth/token/revoke',{token});}catch(error){errors.push(safeCode(error));}
      for(const policy of policies)try{await vault('sys/policies/acl/'+policy,undefined,undefined,'DELETE');}catch(error){errors.push(safeCode(error));}
      if(mounted)try{await vault('sys/mounts/'+l.mount,undefined,undefined,'DELETE');}catch(error){errors.push(safeCode(error));}
      if(admin)try{await admin.end();}catch(error){errors.push(safeCode(error));}
      await observe({phase:'bootstrap-cleanup',schemas,roles,mongoDatabase:l.mongoDatabase,errors});
      if(errors.length)throw new Error('JOINED_BOOTSTRAP_OWNED_OBJECT_CLEANUP_REFUSED');
    })();return closing;
  }
  try {
    admin=new Client({connectionString:input.env.NS_TEST_POSTGRES_ADMIN_URI,connectionTimeoutMillis:o.timeoutMs,statement_timeout:o.timeoutMs});await admin.connect();connected=true;
    mongo=new MongoClient(input.env.CUSTOMCONNSTR_mongo,{serverSelectionTimeoutMS:o.timeoutMs,directConnection:true});await mongo.connect();mongoConnected=true;
    const databases=await mongo.db('admin').admin().listDatabases({nameOnly:true});
    if(databases.databases.some(row=>row.name===l.mongoDatabase))throw new Error('JOINED_BOOTSTRAP_MONGO_DATABASE_EXISTS');
    mongoOwned=true;
    step='catalogues';
    for(const [kind,catalogue]of Object.entries(provisioning.catalogues())) {
      // CREATE without IF NOT EXISTS establishes actual ownership before a
      // runner can partially fail; an existing namespace is never adopted.
      await admin.query('CREATE SCHEMA '+q(ns[kind]));
      schemas.push(ns[kind]);
      await run('up',{direct:true,connectionString:input.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:ns[kind],catalogue,statementTimeoutMs:o.timeoutMs});
    }
    step='roles';
    for(const [kind,name]of Object.entries(l.roles)) {
      const password=random();await admin.query('CREATE ROLE '+q(name)+" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '"+password+"'");roles.push(name);
      const url=new URL(input.env.NS_TEST_POSTGRES_ADMIN_URI);url.username=name;url.password=password;roleURLs[kind]=url.toString();
    }
    for(const sql of provisioning.grants(l))await admin.query(sql);
    step='vault';await vault('sys/mounts/'+l.mount,{type:'transit'});mounted=true;
    for(const [i,tenant]of [plan.A,plan.B].entries()) {
      for(const purpose of ['data','signing'])await vault(l.mount+'/keys/tenant-'+i+'-'+purpose,{type:'aes256-gcm96',exportable:false});
      await vault(l.mount+'/keys/tenant-'+i+'-access',{type:'ed25519',exportable:false});
      publicKeys.push({tenant,kid:'key1',publicKey:(await vault(l.mount+'/keys/tenant-'+i+'-access')).data.keys['1'].public_key});
      const policy=l.prefix+'_tenant_'+i;
      const rules=[`path "${l.mount}/decrypt/tenant-${i}-data" { capabilities = ["update"] }`,
        ...['hmac','verify'].map(op=>`path "${l.mount}/${op}/tenant-${i}-signing" { capabilities = ["update"] }`),
        `path "${l.mount}/sign/tenant-${i}-access" { capabilities = ["update"] }`];
      await vault('sys/policies/acl/'+policy,{policy:rules.join('\n')});policies.push(policy);
      const token=(await vault('auth/token/create',{policies:[policy],no_default_policy:true,ttl:o.credentialLifetimeSeconds+'s',renewable:false})).auth.client_token;
      if(typeof token!=='string'||!token)throw new Error('JOINED_BOOTSTRAP_TOKEN_REFUSED');tokens.push(token);
    }
    step='secret-component';
    const scope=require('../../../lib/storage/tenant-scope'),oldMode=scope.getTenancyMode();let persistence;
    scope.setTenancyMode('multi');
    try {
      persistence=await require('../../../lib/secrets/postgres').createPostgresSecrets({connectionString:roleURLs.api,namespace:ns.secrets});
      const providers=[0,1].map(i=>require('../../../lib/secrets/vault-transit').createVaultTransit({address:selected.vault.url.origin,mount:l.mount,
        encryptionKey:'tenant-'+i+'-data',signingKey:'tenant-'+i+'-signing',signingVersion:1,allowInsecureLoopback:true,timeoutMs:o.timeoutMs,
        getToken:async()=>input.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN}));
      const secrets=require('../../../lib/secrets/component').createSecrets({...persistence,maxTokenLifetimeSeconds:o.credentialLifetimeSeconds,
        providerFor:async tenant=>providers[tenant===plan.A?0:tenant===plan.B?1:(()=>{throw new Error('JOINED_BOOTSTRAP_TENANT_REFUSED');})()],
        authorize:async (identity,action)=>identity.principal==='bootstrap-operator'&&identity.consumer==='joined-fixture'&&action.operation==='encrypt'});
      for(const [i,tenant]of [plan.A,plan.B].entries())await secrets.encrypt({tenant,principal:'bootstrap-operator',consumer:'joined-fixture'},'root-'+i,Buffer.from(rootSecrets[i]));
    }finally{if(persistence)await persistence.close();scope.setTenancyMode(oldMode);}
    step='configuration';
    const docs=plan.documents({selected,layout:l,publicKeys,paths});
    // serve.internal: api and realtime each serve one socket; peers name them.
    const commonEnv={NS_API_INTERNAL_SOCKET:socketPaths.api,NS_REALTIME_INTERNAL_SOCKET:socketPaths.alarm,RT_BOOTSTRAP_ADMISSION:paths.admission};
    const evaluatorEnv={...commonEnv,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,EVALUATOR_HOSTNAME:'127.0.0.1',EVALUATOR_PORT:'0',
      RT_BOOTSTRAP_EVAL_PG:roleURLs.evaluator,RT_BOOTSTRAP_OUTBOX_PG:roleURLs.outbox,RT_BOOTSTRAP_SUPPRESSION_PG:roleURLs.suppression};
    const roleEnvironments={
      api:{...commonEnv,NS_SERVE_INTERNAL_SOCKET:socketPaths.api,MULTITENANT_PREVIEW_CONFIG:paths.api,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,API_HOSTNAME:'127.0.0.1',API_PORT:'0',
        RT_BOOTSTRAP_API_PG:roleURLs.api,RT_BOOTSTRAP_READINESS_PG:roleURLs.readiness,RT_BOOTSTRAP_ALARM_PG:roleURLs.alarm,
        RT_BOOTSTRAP_VAULT_0:tokens[0],RT_BOOTSTRAP_VAULT_1:tokens[1]},
      realtime:{...commonEnv,NS_SERVE_INTERNAL_SOCKET:socketPaths.alarm,MULTITENANT_REALTIME_CONFIG:paths.realtime,REALTIME_HOSTNAME:'127.0.0.1',REALTIME_PORT:'0',RT_BOOTSTRAP_RT_PG:roleURLs.realtime},
      evaluator:evaluatorEnv};
    for(const [name,document]of Object.entries(docs))if(name!=='paths')fs.writeFileSync(paths[name],JSON.stringify(document),{mode:0o600,flag:'wx'});
    // These are actual product parsers, not a fixture's approximation. API input
    // intentionally lacks ALL evaluator/outbox/suppression worker credentials.
    require('../../../lib/server/serve/evaluator-config').load(evaluatorEnv);
    require('../../../lib/server/realtime/config').load(roleEnvironments.realtime);
    for(const [role,environment]of Object.entries(roleEnvironments))require('../../../lib/server/internal-api/listener-config').resolve([role],environment);
    require('../../../lib/server/serve/preview-config').load(roleEnvironments.api);
    const configurationBase={version:1,timeoutMs:o.timeoutMs,observationMs:o.observationMs,settleMs:o.settleMs,snoozeMs:o.snoozeMs,
      tenant:plan.A,foreignTenant:plan.B,host:'one.example.test',foreignHost:'two.example.test',browserHost:'one.example.test',
      subjectId:plan.SUBJECT,staleSubjectId:plan.STALE,mainCredentialEnv:'RT_BOOTSTRAP_MAIN_A_JSON',dataCredentialEnv:'RT_BOOTSTRAP_MAIN_A_JSON',evaluatorConfigFile:paths.evaluator,namespaces:Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity'].map(d=>[d,ns[d]])),
      entriesNamespace:ns.entries,authorizationNamespace:ns.authorization,clockNamespace:ns.clock,alarmNamespace:ns.alarm,outboxNamespace:ns.outbox,
      consumerId:docs.evaluator.consumers.realtime.route.id,alarmSocketPath:socketPaths.alarm,maxMessageBytes:o.maxMessageBytes,
      mongoDatabase:l.mongoDatabase,profileUncertaintyResolved:false};
    const phaseConfigurations=Object.fromEntries(plan.phases.map(phase=>[phase,{...configurationBase,
      ...plan.phaseConfiguration(phase),
      ...(phase==='joined-socket-epoch'?{epochObservationMs:o.observationMs}:{}),
      foreignCredentialEnv:'RT_BOOTSTRAP_MAIN_B_JSON',staleCredentialEnv:'RT_BOOTSTRAP_STALE_ALARM_JSON',browserCredentialEnv:'RT_BOOTSTRAP_BROWSER_TOKEN',
      ...(phase==='joined-browser-consumer'?{uiFixture:selected.ui,browserResolverHosts:['one.example.test','two.example.test']}:{})}]));
    async function resetForPhase(phaseId) {
      if(closing||!plan.phases.includes(phaseId))throw new Error('JOINED_BOOTSTRAP_PHASE_REFUSED');
      activePhase=phaseId;step='reset-'+phaseId;
      const tables=reset.reset.map(row=>q(row.namespace)+'.'+q(row.table));
      // Record the exact explicit, preflighted owned reset before PostgreSQL can
      // refuse it. No credentials/provider data and no CASCADE/adopted tables.
      await observe({phase:'bootstrap-reset-plan',phaseId,reset:reset.reset,preserved:reset.preserved,foreignKeys:reset.foreignKeys});
      await admin.query('TRUNCATE '+tables.join(','));await mongo.db(l.mongoDatabase).dropDatabase();
      const now=Number((await admin.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms')).rows[0].now_ms);
      if(!Number.isSafeInteger(now)||now<1)throw new Error('JOINED_BOOTSTRAP_CLOCK_REFUSED');
      const exp=Math.floor(now/1000)+o.credentialLifetimeSeconds;
      const mgdl=['joined-consumer-handoff','joined-consumer-plugin-ack'].includes(phaseId)?50:123,foreign=177;
      for(const [i,tenant]of [plan.A,plan.B].entries()) {
        await admin.query('INSERT INTO '+q(ns.legacy)+'.legacy_credential_config VALUES ($1,$2)',[tenant,'root-'+i]);
        await admin.query('INSERT INTO '+q(ns.authorization)+'.tenant_authorization_config VALUES ($1,ARRAY[\'denied\'])',[tenant]);
        for(const [name,permissions] of Object.entries(plan.rolePermissions))await admin.query('INSERT INTO '+q(ns.authorization)+'.tenant_authorization_roles VALUES ($1,$2,$3)',[tenant,name,permissions]);
        await admin.query('INSERT INTO '+q(ns.access)+'.access_tenants VALUES ($1,true)',[tenant]);
        await admin.query('INSERT INTO '+q(ns.access)+'.access_keys VALUES ($1,\'key1\',\'data\',true)',[tenant]);
        for(const selectedSubject of plan.subjects) {
          const subject=selectedSubject.id;
          await admin.query('INSERT INTO '+q(ns.authorization)+'.tenant_authorization_subjects (tenant_id,subject_id,display_name) VALUES($1,$2,$3)',[tenant,subject,'Synthetic '+subject.slice(-1)]);
          await admin.query('INSERT INTO '+q(ns.authorization)+'.tenant_authorization_subject_roles VALUES($1,$2,$3)',[tenant,subject,selectedSubject.role]);
          await admin.query('INSERT INTO '+q(ns.legacy)+'.legacy_credential_subjects VALUES($1,$2,$3)',[tenant,subject,selectedSubject.legacy]);
          await admin.query('INSERT INTO '+q(ns.access)+'.access_credentials VALUES($1,$2,$2,1,true)',[tenant,subject]);
          await admin.query('INSERT INTO '+q(ns.access)+'.access_sessions VALUES($1,$2,$3,$3,1,$4,true,\'data\')',[tenant,'session-'+subject,subject,exp]);
          const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'ns-access+jwt',kid:'key1'})).toString('base64url');
          const body=Buffer.from(JSON.stringify({iss:'nightscout-joined-fixture',aud:'nightscout-data',tid:tenant,purpose:'data',sub:subject,sid:'session-'+subject,cv:1,iat:Math.floor(now/1000),nbf:Math.floor(now/1000),exp})).toString('base64url');
          const signingInput=header+'.'+body;
          const signed=await vault(l.mount+'/sign/tenant-'+i+'-access',{input:Buffer.from(signingInput).toString('base64'),key_version:1},tokens[i]);
          const token=signingInput+'.'+Buffer.from(signed.data.signature.split(':')[2],'base64').toString('base64url');
          Object.assign(phaseEnvironment,plan.credentials(i,subject,token));
        }
        const doc={_id:'synthetic-reading-'+i,type:'sgv',sgv:i?foreign:mgdl,date:now-1000,dateString:new Date(now-1000).toISOString(),direction:'Flat',device:'synthetic-bootstrap',srvModified:now};
        await admin.query('INSERT INTO '+q(ns.entries)+'.entries(tenant_id,id_kind,doc) VALUES($1,\'string\',$2::jsonb)',[tenant,JSON.stringify(doc)]);
        await admin.query('INSERT INTO '+q(ns.clock)+'.tenant_write_clock VALUES($1,$2)',[tenant,now]);
        for(const [kind,document]of [['rt_checkpoint',docs.realtime],['eval_checkpoint',docs.evaluator]]) {
          const replay=require('../../../lib/storage/postgres-durable-replay')({connection:{query(){throw new Error('constructor only');},snapshotTransaction(){throw new Error('constructor only');}},
            checkpointTable:ns[kind]+'.tenant_consumer_checkpoint',clockTable:ns.clock+'.tenant_write_clock',consumer:document.consumer,
            domains:Object.fromEntries(Object.keys(configurationBase.namespaces).map(d=>[d,ns[d]+'.'+d])),
            projectionVersion:kind==='rt_checkpoint'?'realtime-current-rows-v1':'clinical-current-rows-v1',pageSize:o.pageSize,maxRows:document.maxRows});
          await admin.query('INSERT INTO '+q(ns[kind])+'.tenant_consumer_checkpoint(tenant_id,consumer,contract_digest,checkpoint,projection) VALUES($1,$2,$3,0,NULL)',[tenant,document.consumer,replay.digest]);
        }
      }
      phaseEnvironment.RT_BOOTSTRAP_BROWSER_TOKEN='fixture-'+sha1(sha1(rootSecrets[0])+plan.SUBJECT).slice(0,16);
      const physical={};for(const [logical,namespace]of Object.entries(configurationBase.namespaces))physical[logical]=(await admin.query('SELECT tenant_id,id_kind,doc FROM '+q(namespace)+'.'+q(logical)+' ORDER BY tenant_id')).rows;
      const checkpoints={};for(const name of ['rt_checkpoint','eval_checkpoint'])checkpoints[name]=(await admin.query('SELECT * FROM '+q(ns[name])+'.tenant_consumer_checkpoint ORDER BY tenant_id')).rows;
      await observe({phase:'bootstrap-physical-baseline',phaseId,now,physical,checkpoints,consumerState:(await admin.query('SELECT * FROM '+q(ns.outbox)+'.tenant_notification_state')).rows,
        suppression:(await admin.query('SELECT * FROM '+q(ns.alarm)+'.tenant_alarm_suppression')).rows});
      const configuration={...phaseConfigurations[phaseId],syntheticMgdl:mgdl,foreignSyntheticMgdl:foreign};
      return {configuration,roleEnvironments,phaseEnvironment:{...phaseEnvironment}};
    }
    await observe({phase:'bootstrap-provisioned',tenants:[plan.A,plan.B],namespaces:ns,roles:l.roles,mongoDatabase:l.mongoDatabase,
      catalogues:Object.fromEntries(Object.entries(provisioning.catalogues()).map(([kind,c])=>[kind,c.migrations.map(({name,checksum})=>({name,checksum}))]))});
    return Object.freeze({phaseConfigurations,roleEnvironments,phaseEnvironment,resetForPhase,close,configurationFiles:[paths.api,paths.evaluator,paths.realtime,paths.admission],ownership:{tenant:plan.A,foreignTenant:plan.B,
      entriesNamespace:ns.entries,authorizationNamespace:ns.authorization,clockNamespace:ns.clock,alarmNamespace:ns.alarm,outboxNamespace:ns.outbox,
      namespaces:configurationBase.namespaces,mongoDatabase:l.mongoDatabase,configurationFiles:[paths.api,paths.evaluator,paths.realtime,paths.admission]},get activePhase(){return activePhase;}});
  }catch(error){await close();throw Object.assign(new Error('JOINED_BOOTSTRAP_REFUSED'),{code:safeCode(error),step});}
};
module.exports.plan=plan;
