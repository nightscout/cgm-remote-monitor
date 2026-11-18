'use strict';
const assert=require('node:assert/strict');
const {create,parse}=require('../lib/pgstream/receiver');
const A='11111111-1111-4111-8111-111111111111';
const event=(table,values,action='U')=>({Data:{action,schema:'synthetic',table,columns:Object.entries(values).map(([name,value])=>({name,value})),identity:null}});
describe('pgstream standalone schema control',()=>{
 const receiver=onSchema=>create({routes:[],relevantSchemas:['synthetic'],store:{},onInput:()=>{},onSchema});
 const ddl=schema=>({Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:schema,objects:[]})}});
 it('keeps standalone DDL admission bounded and awaits its actual revalidation',async()=>{
  let release,done=false;const receive=receiver(()=>new Promise(resolve=>{release=resolve;}));
  const pending=receive(ddl('synthetic')).then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);release();await pending;assert.equal(done,true);
  assert.equal((await receive(ddl('foreign'))).kind,'irrelevant-schema');
  await assert.rejects(receiver(async()=>{throw Error('ADMISSION_REFUSED');})(ddl('synthetic')),/ADMISSION_REFUSED/);
 });
 it('refuses every unframed data/control row, including the retired clock seal',async()=>{
  const receive=receiver(()=>{});for(const table of ['clock','activity','lifecycle','entries','checkpoint'])await assert.rejects(receive(event(table,{tenant_id:A,version:'1'})),/COMPLETE_TRANSACTION_REQUIRED/);
  await assert.rejects(receive({Data:{action:'M',prefix:'unknown',content:'{}'}}),/CONTROL_UNKNOWN/);
 });
});

// Semantic change: actual clinical rows now feed the evaluator; output rows stay excluded.
describe('pgstream deployment routes',function(){it('captures six clinical domains plus the existing control routes',function(){const routes=require('../lib/pgstream/evaluator').routes({namespaces:{...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(d=>[d,'test_'+d])),clock:'test_clock',checkpoint:'test_checkpoint'},trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'}});assert.equal(routes.length,10);assert.equal(routes.filter(r=>r.kind==='clinical').length,6);assert(!routes.some(row=>['clock','heartbeat'].includes(row.kind)),'NO_INTERNAL_CLOCK_SEAL_ROUTE');assert(!routes.some(row=>row.table==='tenant_consumer_checkpoint'),'NO_CHECKPOINT_SELFCAPTURE');});});


describe('consumer catalogue DDL relevance', function () {
 it('revalidates only configured consumer schemas without adding DML routes; omission is red and restoration green', async function () {
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('../lib/pgstream/evaluator'),local=createRequire(file),actual=require(file);
  const config={namespaces:{...Object.fromEntries(require('../lib/storage/clinical-stream-state').DOMAINS.map(d=>[d,'clinical_'+d])),clock:'clinical_clock',checkpoint:'clinical_checkpoint'},registry:{namespace:'tenant_registry'},
   trustedWorker:{settings:'display_settings',operatorPolicy:'operator_policy',activity:'tenant_control'},
   consumers:{realtime:{outbox:{namespace:'consumer_outbox'},suppression:{namespace:'consumer_alarm'}}}};
  async function qualify(module){
   const seen=[],routes=module.routes(config);
   assert.equal(routes.length,10);assert.equal(routes.filter(r=>r.kind==='clinical').length,6);assert(!routes.some(row=>['consumer_outbox','consumer_alarm'].includes(row.schema)));
   const receive=create({routes,relevantSchemas:module.relevantSchemas(config),store:{},onInput:()=>{},onHeartbeat:()=>{},onSchema:async schemas=>seen.push(...schemas)});
   for(const schema of ['consumer_outbox','consumer_alarm','unrelated_schema'])await receive({Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:schema,objects:[]})}});
   assert.deepEqual(seen,['consumer_outbox','consumer_alarm']);
  }
  await qualify(actual);
  const source=fs.readFileSync(file,'utf8'),needle='...(selected?[selected.outbox.namespace,selected.suppression.namespace]:[])';
  assert.equal(source.split(needle).length,2,'control must remove actual consumer DDL selection');
  const broken={exports:{}};
  vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'...[]')+'\n})',{filename:file})(local,broken,broken.exports);
  await assert.rejects(qualify(broken.exports),error=>error.code==='ERR_ASSERTION');
  await qualify(actual);
 });
});


// Native complete-cohort controls replace the retired row-stage/clock-seal
// composition. HTTP completion follows one durable cohort COMMIT.
describe('native complete-cohort receiver composition',function(){
 const native=require('./lib/clinical-stream-native');
 const clinicalRoute={schema:'synthetic_entries',table:'entries',kind:'clinical',domain:'entries'};
 function cohortFixture(acceptTransaction){
  const hints=[];
  const receive=create({routes:[clinicalRoute,{schema:'synthetic_settings',table:'tenant_settings',kind:'settings'}],store:{consumer:'evaluator-synthetic-completed'},onInput:(...args)=>hints.push(args),onSchema:async()=>{},
   clinical:{maxTransactionRows:100,maxTransactionBytes:100000,acceptTransaction}});
  return {receive,hints};
 }
 it('keeps the eligibility of the largest native lifecycle receipt within each cohort',async()=>{
  const selection=require('../lib/tenant-lifecycle/native-selection').create({namespace:'synthetic_checkpoint',lifecycleNamespace:'synthetic',consumer:'evaluator-receipt',source:native.source,generation:'fixture'});
  const route={schema:'synthetic',table:'tenant_lifecycle_windows',kind:'lifecycle'};
  let observation;
  const options={routes:[route],store:{nativeLifecycle:selection,consumer:'evaluator-receipt-completed',digest:selection.contractDigest},onInput(){},onSchema(){},
   clinical:{maxTransactionRows:10,maxTransactionBytes:10000,async acceptTransaction(_envelope,{observations}){[observation]=observations;return [];}}};
  const receive=create(options);
  const row=(phase,generation)=>({...event(route.table,{tenant_id:A,phase,generation}).Data,xid:42,lsn:'0/20'});
  await receive(native.envelope([row('active','2'),row('suspended','2')]));
  assert.equal(observation.observed.lifecycle,'6');assert.equal(observation.eligibility.lifecycle,true);
  await receive(native.envelope([row('suspended','3'),row('active','2')]));
  assert.equal(observation.observed.lifecycle,'7');assert.equal(observation.eligibility.lifecycle,false);
  await assert.rejects(receive(native.envelope([row('active','4611686018427387903')])),/GENERATION_DOMAIN/);
  assert.throws(()=>create({...options,routes:[{...route,schema:'foreign_scope'}]}),/NATIVE_RECEIPT_BINDING/);
 });
 it('does not return or wake until the entire clinical/control cohort commits',async()=>{
  let release,accepted,done=false;
  const f=cohortFixture(async(envelope,options)=>{accepted=options;await new Promise(resolve=>{release=resolve;});return [{tenant:A,observed:{bootstrap:'11',settings:'4'},completed:{bootstrap:'10',settings:'3'},pendingAt:123}];});
  const settings={action:'U',xid:42,lsn:'0/21',schema:'synthetic_settings',table:'tenant_settings',columns:[{name:'tenant_id',value:A},{name:'version',value:'4'}]};
  const pending=f.receive(native.envelope([native.row('a'),settings])).then(()=>{done=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.equal(f.hints.length,0);assert.equal(accepted.observations[0].observed.settings,'4');assert.equal(accepted.routes.length,1);
  release();await pending;assert.equal(done,true);assert.deepEqual(f.hints,[[A,'bootstrap',123]]);
 });
 it('refuses partial or unframed clinical input before durable acceptance',async()=>{
  let effects=0;const f=cohortFixture(async()=>{effects++;return [];});
  const incomplete=native.envelope([native.row('a')]);incomplete.Transaction.pop();await assert.rejects(f.receive(incomplete),/TRANSACTION_BOUNDARY/);
  await assert.rejects(f.receive({Data:native.row('a')}),/COMPLETE_TRANSACTION_REQUIRED/);assert.equal(effects,0);assert.equal(f.hints.length,0);
 });
 it('recovers pending duplicate wakes after a lost COMMIT reply without waking completed replay',async()=>{
  let attempt=0;const f=cohortFixture(async()=>{if(++attempt===1)throw Error('COMMIT_REPLY_LOST');return [{tenant:A,observed:{bootstrap:'11'},completed:{bootstrap:attempt===2?'10':'11'},pendingAt:123,deliveryPending:true,rawDeliveryPending:false}];});
  const event=native.envelope([native.row('a')]);await assert.rejects(f.receive(event),/COMMIT_REPLY_LOST/);assert.equal(f.hints.length,0);await f.receive(event);assert.equal(f.hints.length,1);await f.receive(event);assert.equal(f.hints.length,1);
 });
 it('refuses old-generation WAL but immediately addresses recovery before the later lifecycle event',async()=>{
  const f=cohortFixture(async()=>{throw Error('CLINICAL_STREAM_SOURCE_FENCE');});
  await assert.rejects(f.receive(native.envelope([native.row('old-generation')])),/SOURCE_FENCE/);
  assert.deepEqual(f.hints,[[A,'recovery']],'OLD_WAL_MUST_NOT_WAIT_FOR_LATER_LIFECYCLE_WAKE');
 });
 it('preserves exact bigint control lexemes inside a native envelope',async()=>{
  const envelope=native.envelope([{...native.row('control'),schema:'synthetic_settings',table:'tenant_settings',columns:[{name:'tenant_id',value:A},{name:'version',type:'int8',value:'9223372036854775807'}]}]);
  const text=JSON.stringify(envelope).replace('"value":"9223372036854775807"','"value":9223372036854775807');let observed;
  const f=cohortFixture(async(_event,options)=>{observed=options.observations;return [];});await f.receive(parse(text));assert.equal(observed[0].observed.settings,'9223372036854775807');
 });
});


describe('explicit native transport configuration',function(){
 it('requires source identity fields and separates clinical cache size from an explicit transaction limit',function(){
  const parse=require('../lib/pgstream/config').parse;
  const config={slot:'synthetic_slot',streamRole:'synthetic_stream',bounds:{stepMs:1000,recoveryMs:2000,pendingMs:3000},receiver:{url:'http://127.0.0.1:23456/',trust:'network',bindHost:'127.0.0.1',maxBytes:4096,timeoutMs:1000},generation:'a'.repeat(32),recovery:{connectionEnv:'SYNTHETIC_RECOVERY',timeoutMs:1000,maxQueued:1},transactionRows:128};
  assert.equal(parse(config).transactionRows,128);
  for(const field of ['slot','streamRole','transactionRows']){const missing={...config};delete missing[field];assert.throws(()=>parse(missing));}
  for(const transactionRows of [0,-1,1.5,1000001,'128'])assert.throws(()=>parse({...config,transactionRows}));
 });
});

describe('native control integer parsing',()=>{
 it('retains exact operational bigint lexemes and leaves clinical JSON alone',()=>{
  const native=require('./lib/clinical-stream-native');
  const row={action:'U',xid:42,lsn:'0/21',schema:'synthetic_settings',table:'tenant_settings',columns:[{name:'tenant_id',value:A},{name:'version',type:'bigint',value:'RAW'}]};
  const text=JSON.stringify(native.envelope([row])).replace('"RAW"','9007199254740993');
  const exact=parse(text);assert.equal(exact.Transaction[1].columns[1].value,'9007199254740993');
  const nested=parse('{"Data":{"columns":[{"name":"projection","type":"jsonb","value":{"generation":9007199254740993}}]}}');assert.equal(typeof nested.Data.columns[0].value.generation,'number');
 });
});
