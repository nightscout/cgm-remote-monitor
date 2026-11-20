'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const fixture=require('./fixtures/realtime-preview/bootstrap');
const plan=fixture.plan;
const sourceDir=path.resolve(__dirname,'..');
function bounds(){return {timeoutMs:1000,recoveryIntervalMs:100,timeIntervalMs:100,pollIntervalMs:100,retryIntervalMs:100,retryDelayMs:10,
  attemptTimeoutMs:2000,maxRows:100,maxBytes:100000,pageSize:10,maxMessageBytes:30000,maxPayloadBytes:10000,maxConnections:2,maxInflight:2,
  snoozeMs:1000,settleMs:100,observationMs:100,credentialLifetimeSeconds:3600};}
describe('parent-owned realtime bootstrap source contract',function(){
  let dir,input;
  beforeEach(function(){dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-b-'));fs.chmodSync(dir,0o700);
    const pins=require('./fixtures/realtime-preview/early').plan.pins;
    const resource=(kind,port,database)=>({kind,host:'127.0.0.1',port,database,containerId:'synthetic-owned-'+kind,image:pins[kind],labelKey:'synthetic-owner',labelValue:'synthetic-phase',mounts:[]});
    input={sourceDir,captureDir:dir,onObservation(){},env:{NS_RT_BOOTSTRAP_PGSTREAM_RECEIVER_PORT:'21461',NS_RT_BOOTSTRAP_PGSTREAM_SUBSCRIPTIONS_PORT:'21462',NS_TEST_POSTGRES_ADMIN_URI:'postgres://synthetic-admin:synthetic@127.0.0.1:15432/bootstrap_test',
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
  it('grants only reader activity access to both the shared API and dedicated activity identities, with omission control',function(){
    const layout=plan.layout('0123456789abcdef'),module=require('./fixtures/realtime-preview/bootstrap-grants');
    const criterion=grants=>{
      const statements=grants.grants(layout);
      for(const who of ['api','activity_reader']){
        const role=' TO "'+layout.roles[who]+'"',schema='"'+layout.namespaces.control+'"';
        for(const sql of ['GRANT USAGE ON SCHEMA '+schema+role,'GRANT SELECT ON '+schema+'.schema_migrations'+role,'GRANT SELECT ON '+schema+'.tenant_activity'+role])assert(statements.includes(sql),'ACTUAL_ACTIVITY_READER_GRANT_REQUIRED: '+sql);
        assert.equal(statements.some(sql=>sql.endsWith(role)&&sql.includes(schema+'.tenant_activity')&&!sql.startsWith('GRANT SELECT ON ')),false,'ACTIVITY_READER_MUST_NOT_GAIN_WRITE_OR_OWNER_GRANTS');
      }
    };
    criterion(module);
    const broken=require('./lib/clinical-working-set/control')('./fixtures/realtime-preview/bootstrap-grants',"for(const who of ['api','activity_reader'])","for(const who of ['activity_reader'])");
    assert.throws(()=>criterion(broken),/ACTUAL_ACTIVITY_READER_GRANT_REQUIRED/);
    criterion(module);
  });
  it('feeds actual API RT and evaluator parsers with one metadata-linked config and no worker credentials in API',function(){
    const selected=plan.parse(input),layout=plan.layout('0123456789abcdef'),paths=Object.fromEntries(['api','realtime','evaluator','tenant-admin'].map(n=>[n,path.join(dir,n+'.json')]));
    const publicKeys=[plan.A,plan.B].map(tenant=>({tenant,kid:'key1',publicKey:Buffer.from(crypto.generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,'base64url').toString('base64')}));
    const docs=plan.documents({selected,layout,publicKeys,paths});for(const name of ['api','realtime','evaluator','tenant-admin'])fs.writeFileSync(paths[name],JSON.stringify(docs[name]));
    const url=name=>'postgres://synthetic-'+name+':synthetic@127.0.0.1:15432/bootstrap_test';
    const common={NS_API_INTERNAL_SOCKET:path.join(dir,'api.sock'),NS_REALTIME_INTERNAL_SOCKET:path.join(dir,'alarm.sock'),NS_EVALUATOR_INTERNAL_SOCKET:path.join(dir,'evaluator.sock'),NS_TENANT_ADMIN_INTERNAL_SOCKET:path.join(dir,'owner.sock'),RT_BOOTSTRAP_DISPLAY_PG:'postgres://synthetic-display:synthetic@127.0.0.1:15432/bootstrap_test',RT_BOOTSTRAP_ACTIVITY_PG:'postgres://synthetic-activity:synthetic@127.0.0.1:15432/bootstrap_test',NS_RT_BOOTSTRAP_PGSTREAM_BINARY:'/synthetic/pinned-pgstream',NS_RT_BOOTSTRAP_PGSTREAM_CONFIG:'/synthetic/pgstream.json'};
    const api={...common,NS_SERVE_INTERNAL_SOCKET:common.NS_API_INTERNAL_SOCKET,RT_BOOTSTRAP_API_PG:url('api'),
      RT_BOOTSTRAP_READINESS_PG:url('readiness'),RT_BOOTSTRAP_ALARM_PG:url('alarm'),RT_BOOTSTRAP_VAULT_ROLE:'synthetic-role',...require('./fixtures/signing-secret').env()};
    const worker={...common,NS_SERVE_INTERNAL_SOCKET:common.NS_EVALUATOR_INTERNAL_SOCKET,RT_BOOTSTRAP_EVAL_PG:url('evaluator'),RT_BOOTSTRAP_OUTBOX_PG:url('outbox'),RT_BOOTSTRAP_SUPPRESSION_PG:url('suppression'),[docs.evaluator.pgstream.recovery.connectionEnv]:(()=>{const u=new URL(url('evaluator'));u.username=docs.evaluator.pgstream.streamRole;return u.href;})()};
    const realtime={...common,NS_SERVE_INTERNAL_SOCKET:common.NS_REALTIME_INTERNAL_SOCKET,RT_BOOTSTRAP_RT_PG:url('realtime')};
    // The lab's documents through each role's own validator (parse); roles read their
    // configuration from the environment (lib/server/serve/deployment-settings.js).
    const previewConfig=require('../lib/server/serve/preview-config'),evaluatorConfig=require('../lib/server/serve/evaluator-config');
    const accepted=previewConfig.parse(docs.api,api);
    assert.deepEqual(docs.api.activity,{namespace:layout.namespaces.control},'API_ACTIVITY_USES_SHARED_SERVING_CONNECTION');
    assert.deepEqual(accepted.activity,docs.api.activity);
    assert.throws(()=>previewConfig.parse({...docs.api,activity:{...docs.api.activity,connectionEnv:'RT_BOOTSTRAP_ACTIVITY_PG'}},api),/invalid preview configuration fields/,'OBSOLETE_API_ACTIVITY_CONNECTION_REFUSED');
    assert.deepEqual(previewConfig.parse(docs.api,api).activity,accepted.activity,'RESTORED_SHARED_ACTIVITY_PARSER');
    const evaluated=evaluatorConfig.parse(docs.evaluator,worker);
    const delivered=require('../lib/server/realtime/config').parse(docs.realtime,realtime);
    assert.equal(delivered.registry.namespace,evaluated.registry.namespace,'BOOTSTRAP_SHARED_REGISTRY');
    assert.equal(delivered.completedOutput.namespace,evaluated.namespaces.checkpoint,'BOOTSTRAP_ACTUAL_COMPLETED_SOURCE');
    assert.equal(delivered.completedOutput.consumer,evaluated.consumer);
    assert.deepEqual(Object.keys(delivered.namespaces).sort(),['checkpoint','clock']);
    assert.equal(evaluated.tenants.size,0,'registry parser does not fabricate tenant work');
    const recoveryReference=docs.evaluator.pgstream.recovery.connectionEnv;
    assert.equal(evaluated.pgstream.recovery.connectionString,worker[recoveryReference],'EVALUATOR_RESOLVES_DECLARED_RECOVERY_IDENTITY');
    assert.equal(evaluated.pgstream.transactionRows,10000,'TRANSPORT_ROWS_INDEPENDENT_OF_CLINICAL_CACHE');
    for(const changed of [undefined,url('evaluator'),(()=>{const u=new URL(worker[recoveryReference]);u.port='15433';return u.href;})()]){
      assert.throws(()=>evaluatorConfig.parse(docs.evaluator,{...worker,[recoveryReference]:changed}),/invalid explicit evaluator preview configuration/,'RECOVERY_REQUIRES_EXACT_ROLE_AND_ENDPOINT');
    }
    for(const key of ['changeFeed','recoveryIntervalMs','settingsRefreshMs','tenants'])assert.equal(Object.hasOwn(docs.evaluator,key),false);
    assert.notEqual(evaluated.namespaces.checkpoint,delivered.namespaces.checkpoint);
    assert.equal(Object.keys(api).some(key=>/EVAL_PG|OUTBOX_PG|SUPPRESSION_PG|STREAM_RECOVERY_PG/.test(key)),false,'BOOTSTRAP_API_NO_WORKER_CREDENTIALS');
    assert.equal(Object.keys(realtime).some(key=>/VAULT|SIGN|DECRYPT|SECRET/.test(key)),false);
    assert.deepEqual(Object.keys(require('./fixtures/realtime-preview/bootstrap-grants').catalogues()).sort(),Object.keys(layout.namespaces).sort());
    const ownerSource={...common,NS_SERVE_INTERNAL_SOCKET:common.NS_TENANT_ADMIN_INTERNAL_SOCKET,NS_OWNER_CREDENTIALS_PG:url('owner-credentials'),NS_OWNER_WRITER_PG:url('owner-writer'),NS_OWNER_READER_PG:url('owner-reader')};
    require('../lib/server/serve/owner-preview-config').parse(docs['tenant-admin'],ownerSource);

  });
  it('keeps the initial explicit cold evaluator bound below realtime while both actual role configuration parsers accept it and infrastructure stays pinned',async function(){
    const options={...bounds(),pageSize:1,evaluatorMaxRows:3,realtimeMaxRows:100};
    const selected=plan.parse({...input,env:{...input.env,NS_RT_BOOTSTRAP_OPTIONS_JSON:JSON.stringify(options)}});
    assert.equal(plan.parse(input).options.evaluatorMaxRows,options.maxRows);
    assert.equal(plan.parse(input).options.realtimeMaxRows,options.maxRows);
    const layout=plan.layout('0123456789abcdef'),paths=Object.fromEntries(['api','realtime','evaluator','tenant-admin'].map(n=>[n,path.join(dir,n+'.json')]));
    const docs=plan.documents({selected,layout,publicKeys:[],paths});fs.writeFileSync(paths.evaluator,JSON.stringify(docs.evaluator));
    const url=name=>'postgres://synthetic-'+name+':synthetic@127.0.0.1:15432/bootstrap_test';
    const env={RT_BOOTSTRAP_EVAL_PG:url('evaluator'),RT_BOOTSTRAP_OUTBOX_PG:url('outbox'),RT_BOOTSTRAP_SUPPRESSION_PG:url('suppression'),
      [docs.evaluator.pgstream.recovery.connectionEnv]:(()=>{const u=new URL(url('evaluator'));u.username=docs.evaluator.pgstream.streamRole;return u.href;})(),RT_BOOTSTRAP_RT_PG:url('realtime'),NS_API_INTERNAL_SOCKET:path.join(dir,'api.sock'),NS_REALTIME_INTERNAL_SOCKET:path.join(dir,'alarm.sock'),NS_EVALUATOR_INTERNAL_SOCKET:path.join(dir,'evaluator.sock'),NS_TENANT_ADMIN_INTERNAL_SOCKET:path.join(dir,'owner.sock'),RT_BOOTSTRAP_DISPLAY_PG:'postgres://synthetic-display:synthetic@127.0.0.1:15432/bootstrap_test',RT_BOOTSTRAP_ACTIVITY_PG:'postgres://synthetic-activity:synthetic@127.0.0.1:15432/bootstrap_test',NS_RT_BOOTSTRAP_PGSTREAM_BINARY:'/synthetic/pinned-pgstream',NS_RT_BOOTSTRAP_PGSTREAM_CONFIG:'/synthetic/pgstream.json'};
    const evaluated=require('../lib/server/serve/evaluator-config').parse(docs.evaluator,{...env,NS_SERVE_INTERNAL_SOCKET:env.NS_EVALUATOR_INTERNAL_SOCKET});
    const delivered=require('../lib/server/realtime/config').parse(docs.realtime,{...env,NS_SERVE_INTERNAL_SOCKET:env.NS_REALTIME_INTERNAL_SOCKET});
    assert.equal(evaluated.maxRows,3,'BOOTSTRAP_COLD_EVALUATOR_BOUND');assert.equal(delivered.maxRows,100,'BOOTSTRAP_REALTIME_REMAINS_ADMITTED');
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
  // The socket ns-access+jwt status-credential check is retired with that verifier
  // (decision deployment-signing-secret); the native bootstrap's credential port is
  // recorded in the KEYS2 handoff.

  it('preflights the explicit owned reset against every actual selected catalogue table and FK edge',function(){
    const catalogues=require('./fixtures/realtime-preview/bootstrap-grants').catalogues(),layout=plan.layout('0123456789abcdef');
    const reset=plan.resetPlan(layout,catalogues);
    for(const table of ['tenant_owner_policy','tenant_owner_actors','tenant_subject_admin_audit'])assert(reset.reset.some(row=>row.domain==='authorization'&&row.table===table),'RESET_INCLUDES_'+table);
    assert(reset.reset.some(row=>row.domain==='secrets'&&row.table==='secret_audit'));
    assert.deepEqual(reset.preserved,[{domain:'secrets',namespace:layout.namespaces.secrets,table:'secret_records'}]);
    // The local-data signer migration adds one child table and one FK edge;
    // the registry change stamps add one table.
    assert.equal(reset.reset.length,56);assert.equal(reset.foreignKeys.length,25);
    assert.deepEqual(reset.reset.filter(row=>row.domain==='legacy').map(row=>row.table),['legacy_data_keys','legacy_credential_subjects','legacy_credential_config']);
    assert(reset.reset.some(row=>row.domain==='registry'&&row.table==='tenant_registry_keys'));
    assert(reset.reset.some(row=>row.domain==='control'&&row.table==='tenant_lifecycle_key_retention'));
    assert(reset.reset.some(row=>row.domain==='access'&&row.table==='management_session_requests'));
    assert.deepEqual(reset.reset.filter(row=>row.table==='tenant_insertion_ordinal').map(row=>row.domain).sort(), ['devicestatus','entries','food','profile','treatments']);
    assert(reset.foreignKeys.some(row=>row.from==='tenant_owner_actors'&&row.to==='tenant_owner_policy'));
    assert(reset.foreignKeys.some(row=>row.from==='tenant_owner_policy'&&row.to==='tenant_authorization_config'));
    assert(reset.reset.every(row=>row.namespace===layout.namespaces[row.domain]&&row.table!=='schema_migrations'));
  });
  it('accepts compact PostgreSQL foreign-key syntax while preserving exact reset closure', function () {
    const catalogues=require('./fixtures/realtime-preview/bootstrap-grants').catalogues(),layout=plan.layout('0123456789abcdef');
    const compact=structuredClone(catalogues);
    for(const catalogue of Object.values(compact))for(const migration of catalogue.migrations) {
      if(migration.up)migration.up=migration.up.map(sql=>sql.replace(/REFERENCES ([a-z][a-z0-9_]*)\s*\(/g,'REFERENCES $1('));
    }
    assert.deepEqual(plan.resetPlan(layout,compact).foreignKeys,plan.resetPlan(layout,catalogues).foreignKeys);
    const omitted=plan.resetTables();omitted.access=omitted.access.filter(name=>name!=='management_session_requests');
    assert.throws(()=>plan.resetPlan(layout,compact,omitted),/RESET_FK_CLOSURE/);
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
    const missingKeys=plan.resetTables();missingKeys.legacy=missingKeys.legacy.filter(name=>name!=='legacy_data_keys');
    assert.throws(()=>plan.resetPlan(layout,catalogues,missingKeys),/RESET_FK_CLOSURE/,'the old pre-signer inventory must refuse before SQL');
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
    const migrations=require('../lib/migrations/postgres'),original=migrations.run,boot=require('../lib/server/realtime/private-api').boot;
    const config={registry:{namespace:layout.namespaces.registry},resolver:{resolve:async()=>plan.A},prepareRegistryTenant:async()=>({}),readinessConnectionString:'synthetic-readiness',socketForwarding:{maxTenants:1,
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
