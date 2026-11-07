'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const fixture=require('./fixtures/realtime-preview/bootstrap');
const plan=fixture.plan;
const sourceDir=path.resolve(__dirname,'..');
function bounds(){return {timeoutMs:1000,recoveryIntervalMs:100,timeIntervalMs:100,pollIntervalMs:100,retryIntervalMs:100,retryDelayMs:10,
  attemptTimeoutMs:2000,maxRows:100,maxBytes:100000,pageSize:10,maxMessageBytes:30000,maxPayloadBytes:10000,maxConnections:2,maxInflight:2,maxSockets:10,
  snoozeMs:1000,settleMs:100,observationMs:100,credentialLifetimeSeconds:3600};}
describe('parent-owned realtime bootstrap source contract',function(){
  let dir,input;
  beforeEach(function(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-b-'));fs.chmodSync(dir,0o700);
    const pins=require('./fixtures/realtime-preview/early').plan.pins;
    const resource=(kind,port,database)=>({kind,host:'127.0.0.1',port,database,containerId:'synthetic-owned-'+kind,image:pins[kind],labelKey:'synthetic-owner',labelValue:'synthetic-phase',mounts:[]});
    input={sourceDir,captureDir:dir,onObservation(){},env:{NS_TEST_POSTGRES_ADMIN_URI:'postgres://synthetic-admin:synthetic@127.0.0.1:15432/bootstrap_test',
      CUSTOMCONNSTR_mongo:'mongodb://127.0.0.1:27017/synthetic',NS_RT_BOOTSTRAP_VAULT_ADDRESS:'http://127.0.0.1:18200',NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN:'synthetic-vault-root',
      NS_RT_BOOTSTRAP_OPTIONS_JSON:JSON.stringify(bounds()),NS_RT_BOOTSTRAP_UI_JSON:JSON.stringify({bundleDirectory:'/tmp/synthetic-bundle',expectedBundleSha256:'0'.repeat(64),settings:{units:'mg/dl'}})},
      resources:[resource('postgres',15432,'bootstrap_test'),resource('mongo',27017),resource('vault',18200),{kind:'private-directory',path:dir,mode:0o700,ownerUid:process.getuid()}]};});
  afterEach(function(){fs.rmSync(dir,{recursive:true,force:true});});
  it('refuses execution without explicit grant before loading or opening any service capability',async function(){
    await assert.rejects(fixture(input),/EXPLICIT_PARENT_BOOTSTRAP_REQUIRED/);
    assert.equal(plan.parse(input).options.maxRows,100);
  });
  it('refuses resource endpoint image ownership bounds and directory mismatches instead of discovering replacement services',function(){
    for(const mutate of [x=>x.resources[0].port++,x=>x.resources[0].image='postgres:latest',x=>x.resources[0].database='other_test',
      x=>x.resources.push({...x.resources[0]}),x=>x.resources[1].host='192.0.2.1',x=>delete x.env.NS_RT_BOOTSTRAP_VAULT_ROOT_TOKEN,
      x=>x.resources[3].ownerUid++,x=>x.env.NS_RT_BOOTSTRAP_OPTIONS_JSON='{}',x=>x.env.NS_RT_BOOTSTRAP_UI_JSON='{}']) {
      const changed={...input,env:{...input.env},resources:structuredClone(input.resources)};mutate(changed);assert.throws(()=>plan.parse(changed),/INPUT_REFUSED/);
    }
    assert.throws(()=>require('../lib/tenant-resolution')({aliases:[{host:'127.0.0.1',tenant:plan.A}]}),error=>error.code==='TENANT_HOST_INVALID','BOOTSTRAP_NUMERIC_HOST_REFUSED');
    fs.chmodSync(dir,0o755);assert.throws(()=>plan.parse(input),/INPUT_REFUSED/);
  });
  it('feeds actual API RT and evaluator parsers with one metadata-linked config and no worker credentials in API',function(){
    const selected=plan.parse(input),layout=plan.layout('0123456789abcdef'),paths=Object.fromEntries(['api','realtime','evaluator','admission'].map(n=>[n,path.join(dir,n+'.json')]));
    const publicKeys=[plan.A,plan.B].map(tenant=>({tenant,kid:'key1',publicKey:Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url').toString('base64')}));
    const docs=plan.documents({selected,layout,publicKeys,paths});for(const name of ['api','realtime','evaluator','admission'])fs.writeFileSync(paths[name],JSON.stringify(docs[name]));
    const url=name=>'postgres://synthetic-'+name+':synthetic@127.0.0.1:15432/bootstrap_test';
    const common={RT_BOOTSTRAP_API_SOCKET:path.join(dir,'api.sock'),RT_BOOTSTRAP_ALARM_SOCKET:path.join(dir,'alarm.sock'),RT_BOOTSTRAP_ADMISSION:paths.admission};
    const api={...common,MULTITENANT_PREVIEW_CONFIG:paths.api,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,RT_BOOTSTRAP_API_PG:url('api'),
      RT_BOOTSTRAP_READINESS_PG:url('readiness'),RT_BOOTSTRAP_ALARM_PG:url('alarm'),RT_BOOTSTRAP_VAULT_0:'synthetic-a',RT_BOOTSTRAP_VAULT_1:'synthetic-b'};
    const worker={...common,MULTITENANT_EVALUATOR_CONFIG:paths.evaluator,RT_BOOTSTRAP_EVAL_PG:url('evaluator'),RT_BOOTSTRAP_OUTBOX_PG:url('outbox'),RT_BOOTSTRAP_SUPPRESSION_PG:url('suppression')};
    const realtime={...common,MULTITENANT_REALTIME_CONFIG:paths.realtime,RT_BOOTSTRAP_RT_PG:url('realtime')};
    const accepted=require('../lib/server/serve/preview-config').load(api);
    const evaluated=require('../lib/server/serve/evaluator-config').load(worker);
    const delivered=require('../lib/server/realtime/config').load(realtime);
    assert.equal(accepted.socketForwarding.consumerState.consumer,evaluated.consumers.realtime.route.id,'BOOTSTRAP_SAME_CONSUMER_LOCK_BINDING');
    assert.equal(delivered.tenants.get(plan.A).identity,evaluated.tenants.get(plan.A).identity,'BOOTSTRAP_SHARED_EFFECTIVE_IDENTITY');
    assert.equal(delivered.tenants.get(plan.A).identity,delivered.tenants.get(plan.B).identity,'equal config prevents isolation test being masked by identity mismatch');
    assert.notEqual(evaluated.namespaces.checkpoint,delivered.namespaces.checkpoint);
    assert.equal(Object.keys(api).some(key=>/EVAL_PG|OUTBOX_PG|SUPPRESSION_PG/.test(key)),false,'BOOTSTRAP_API_NO_WORKER_CREDENTIALS');
    assert.equal(Object.keys(realtime).some(key=>/VAULT|SIGN|DECRYPT|SECRET/.test(key)),false);
    assert.deepEqual(Object.keys(require('./fixtures/realtime-preview/bootstrap-grants').catalogues()).sort(),Object.keys(layout.namespaces).sort());
  });
  it('keeps the initial explicit cold evaluator bound below realtime while both actual role configuration parsers accept it and infrastructure stays pinned',async function(){
    const options={...bounds(),pageSize:1,evaluatorMaxRows:3,realtimeMaxRows:100};
    const selected=plan.parse({...input,env:{...input.env,NS_RT_BOOTSTRAP_OPTIONS_JSON:JSON.stringify(options)}});
    assert.equal(plan.parse(input).options.evaluatorMaxRows,options.maxRows);
    assert.equal(plan.parse(input).options.realtimeMaxRows,options.maxRows);
    const layout=plan.layout('0123456789abcdef'),paths=Object.fromEntries(['api','realtime','evaluator','admission'].map(n=>[n,path.join(dir,n+'.json')]));
    const docs=plan.documents({selected,layout,publicKeys:[],paths});fs.writeFileSync(paths.evaluator,JSON.stringify(docs.evaluator));
    const url=name=>'postgres://synthetic-'+name+':synthetic@127.0.0.1:15432/bootstrap_test';
    const env={RT_BOOTSTRAP_EVAL_PG:url('evaluator'),RT_BOOTSTRAP_OUTBOX_PG:url('outbox'),RT_BOOTSTRAP_SUPPRESSION_PG:url('suppression'),
      RT_BOOTSTRAP_RT_PG:url('realtime'),RT_BOOTSTRAP_API_SOCKET:path.join(dir,'api.sock'),RT_BOOTSTRAP_ALARM_SOCKET:path.join(dir,'alarm.sock'),RT_BOOTSTRAP_ADMISSION:paths.admission};
    const evaluated=require('../lib/server/serve/evaluator-config').parse(docs.evaluator,env);
    const delivered=require('../lib/server/realtime/config').parse(docs.realtime,env);
    assert.equal(evaluated.maxRows,3,'BOOTSTRAP_COLD_EVALUATOR_BOUND');assert.equal(delivered.maxRows,100,'BOOTSTRAP_REALTIME_REMAINS_ADMITTED');
    const link=require('../lib/server/realtime/notification-state-config')({evaluatorConfigEnv:'LINK'},{LINK:paths.evaluator},{namespace:layout.namespaces.alarm,connectionString:url('ack')});
    assert.equal((await link.readCurrent(plan.A)).identity,evaluated.tenants.get(plan.A).identity);
    docs.evaluator.maxRows++;fs.writeFileSync(paths.evaluator,JSON.stringify(docs.evaluator));await assert.rejects(link.readCurrent(plan.A),/restart/,'cold test must not change infrastructure after API boot');
    for(const changes of [{evaluatorMaxRows:0},{evaluatorMaxRows:3,pageSize:4},{realtimeMaxRows:3,pageSize:4}]) {
      assert.throws(()=>plan.parse({...input,env:{...input.env,NS_RT_BOOTSTRAP_OPTIONS_JSON:JSON.stringify({...options,...changes})}}),/INPUT_REFUSED/);
    }
    assert.ok(plan.phases.includes('joined-consumer-plugin-ack'));
  });

  it('uses the callable export, exact immutable image IDs and six exact consumed phase/carrier bindings',function(){
    assert.equal(typeof fixture,'function');
    assert.deepEqual(plan.phases,['joined-role-recovery','joined-data-parity','joined-consumer-handoff','joined-consumer-plugin-ack','joined-socket-epoch','joined-browser-consumer']);
    assert.equal(plan.phaseConfiguration('joined-consumer-plugin-ack').credentialEnv,'RT_BOOTSTRAP_ALARM_A_JSON');
    assert.equal(plan.phaseConfiguration('joined-consumer-handoff').credentialEnv,'RT_BOOTSTRAP_ALARM_A_JSON');
    assert.equal(plan.phaseConfiguration('joined-socket-epoch').epochStatusCredentialEnv,'RT_BOOTSTRAP_EPOCH_STATUS_JSON');
    assert.throws(()=>plan.phaseConfiguration('nearest-epoch'),/INPUT_REFUSED/);
    assert.equal(plan.parse(input).options.maxRows,100);
    for(const kind of ['postgres','mongo','vault'])for(const image of [kind+'@'+require('./fixtures/realtime-preview/early').plan.pins[kind],
      'prefix'+require('./fixtures/realtime-preview/early').plan.pins[kind],require('./fixtures/realtime-preview/early').plan.pins[kind].slice(0,-1)+'x']) {
      const resources=structuredClone(input.resources);resources.find(row=>row.kind===kind).image=image;
      assert.throws(()=>plan.parse({...input,resources}),/INPUT_REFUSED/,'BOOTSTRAP_IMAGE_EXACT_NOT_LOOKALIKE');
    }
  });
  it('seeds status as a separate least-privilege subject and encodes real token carriers for both namespaces',function(){
    const actor=plan.subjects.find(row=>row.id===plan.STATUS);assert(actor);assert.equal(actor.role,'status');
    assert.deepEqual(plan.rolePermissions.status,['api:status:read']);assert.notEqual(plan.STATUS,plan.SUBJECT);assert.notEqual(plan.STATUS,plan.STALE);
    const current=plan.credentials(0,plan.SUBJECT,'synthetic-wire-token'),status=plan.credentials(0,plan.STATUS,'synthetic-status-token');
    const {credentialFor}=require('../lib/server/realtime/authority');
    assert.deepEqual(credentialFor('/',JSON.parse(current.RT_BOOTSTRAP_EPOCH_READ_JSON)),{token:'synthetic-wire-token'});
    assert.deepEqual(credentialFor('/alarm',JSON.parse(current.RT_BOOTSTRAP_EPOCH_READ_JSON)),{accessToken:'synthetic-wire-token'});
    assert.deepEqual(credentialFor('/',JSON.parse(status.RT_BOOTSTRAP_EPOCH_STATUS_JSON)),{token:'synthetic-status-token'});
    assert.deepEqual(credentialFor('/alarm',JSON.parse(status.RT_BOOTSTRAP_EPOCH_STATUS_JSON)),{accessToken:'synthetic-status-token'});
    assert.deepEqual(credentialFor('/alarm',JSON.parse(current[plan.phaseConfiguration('joined-consumer-plugin-ack').credentialEnv])),{accessToken:'synthetic-wire-token'});
  });
  it('verifies signed status credentials through actual token/access-SQL/socket authority modules and current revocation (source protocol only)',async function(){
    const connectionPath=require.resolve('../lib/storage/postgres-connection'),accessPath=require.resolve('../lib/tenant-authorization/access-postgres');
    require(connectionPath);const priorConnect=require.cache[connectionPath].exports,priorAccess=require.cache[accessPath];
    const scope=require('../lib/storage/tenant-scope'),oldMode=scope.getTenancyMode();let current=true,authority;
    // Synthetic query-row protocol, not a PostgreSQL or native permission claim.
    const connection={withTenant:async(tenant,fn)=>fn(),end:async()=>{},query:async(sql,args)=>{
      if(sql.includes('FROM pg_class'))return {rows:Array.from({length:8},()=>({secured:true,owns:false,reads:true,writes:false}))};
      assert(sql.includes('JOIN')&&sql.includes('tenant_authorization_roles'));assert.equal(args[0],plan.A);
      const subject=plan.subjects.find(row=>row.id===args[1]);assert(subject);
      return {rows:[{active:current,credential_enabled:true,generation:1,session_active:true,session_generation:1,expires_at:2000,
        key_active:true,display_name:'Synthetic status actor',anonymous_roles:['denied'],role_name:subject.role,found_role:subject.role,permissions:plan.rolePermissions[subject.role]}]};
    }};
    try {
      require.cache[connectionPath].exports=async()=>connection;delete require.cache[accessPath];scope.setTenancyMode('multi');
      authority=await require(accessPath)({namespace:'synthetic_access',authorityNamespace:'synthetic_auth'});
      const pair=crypto.generateKeyPairSync('ed25519'),tokens=require('../lib/tenant-authorization/access-token');
      const verifyToken=tokens.createVerifier({issuer:'synthetic-source',audience:'synthetic-data',purpose:'data',maxLifetimeSeconds:3600,now:()=>1000,
        resolveKey:(tenant,kid)=>({tenant,kid,issuer:'synthetic-source',purpose:'data',publicKey:pair.publicKey})});
      const authenticate=tokens.createAuthentication({verifyToken,snapshot:authority.snapshot,now:()=>1000});
      const socket=require('../lib/server/realtime/authority').create({accessTokens:{authenticate},admission:{allows:async()=>true},
        verifierContext:async tenant=>({tenant}),secrets:{verifyLegacyCredential(){throw new Error('NO_LEGACY_FALLBACK');}},
        authority:{subjectSnapshot(){throw new Error('NO_SNAPSHOT_BYPASS');},authorize(){throw new Error('NO_PERMISSION_BYPASS');}}});
      const signed=subject=>{const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'ns-access+jwt',kid:'key1'})).toString('base64url');
        const body=Buffer.from(JSON.stringify({iss:'synthetic-source',aud:'synthetic-data',tid:plan.A,purpose:'data',sub:subject,sid:'session-'+subject,cv:1,iat:1000,nbf:1000,exp:2000})).toString('base64url');
        return header+'.'+body+'.'+crypto.sign(null,Buffer.from(header+'.'+body),pair.privateKey).toString('base64url');};
      const full=await socket.verify({tenant:plan.A,namespace:'/',credential:{token:signed(plan.SUBJECT)}});
      assert.deepEqual(full.permissions,{read:true,write:true,write_treatment:true,ack:true},'BOOTSTRAP_FULL_WRITER_SEPARATE_FROM_STATUS');
      for(const namespace of ['/','/alarm']) {
        const credential=require('../lib/server/realtime/authority').credentialFor(namespace,JSON.parse(plan.credentials(0,plan.STATUS,signed(plan.STATUS)).RT_BOOTSTRAP_EPOCH_STATUS_JSON));
        const admitted=await socket.verify({tenant:plan.A,namespace,credential});
        assert.deepEqual(admitted.permissions,{read:false,write:false,write_treatment:false,ack:false});assert.deepEqual(admitted.collections,[]);
        current=false;await assert.rejects(socket.verify({tenant:plan.A,namespace,credential}),error=>error.code==='AUTHORITY_FORBIDDEN');current=true;
      }
    } finally {
      if(authority)await authority.close();require.cache[connectionPath].exports=priorConnect;
      if(priorAccess)require.cache[accessPath]=priorAccess;else delete require.cache[accessPath];scope.setTenancyMode(oldMode);
    }
  });

  it('preflights the explicit owned reset against every actual selected catalogue table and FK edge',function(){
    const catalogues=require('./fixtures/realtime-preview/bootstrap-grants').catalogues(),layout=plan.layout('0123456789abcdef');
    const reset=plan.resetPlan(layout,catalogues);
    for(const table of ['tenant_owner_policy','tenant_owner_actors','tenant_subject_admin_audit'])assert(reset.reset.some(row=>row.domain==='authorization'&&row.table===table),'RESET_INCLUDES_'+table);
    assert(reset.reset.some(row=>row.domain==='secrets'&&row.table==='secret_audit'));
    assert.deepEqual(reset.preserved,[{domain:'secrets',namespace:layout.namespaces.secrets,table:'secret_records'}]);
    assert.equal(reset.reset.length,33);assert.equal(reset.foreignKeys.length,8);
    assert.deepEqual(reset.reset.filter(row=>row.table==='tenant_insertion_ordinal').map(row=>row.domain).sort(), ['devicestatus','entries','food','profile','treatments']);
    assert(reset.foreignKeys.some(row=>row.from==='tenant_owner_actors'&&row.to==='tenant_owner_policy'));
    assert(reset.foreignKeys.some(row=>row.from==='tenant_owner_policy'&&row.to==='tenant_authorization_config'));
    assert(reset.reset.every(row=>row.namespace===layout.namespaces[row.domain]&&row.table!=='schema_migrations'));
  });
  it('rejects omitted FK referencers and incomplete audit coverage before any SQL or foreign-schema adoption',function(){
    const catalogues=require('./fixtures/realtime-preview/bootstrap-grants').catalogues(),layout=plan.layout('0123456789abcdef');
    for(const table of ['tenant_owner_policy','tenant_owner_actors']) {
      const tables=plan.resetTables();tables.authorization=tables.authorization.filter(name=>name!==table);
      assert.throws(()=>plan.resetPlan(layout,catalogues,tables),/RESET_FK_CLOSURE/);
    }
    for(const mutate of [tables=>{tables.authorization=tables.authorization.filter(name=>name!=='tenant_subject_admin_audit');},
      tables=>tables.authorization.push('foreign_owned_elsewhere'),tables=>tables.secrets.push('secret_records')]) {
      const tables=plan.resetTables();mutate(tables);assert.throws(()=>plan.resetPlan(layout,catalogues,tables),/RESET_TABLE_COVERAGE/);
    }
    const missingCounter=plan.resetTables();missingCounter.entries=missingCounter.entries.filter(name=>name!=='tenant_insertion_ordinal');
    assert.throws(()=>plan.resetPlan(layout,catalogues,missingCounter),/RESET_TABLE_COVERAGE/);
    const alteredOperation=structuredClone(catalogues), operation=alteredOperation.entries.migrations.at(-2);
    operation.up[1]='SET LOCAL row_security = on';operation.checksum=require('../lib/migrations/catalogue').checksum(operation.up);
    assert.throws(()=>plan.resetPlan(layout,alteredOperation),error=>error.code==='MIG_OPERATION_SQL','rehashed unknown typed SQL never becomes reset inventory');
    const changed=structuredClone(catalogues);changed.authorization.migrations[0].up.push('CREATE TABLE unknown_new_table (tenant_id uuid)');
    assert.throws(()=>plan.resetPlan(layout,changed),/RESET_TABLE_COVERAGE/,'new catalogue data table needs explicit review, never dynamic adoption');
    changed.authorization.migrations[0].up.push('ALTER TABLE unknown_new_table ADD FOREIGN KEY (tenant_id) REFERENCES foreign_schema.foreign_table (tenant_id)');
    assert.throws(()=>plan.resetPlan(layout,changed),/RESET_DDL_UNREVIEWED/);
  });

  it('actual private API boot checks the installed alarm catalogue with BOTH readiness and selected ACK identities (source protocol only)',async function(){
    const layout=plan.layout('0123456789abcdef'),grants=require('./fixtures/realtime-preview/bootstrap-grants').grants(layout);
    const quote=name=>'"'+name+'"',ledger=quote(layout.namespaces.alarm)+'."schema_migrations"';
    const expected='GRANT SELECT ON '+ledger+' TO '+quote(layout.roles.alarm);
    const admission=path.join(dir,'admission.json');fs.writeFileSync(admission,JSON.stringify({version:1,mode:'preview-socket-allowlist',tenants:[{id:plan.A,enabled:true,aliases:['one.example.test']}]}));
    const migrations=require('../lib/migrations/postgres'),original=migrations.run,boot=require('../lib/server/realtime/private-api').boot;
    const config={bindings:new Map([[plan.A,{}]]),readinessConnectionString:'synthetic-readiness',socketForwarding:{admissionFile:admission,maxTenants:1,
      alarm:{namespace:layout.namespaces.alarm,connectionString:'synthetic-ack-writer'}}};
    try {
      for(const selected of [grants,grants.filter(sql=>sql!==expected)]) {
        const calls=[],afterLedger=new Error('SOURCE_PROTOCOL_STOP_AFTER_LEDGER'),denied=Object.assign(new Error('synthetic denied ledger'),{code:'42501'});
        migrations.run=async(action,options)=>{
          calls.push({action,principal:options.connectionString,namespace:options.namespace});
          assert.equal(action,'check');assert.equal(options.catalogue,require('../migrations/candidates/postgres-alarm-suppression-v1.json'));
          const who=options.connectionString==='synthetic-readiness'?'readiness':'alarm';
          if(!selected.includes('GRANT SELECT ON '+ledger+' TO '+quote(layout.roles[who])))throw denied;
          if(calls.length===2)throw afterLedger; // no connection/listener beyond actual ledger boundary
        };
        await assert.rejects(boot({config}),error=>error===(selected===grants?afterLedger:denied));
        assert.deepEqual(calls,[{action:'check',principal:'synthetic-readiness',namespace:layout.namespaces.alarm},
          {action:'check',principal:'synthetic-ack-writer',namespace:layout.namespaces.alarm}]);
      }
      assert(grants.includes(expected),'BOOTSTRAP_SELECTED_ALARM_LEDGER_SELECT');
      assert.equal(grants.filter(sql=>sql.includes(ledger)&&sql.endsWith('TO '+quote(layout.roles.alarm))).length,1);
    } finally { migrations.run=original; }
  });

});
