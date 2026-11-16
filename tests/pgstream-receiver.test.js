'use strict';
const assert=require('node:assert/strict');
const {create,parse}=require('../lib/pgstream/receiver');
const A='11111111-1111-4111-8111-111111111111';
const event=(table,values,action='U')=>({Data:{action,schema:'synthetic',table,columns:Object.entries(values).map(([name,value])=>({name,value})),identity:null}});
describe('pgstream explicit input/schema receiver',function(){
 const routes=[{schema:'synthetic',table:'clock',kind:'clock'},{schema:'synthetic',table:'activity',kind:'activity'},{schema:'synthetic',table:'lifecycle',kind:'lifecycle'},{schema:'synthetic',table:'heartbeat',kind:'heartbeat'}];
 let observe,inputs,schemas,heartbeats;
 beforeEach(()=>{observe=[];inputs=[];schemas=[];heartbeats=[];});
 const receiver=extra=>create({routes,store:{consumer:'evaluator-test-completed',observe:async(...args)=>{observe.push(args);}},onInput:async(...args)=>{inputs.push(args);},onSchema:async value=>{schemas.push(value);},onHeartbeat:async value=>{heartbeats.push(value);},...extra});
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
 it('heartbeat is fixed worker health work and creates no tenant completion',async()=>{await receiver()(event('heartbeat',{id:1,revision:'19'}));assert.deepEqual(heartbeats,[19]);assert.equal(observe.length,0);});
 it('accepts the DBA bootstrap heartbeat at zero without treating it as live delivery',async()=>{await receiver({onHeartbeat:async revision=>assert(revision>0,'bootstrap zero must not acknowledge current liveness')})(event('heartbeat',{id:1,revision:'0'}));});
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

describe('pgstream deployment routes',function(){it('puts the heartbeat outside the upstream internal schema',function(){const routes=require('../lib/pgstream/evaluator').routes({namespaces:{clock:'test_clock',checkpoint:'test_checkpoint'},trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'}});assert.equal(routes.find(row=>row.kind==='heartbeat').schema,'test_clock');assert(!routes.some(row=>row.table==='tenant_consumer_checkpoint'),'NO_CHECKPOINT_SELFCAPTURE');});});


describe('consumer catalogue DDL relevance', function () {
 it('revalidates only configured consumer schemas without adding DML routes; omission is red and restoration green', async function () {
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('../lib/pgstream/evaluator'),local=createRequire(file),actual=require(file);
  const config={namespaces:{clock:'clinical_clock',checkpoint:'clinical_checkpoint'},registry:{namespace:'tenant_registry'},
   trustedWorker:{settings:'display_settings',operatorPolicy:'operator_policy',activity:'tenant_control'},
   consumers:{realtime:{outbox:{namespace:'consumer_outbox'},suppression:{namespace:'consumer_alarm'}}}};
  async function qualify(module){
   const seen=[],routes=module.routes(config);
   assert.equal(routes.length,6);assert(!routes.some(row=>['consumer_outbox','consumer_alarm'].includes(row.schema)));
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

describe('selected feed source construction without starting a listener or child',()=>{
 function protocol({selected=true,change=source=>source}={}){
  const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../lib/pgstream/evaluator'),actual=require(file),profiles=require('../lib/pgstream/intake-profile'),f=require('./fixtures/intake-source-protocol'),p=profiles.create(f.options),calls=[];
  const config={pgstream:{receiver:{url:'http://127.0.0.1:2345/',bindHost:'127.0.0.1',trust:'network',maxBytes:20000,timeoutMs:1000},streamRole:'stream_reader',slot:'test_slot',bounds:{stallMs:1000}},connectionString:'postgresql://stream_reader:synthetic@127.0.0.1/disposable_test',namespaces:{checkpoint:p.binding.namespace,clock:'input_clock'},consumer:p.binding.consumer,trustedWorker:{activity:p.binding.lifecycleNamespace,settings:'input_settings',operatorPolicy:'input_policy'},tenants:new Map(p.binding.tenants.map(id=>[id,{}])),maxBytes:10000,timeIntervalMs:1000,intakeStateSync:{assignmentRevision:p.binding.revision},selectedIntake:{controlConnectionString:'postgresql://feed_control:synthetic@127.0.0.1/disposable_test'}};
  const source={mode:'replication',url:config.connectionString,replication:{replication_slot:'test_slot',plugin:{add_tables:actual.routes(config).map(r=>r.schema+'.'+r.table).join(',')}}};
  const wire={source:{postgres:source},target:{webhooks:{subscriptions:{store:{url:config.connectionString+'?pool_max_conns=2',cache:{enabled:false}},server:{address:'127.0.0.1:3456'}},notifier:{strict_mode:true}}}};
  const store={consumer:p.binding.consumer+'-completed',...(selected?{profile:p.digest}:{}),own:async()=>{throw Error('SOURCE_STOP_BEFORE_LISTENER');},close:async()=>calls.push({kind:'close'})};
  const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const local=m.require.bind(m);
  m.require=name=>name==='node:fs'?{readFileSync:name=>name==='/synthetic/binary'?Buffer.from('synthetic pinned binary'):JSON.stringify(wire)}:name==='node:crypto'?{createHash:()=>({update(){return this;},digest:()=>actual.BINARY_SHA256})}:name==='node:http'?{createServer:()=>assert.fail('NO_LISTENER')}:
   name==='./checkpoint'?{create:options=>{calls.push({kind:'checkpoint',options});return store;}}:name==='./intake-store'?{create:options=>{calls.push({kind:'intake',options});return store;}}:name==='./delivery-health'?{RECEIVER_COUNTERS:require('../lib/pgstream/delivery-health').RECEIVER_COUNTERS,start:()=>assert.fail('NO_HEALTH_BEFORE_STORE')}:
   name==='./feed-control'?{assertReady:async()=>{}}:name==='./intake-state'?{selection:value=>value,publisher:options=>{calls.push({kind:'publisher',options});return {terminal:()=>{}};}}:local(name);
  m._compile(change(fs.readFileSync(file,'utf8')),file);return {api:m.exports,config,p,calls,store};
 }
 it('uses only receipt store for selected feed, ordinary checkpoint for default, and publishes the actual store profile',async()=>{
  for(const selected of [false,true]){const f=protocol({selected});await assert.rejects(f.api.open({config:f.config,...(selected?{intakeProfile:f.p,controlConnection:{}}:{}),connection:{},onInput:()=>{}}),/SOURCE_STOP_BEFORE_LISTENER/);assert.deepEqual(f.calls.map(c=>c.kind),[selected?'intake':'checkpoint','publisher','close']);const factory=f.calls[0].options;if(selected){assert.equal(factory.profile.digest,f.p.digest);assert(!Object.hasOwn(factory,'typed'));assert.equal(f.calls[1].options.intakeProfileDigest,f.store.profile);}else{assert.equal(factory.typed,true);assert.equal(factory.namespace,f.config.namespaces.checkpoint);assert(!Object.hasOwn(f.calls[1].options,'intakeProfileDigest'));}}
 });
 it('control: omitting actual store profile publication makes exact selected agreement RED, restored GREEN',async()=>{
  async function criterion(change){const f=protocol({change});await assert.rejects(f.api.open({config:f.config,intakeProfile:f.p,controlConnection:{},connection:{},onInput:()=>{}}),/SOURCE_STOP_BEFORE_LISTENER/);assert.equal(f.calls.find(c=>c.kind==='publisher').options.intakeProfileDigest,f.store.profile,'ACTUAL_SELECTED_STORE_PROFILE_MUST_BE_PUBLISHED');}
  await assert.rejects(criterion(source=>{const needle='...(intakeProfile===undefined?{}:{intakeProfileDigest:store.profile}),';assert.equal(source.split(needle).length,2);return source.replace(needle,'');}),{code:'ERR_ASSERTION'});await criterion(source=>source);
 });
});
