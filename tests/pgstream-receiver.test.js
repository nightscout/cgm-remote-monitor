'use strict';
const assert=require('node:assert/strict');
const {create,parse}=require('../lib/pgstream/receiver');
const A='11111111-1111-4111-8111-111111111111';
const event=(table,values,action='U')=>({Data:{action,schema:'synthetic',table,columns:Object.entries(values).map(([name,value])=>({name,value})),identity:null}});
describe('pgstream explicit input/schema receiver',function(){
 const routes=[{schema:'synthetic',table:'clock',kind:'clock'},{schema:'synthetic',table:'activity',kind:'activity'},{schema:'synthetic',table:'lifecycle',kind:'lifecycle'}];
 let observe,inputs,schemas;
 beforeEach(()=>{observe=[];inputs=[];schemas=[];});
 const receiver=extra=>create({routes,store:{consumer:'evaluator-test-completed',observe:async(...args)=>{observe.push(args);}},onInput:async(...args)=>{inputs.push(args);},onSchema:async value=>{schemas.push(value);},...extra});
 it('does not acknowledge before observed work commits, and does not await clinical computation',async()=>{
   let commit;const durable=new Promise(resolve=>{commit=resolve;});let settled=false;
   const receive=receiver({store:{observe:()=>durable},onInput:()=>new Promise(()=>{})});
   const work=receive(event('clock',{tenant_id:A,last_stamp:'17'})).then(()=>{settled=true;});
   await Promise.resolve();assert.equal(settled,false);commit();await work;assert.equal(settled,true);
 });
 it('refuses failed durable receipt',async()=>{const receive=receiver({store:{observe:async()=>{throw Error('COMMIT_LOST');}}});await assert.rejects(receive(event('clock',{tenant_id:A,last_stamp:'18'})),/COMMIT_LOST/);assert.equal(inputs.length,0);});
 it('skips only completed replay hints after durable COMMIT and still recovers pending duplicates',async()=>{
   let receipt={observed:{clock:'17'},completed:{clock:'17'}},commit;
   const receive=receiver({store:{observe:()=>new Promise(resolve=>{commit=()=>resolve(receipt);})}});
   const done=receive(event('clock',{tenant_id:A,last_stamp:'17'}));await Promise.resolve();assert.equal(inputs.length,0);commit();await done;assert.equal(inputs.length,0,'COMPLETED_REPLAY_MUST_NOT_ACQUIRE');
   receipt={observed:{clock:'18'},completed:{clock:'17'}};
   const pending=receive(event('clock',{tenant_id:A,last_stamp:'17'}));await Promise.resolve();commit();await pending;assert.deepEqual(inputs,[[A,'clock']],'PENDING_DUPLICATE_MUST_RECOVER_MISSED_HINT');
   receipt={observed:{clock:'17',policy:'2'},completed:{clock:'17',policy:'1'}};
   const control=receive(event('clock',{tenant_id:A,last_stamp:'17'}));await Promise.resolve();commit();await control;assert.equal(inputs.length,2,'OTHER_PENDING_SOURCE_MUST_RECOVER');
 });
 it('refuses checkpoint rows because output scheduling never captures its own persistence',async()=>{await assert.rejects(receiver()(event('checkpoint',{tenant_id:A,consumer:'evaluator-test-completed'})),/UNROUTED/);assert.equal(inputs.length,0);assert.equal(observe.length,0);});
 it('routes actual pgstream.ddl action M to admission revalidation, with irrelevant DDL defined',async()=>{
   const receive=receiver(),message=schema=>({Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:schema,objects:[{schema,type:'table'}],ddl:'synthetic schema change'})}});
   assert.equal((await receive(message('synthetic'))).kind,'schema');assert.equal((await receive(message('unrelated'))).kind,'irrelevant-schema');assert.deepEqual(schemas,[['synthetic']]);assert.equal(observe.length,0);
 });
 it('revalidates clinical schemas without widening row routes or creating input work',async()=>{
   const receive=receiver({relevantSchemas:['clinical_rows']}),ddl=(schema,objects)=>({Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:schema,objects})}});
   assert.equal((await receive(ddl('',[{schema:'clinical_rows',type:'table'}]))).kind,'schema');
   assert.deepEqual(schemas,[['clinical_rows']]);assert.equal(observe.length,0);assert.equal(inputs.length,0);
   assert.equal((await receive(ddl('unrelated',[]))).kind,'irrelevant-schema');
   await assert.rejects(receive({Data:{action:'U',schema:'clinical_rows',table:'entries',columns:[],identity:null}}),/UNROUTED/);
 });
 it('does not acknowledge relevant DDL before admission revalidation succeeds',async()=>{
   let release;const held=new Promise(resolve=>{release=resolve;});let acknowledged=false;
   const receive=receiver({relevantSchemas:['clinical_rows'],onSchema:()=>held});
   const event={Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:'clinical_rows',objects:[]})}};
   const pending=receive(event).then(()=>{acknowledged=true;});await Promise.resolve();assert.equal(acknowledged,false);release();await pending;assert.equal(acknowledged,true);
   await assert.rejects(receiver({relevantSchemas:['clinical_rows'],onSchema:async()=>{throw Error('ADMISSION_REFUSED');}})(event),/ADMISSION_REFUSED/);
 });
 it('refuses unknown and malformed control events without clinical completion',async()=>{const receive=receiver();await assert.rejects(receive({Data:{action:'M',prefix:'unknown',content:'{}'}}),/CONTROL_UNKNOWN/);await assert.rejects(receive({Data:{action:'M',prefix:'pgstream.ddl',content:'{}'}}),/DDL_SHAPE/);await assert.rejects(receive(event('unknown',{})),/UNROUTED/);});
 it('orders lifecycle suspension and activation with the existing generation; keeps activity eligibility separate',async()=>{
   const receive=receiver();await receive(event('lifecycle',{tenant_id:A,generation:'7',phase:'active'}));await receive(event('lifecycle',{tenant_id:A,generation:'7',phase:'suspended'}));await receive(event('lifecycle',{tenant_id:A,generation:'8',phase:'active'}));await receive(event('activity',{tenant_id:A,version:'9',paused:true,suspended:false}));
   assert.deepEqual(observe.map(args=>args.slice(1)),[['lifecycle','14',true],['lifecycle','15',false],['lifecycle','16',true],['activity','9',false]]);
 });
 it('refuses numeric versions outside JavaScript exact integer range',async()=>{await assert.rejects(receiver()(event('clock',{tenant_id:A,last_stamp:9007199254740992})),/EVENT_VERSION/);});
 it('preserves raw bigint version lexemes without changing clinical JSON and refuses lifecycle overflow',async()=>{
   const raw=(table,name,value,extra=[])=>JSON.stringify(event(table,{tenant_id:A})).replace('"columns":[','"columns":[{"name":"'+name+'","type":"bigint","value":'+value+'},'+extra.map(value=>JSON.stringify(value)).join(',')+(extra.length?',':''));
   const receive=receiver();for(const exact of ['9007199254740993','9223372036854775807']){const text=raw('clock','last_stamp',exact);await assert.rejects(receive(JSON.parse(text)),/EVENT_VERSION/);await receive(parse(text));assert.equal(observe[observe.length-1][2],exact);}
   const clinical=parse('{"Data":{"columns":[{"name":"projection","type":"jsonb","value":{"name":"generation","type":"bigint","value":9007199254740993}}]}}');assert.equal(typeof clinical.Data.columns[0].value.value,'number');
   const nested=parse('{"Data":{"columns":[{"name":"projection","type":"jsonb","value":{"generation":9007199254740993}}]}}');assert.equal(typeof nested.Data.columns[0].value.generation,'number');
   await receive(parse(raw('lifecycle','generation','4611686018427387903',[{name:'phase',value:'suspended'}])));assert.equal(observe[observe.length-1][2],'9223372036854775807');await assert.rejects(receive(parse(raw('lifecycle','generation','4611686018427387904',[{name:'phase',value:'active'}]))),/EVENT_VERSION/);
 });
 it('passes committed pending age to clinical ownership without observing output rows',async()=>{const receive=receiver({store:{consumer:'evaluator-test-completed',observe:async()=>({pendingAt:123})}});await receive(event('clock',{tenant_id:A,last_stamp:'1'}));assert.deepEqual(inputs,[[A,'clock',123]]);await assert.rejects(receive(event('checkpoint',{tenant_id:A,consumer:'evaluator-test-completed',work_version:2,delivery_revision:'3',delivery_ack_revision:'2'})),/UNROUTED/);});
 it('control: removing the durable await acknowledges before commit; the receipt criterion goes red',async()=>{
   const file=require.resolve('../lib/pgstream/receiver'),fs=require('node:fs'),vm=require('node:vm'),original=fs.readFileSync(file,'utf8');
   const broken=original.replace('await store.observe(', 'store.observe(');assert.notEqual(broken,original);
   const output={exports:{}};vm.runInThisContext('(function(require,module,exports){'+broken+'\n})',{filename:file})(require,output,output.exports);
   let commit;const held=new Promise(resolve=>{commit=resolve;});let committed=false;
   const receive=output.exports.create({routes,store:{observe:()=>held.then(()=>{committed=true;})},onInput:()=>{},onOutput:()=>{},onHeartbeat:()=>{},onSchema:()=>{}});
   await receive(event('clock',{tenant_id:A,last_stamp:'1'}));assert.throws(()=>assert.equal(committed,true),{code:'ERR_ASSERTION'});commit();await held;
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


describe('selected receiver exact recognized profile',()=>{
 it('refuses malformed/unknown profiles and wrong receipt digest, consumer or lifecycle namespace before input',()=>{
  const profiles=require('../lib/pgstream/intake-profile'),f=require('./fixtures/intake-source-protocol'),p=profiles.create(f.options);
  const selected={routes:[{schema:p.binding.lifecycleNamespace,table:'tenant_lifecycle_windows',kind:'lifecycle'}],store:{profile:p.digest,consumer:p.binding.consumer+'-completed'},intakeProfile:p,onInput:()=>{},onHeartbeat:()=>{},onSchema:()=>{}};
  assert.doesNotThrow(()=>create(selected));
  for(const store of [{...selected.store,profile:undefined},{...selected.store,profile:'0'.repeat(64)},{...selected.store,consumer:'evaluator-other-completed'}])assert.throws(()=>create({...selected,store}),/PROFILE_BINDING/);
  assert.throws(()=>create({...selected,routes:[{schema:'wrong_control',table:'tenant_lifecycle_windows',kind:'lifecycle'}]}),/PROFILE_BINDING/);
  assert.throws(()=>create({...selected,intakeProfile:{...p,binding:{...p.binding,codec:'research'}}}),/PROFILE/);
 });
 it('actual evaluator factory refuses cross-layout and cross-consumer selected profiles before opening a receipt store',async()=>{
  const profiles=require('../lib/pgstream/intake-profile'),f=require('./fixtures/intake-source-protocol'),p=profiles.create(f.options),config={pgstream:{binary:'/does-not-exist'},namespaces:{checkpoint:p.binding.namespace},consumer:p.binding.consumer,trustedWorker:{activity:p.binding.lifecycleNamespace,settings:'settings',operatorPolicy:'policy'}};
  config.namespaces.clock='clock';
  for(const change of [{consumer:'evaluator-other'},{namespaces:{...config.namespaces,checkpoint:'wrong_work'}},{trustedWorker:{...config.trustedWorker,activity:'wrong_control'}}])await assert.rejects(require('../lib/pgstream/evaluator').open({config:{...config,...change},intakeProfile:p,controlConnection:{}}),/EVALUATOR_INTAKE_PROFILE_BINDING/);
 });
});

// Optional selected topology cannot silently re-enable the superseded snapshot
// adapter. Its ownership/profile modules retain independent source controls.
describe('maintained evaluator entrypoint materializer selection',()=>{
 it('refuses selected topology before acquiring any role resources',async()=>{
  await assert.rejects(require('../lib/server/serve/evaluator-preview').boot({selectedIntake:{}},{}),/PGSTREAM_SELECTED_MATERIALIZER_UNQUALIFIED/);
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
