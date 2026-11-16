'use strict';
// Recording SQL protocols; the bounded natural-exit witness also owns a loopback TCP pair.
// No real PostgreSQL or full application campaign is started.
const assert=require('node:assert/strict'),fs=require('node:fs'),Module=require('node:module'),path=require('node:path');
const profile=require('./fixtures/lifecycle-domain-profile').profile({members:2,revision:'9007199254740993'});
function memberProtocol(mutate=s=>s){
 const fWindow=require('./fixtures/operation-window-runtime-protocol')({intakeProfile:profile,trustedWorker:true}),file=require.resolve('../lib/pool-membership/postgres'),log=[],state={rows:[],desired:{members:2,previousMembers:2,revision:profile.binding.revision,rule:profile.assignment.rule}};
 const query=async(sql,values)=>{log.push({sql,values});if(sql.includes('fixed-member-backend'))return{rows:[{pid:client.processID,...fWindow.window.datastore,role:'membership',birth:'1700000000.000001',rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false,schema_writes:false,unrelated_writes:false,...state.backend}]};if(sql.includes('pg_advisory_xact_lock'))return{rows:[{backend_pid:77,transaction_id:'99'}]};if(sql.startsWith('INSERT INTO'))state.rows=[{ordinal:values[1],memberId:values[2],rule:values[3],appliedMembers:values[4],live:true}];if(sql.startsWith('UPDATE')){state.rows[0].appliedMembers=values[3];return{rows:[],rowCount:1};}return {rows:[],command:sql==='COMMIT'?'COMMIT':undefined};};
 const client=new(require('node:events').EventEmitter)();client.processID=77;client.query=query;client.release=()=>{};const pool={connect:async()=>client,end:async()=>{client.emit('end');await fWindow.window.close();}};const io={connect:observer=>({table:'synthetic_members.pool_membership',snapshot:async()=>{await observer?.observe(client);return{desired:state.desired,rows:state.rows};},pool})};
 const source=fs.readFileSync(file,'utf8'),needle='const { pool, table, snapshot } = await connect({ kind, connectionString, namespace, capability, applicationName, fixedProtocol,observer });';assert.equal(source.split(needle).length,2);
 const m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const local=m.require.bind(m);m.require=name=>name==='synthetic-member-io'?io:local(name);m._compile(mutate(source.replace(needle,"const {pool,table,snapshot}=require('synthetic-member-io').connect(observer);")),file);return {api:m.exports,log,state,window:fWindow.window,client,writes:()=>log.filter(row=>/^(INSERT|UPDATE|DELETE)/.test(row.sql)).length};
}
describe('source-recognized fixed membership registration and slice',()=>{
 async function open(f){const member=await f.api.create({kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile,operationWindow:f.window,onAlert:()=>{}});await member.register();return member;}
 it('registers exact applied count from the beginning; reads refuse NULL peer, desired revision/member drift without adopting resize',async()=>{
  const f=memberProtocol(),m=await open(f);try{assert.equal(f.state.rows[0].appliedMembers,2);f.state.rows.push({ordinal:1,memberId:'33333333-3333-4333-8333-333333333333',rule:profile.assignment.rule,appliedMembers:null,live:true});assert.equal((await m.slice()).eligible,false);f.state.rows[1].appliedMembers=2;assert.equal((await m.slice()).eligible,true);const writes=f.writes();f.state.desired={...f.state.desired,members:1};assert.equal((await m.slice()).eligible,false);assert.equal(f.writes(),writes);f.state.desired={...f.state.desired,members:2,revision:'9007199254740994'};assert.equal((await m.slice()).eligible,false);assert.equal(f.writes(),writes);await m.heartbeat();assert.equal(f.state.rows[0].appliedMembers,2);}finally{await m.close();}
 });
 it('control: old NULL registration breaks exact fixed cohort admission; restoring initialized count passes',async()=>{
  async function criterion(mutate){const f=memberProtocol(mutate),m=await open(f);try{assert.equal(f.state.rows[0].appliedMembers,2,'FIXED_MEMBER_MUST_REGISTER_EXACT_APPLIED_COUNT');}finally{await m.close();}}
  await assert.rejects(criterion(s=>{const needle='applied = selected?.binding.members??null';assert.equal(s.split(needle).length,2);return s.replace(needle,'applied = null');}),{code:'ERR_ASSERTION'});await criterion(s=>s);
 });
 it('rejects unrecognized fixed binding, foreign namespace/kind/ordinal and missing fixed protocol before I/O',async()=>{
  const f=memberProtocol(),options={kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile};for(const change of [{kind:'vcpool'},{namespace:'another_members'},{ordinal:2},{fixedProtocol:false}])await assert.rejects(f.api.create({...options,...change}),/FIXED_INTAKE_PROFILE_BINDING/);assert.equal(f.log.length,0);
 });
});

function document(){const f=require('./fixtures/multitenant-plan'),layout=f.layout(),doc=structuredClone(f.documents({layout,urls:f.syntheticUrls(layout),variant:'full'}).configs.evaluator);for(const field of ['changeFeed','recoveryIntervalMs','settingsRefreshMs'])delete doc[field];delete doc.postgres.namespaces.changeStamps;doc.pgstream={receiver:{url:'http://127.0.0.1:'+18080+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000},slot:'synthetic_slot',streamRole:'synthetic_stream',bounds:{heartbeatMs:1000,stallMs:5000,stepMs:5000,recoveryMs:30000,pendingMs:30000}};const p=require('../lib/pgstream/intake-profile').create({namespace:doc.postgres.namespaces.checkpoint,membershipNamespace:profile.binding.membershipNamespace,lifecycleNamespace:doc.activity.namespace,consumer:doc.consumer,role:profile.binding.role,revision:profile.binding.revision,members:2,tenants:profile.binding.tenants,codec:profile.binding.codec,generationDomain:profile.binding.generationDomain});return {doc,p};}
describe('exact named selected evaluator configuration',()=>{
 it('normalizes the profile and permits only its actual notification control namespace while default collision still refuses',()=>{
  const {doc,p}=document(),config=require('../lib/server/serve/evaluator-config');doc.selectedIntake={profile:JSON.parse(JSON.stringify(p)),workers:['eval0','eval1']};doc.intakeStateSync={assignmentRevision:p.binding.revision};doc.consumers.realtime.partitionMetadata={checkpointNamespace:p.binding.namespace,membershipNamespace:p.binding.membershipNamespace,lifecycleNamespace:p.binding.lifecycleNamespace};const selected=config.parseMetadata(doc);assert.equal(selected.selectedIntake.profile.digest,p.digest);assert(Object.isFrozen(selected.selectedIntake.profile));assert.equal(selected.consumers.realtime.partitionMetadata.lifecycleNamespace,p.binding.lifecycleNamespace);const legacy=structuredClone(doc);delete legacy.selectedIntake;assert.throws(()=>config.parseMetadata(legacy),/consumer configuration/);const bad=structuredClone(doc);bad.consumers.realtime.partitionMetadata.lifecycleNamespace='foreign_control';assert.throws(()=>config.parseMetadata(bad),/consumer configuration/);
 });
 it('selector alone/unknown selector, wrong profiles and ambiguous worker mapping cannot enable execution',()=>{
  const {doc,p}=document(),config=require('../lib/server/serve/evaluator-config'),env={MULTITENANT_EVALUATOR_CAPABILITY:'pgstream-fixed-intake-v1'};assert.throws(()=>config.parse(doc,env),/invalid explicit evaluator/);assert.throws(()=>config.parse(doc,{MULTITENANT_EVALUATOR_CAPABILITY:'another-capability'}),/invalid explicit evaluator/);for(const change of [{profile:{...p,digest:'0'.repeat(64)},workers:['eval0','eval1']},{profile:p,workers:['eval0','eval0']},{profile:p,workers:['eval0']}])assert.throws(()=>config.parseMetadata({...doc,selectedIntake:change}));
 });
});

function controlProtocol(){
 const clock='synthetic_clock',role='feed_control',reads=[clock+'.nightscout_heartbeat','pgstream.webhook_subscriptions',...Object.keys(require('../lib/pgstream/intake-profile').CONTROL_READS).map(t=>profile.binding.lifecycleNamespace+'.'+t)],state={};
 const connection={readOnly:async sql=>{
  if(sql.includes('feed-control-role'))return{rows:[{principal:role,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false,creates:false,...state.role}]};
  if(sql.includes('feed-control-grants'))return{rows:[...reads.map(relation=>({relation,kind:'r',persistence:'p',owns:false,reads:true,forbidden:false,updates:relation===clock+'.nightscout_heartbeat'?['revision']:[]})),...(state.extra?[{relation:'another.clinical',kind:'r',persistence:'p',owns:false,reads:true,forbidden:false,updates:[]}]:[])].map(row=>state.change?state.change(row):row)};
  assert(sql.includes('pgstream-heartbeat-infrastructure'));return{rows:[{global:true,bootstrap_owned:true,augmented:false,columns:[{name:'id',type:'integer',required:true,identity:'',generated:'',default:false},{name:'revision',type:'bigint',required:true,identity:'',generated:'',default:false}],constraints:[{definition:'CHECK ((id = 1))',validated:true,deferred:false,noinherit:false},{definition:'CHECK ((revision >= 0))',validated:true,deferred:false,noinherit:false},{definition:'PRIMARY KEY (id)',validated:true,deferred:false,noinherit:true}]}]};
 }};return{connection,state,options:{profile,clockNamespace:clock,role}};
}
describe('separate ordinal-zero feed control authority (source SQL protocol)',()=>{
 it('admits only exact heartbeat revision update, subscription SELECT and canonical metadata reads; elevated/extra/read-or-write drift refuses then restoration passes',async()=>{
  const api=require('../lib/pgstream/feed-control'),f=controlProtocol();assert.equal((await api.assertReady(f.connection,f.options)).intakeProfileDigest,profile.digest);assert(api.grants(f.options).some(sql=>sql.startsWith('GRANT SELECT,UPDATE(revision)')));for(const field of ['rolreplication','rolsuper','rolinherit','memberships']){f.state.role={[field]:true};await assert.rejects(api.assertReady(f.connection,f.options),/ROLE_REFUSED/);delete f.state.role;}
  f.state.extra=true;await assert.rejects(api.assertReady(f.connection,f.options),/GRANTS_REFUSED/);delete f.state.extra;f.state.change=row=>({...row,updates:[...row.updates,'id']});await assert.rejects(api.assertReady(f.connection,f.options),/GRANTS_REFUSED/);delete f.state.change;await api.assertReady(f.connection,f.options);
 });
});

async function compositionProtocol(ordinal,mutate=source=>source,{shutdownWithdrawal=false,healthCloseError,memberCloseError}={}){
 const file=require.resolve('../lib/server/serve/evaluator-selected-preview'),{createRequire}=require('node:module'),vm=require('node:vm'),local=createRequire(file),log=[],p=profile,A=p.binding.tenants[0],B=p.binding.tenants[1];
 const manifest=require('../lib/server/serve/operation-cohort-manifest'),participants=manifest.validate(['api','eval0','eval1','realtime','tenant-admin'].map(id=>({id,roles:[id.startsWith('eval')?'evaluator':id],namespaces:['synthetic_clinical'],endpoint:{socketPath:'/synthetic/'+id+'.sock',maxBytes:100000,timeoutMs:1000}}))),self=participants[ordinal+1],f=require('./fixtures/operation-window-runtime-protocol')({intakeProfile:p,trustedWorker:true});
 const entries=new Map([A,B].map(id=>[id,{tenant:id,identity:'synthetic',env:{settings:{language:'en'}}}])),metadata=new Map([A,B].map(id=>[id,{signature:{stamp:'1'},settings:'1',policy:'1',activity:{version:'1',paused:false,suspended:false}}]));
 let available=true,timer;const trusted={verify:async()=>{available=true;log.push({kind:'trusted.verify'});},scan:async ids=>{log.push({kind:'scan',ids:[...ids]});return new Map([...ids].map(id=>[id,metadata.get(id)]));},current:id=>metadata.get(id),state:()=>({available}),health:()=>({available}),invalidate:()=>{available=false;},remove:()=>{},close:async()=>{}};
 const gate={partitioned:true,admits:id=>p.assignment.owner(id)===ordinal,refresh:async()=>{},start:()=>{},reason:()=>null,onChange:()=>{},close:()=>{}};
 let workerReleased=false,consumersClosed=false;
 const worker={begin:async()=>{},complete:async()=>{assert(!workerReleased,'ENTERED_COMPLETION_REQUIRES_HELD_OWNER');},own:async()=>log.push({kind:'worker.own'}),admit:async ids=>log.push({kind:'worker.admit',ids:[...ids]}),close:async()=>{workerReleased=true;log.push({kind:'worker.close'});}};
 const receipts={observeMany:async rows=>log.push({kind:'receipts.observe',ids:rows.map(row=>row.tenant)})};
 const connections=[],connect=async options=>{const c={options,end:async()=>{if(shutdownWithdrawal)assert(workerReleased,'OWNER_MUST_RELEASE_BEFORE_CONNECTION_END');log.push({kind:'connection.end',name:options.application_name});}};connections.push(c);log.push({kind:'connect',options});return c;};connect.readopt=async()=>{};
 const operational={verify:async()=>trusted.verify(),version:()=>1,activateRefresh:()=>{},close:async()=>{}};
 const runtime={close:async()=>{},health:()=>({tenants:p.binding.tenants.filter(id=>gate.admits(id)).map(tenant=>({tenant,ready:true,activity:'active'}))}),last:()=>{},isCurrent:()=>true,markPending:()=>{},invalidateTenant:async()=>{},acquire:async()=>{},tick:async()=>{},wake:async()=>{},verifyOperational:async fn=>fn()};
 const consumers={close:async()=>{consumersClosed=true;},invalidateTenant:async()=>{if(shutdownWithdrawal&&consumersClosed)throw new Error('Evaluator consumer tenant is not configured');},verifyOperational:async()=>{},start:()=>{},health:()=>({}),wake:async()=>{},revised:()=>{}};
 const scheduler={close:async()=>{},recover:async()=>log.push({kind:'recover'}),wake:()=>{},wakeDelivery:()=>{},stats:()=>({})};
 const startRuntime=async options=>{log.push({kind:'runtime',options});return runtime;};
 const overrides={'../../storage/postgres-connection':connect,'./registry-tenant-set':{open:async()=>({tenants:entries,isActive:()=>true,activeIds:()=>new Set(entries.keys()),waiting:()=>0,revision:()=>1,stats:()=>({}),close:async()=>{}})},'./evaluator-readiness':Object.assign(async()=>log.push({kind:'readiness'}),{provisionTenant:async()=>{}}),'../../pool-membership':{member:async(config,options)=>{log.push({kind:'member',options});return{configured:{mode:'partitioned',memberId:ordinal===0?A:B,ordinal,rule:p.assignment.rule,leaseMs:1000},backends:()=>[{pid:9700+ordinal,role:'membership',birth:'1700000000.000001'}],register:async()=>{},close:async()=>{log.push({kind:'member.close'});if(memberCloseError)throw memberCloseError;}};}},'./evaluator-pool':{create:()=>gate},'../../trusted-worker/postgres':{create:()=>trusted},'../../trusted-worker/lifecycle':async()=>operational,'../../pgstream/checkpoint':{create:options=>{log.push({kind:'worker',options});return worker;}},'../../pgstream/evaluator':{open:async options=>{log.push({kind:'feed',options});await options.onRecovered(receipts);return {store:receipts,ready:async()=>{},assertAvailable:()=>{},health:()=>({healthy:true}),close:async()=>{},inspectIntake:()=>{}};}},'./tenant-startup':{create:ids=>{log.push({kind:'startup',ids:[...ids]});return{warm:async()=>{},isReady:()=>true,ensure:async()=>{},health:()=>({}),tenants:()=>[...ids],close:async()=>{}};}},'../../migrations/postgres':{run:async(command,options)=>log.push({kind:'activity.catalogue',options})},'./evaluator-runtime':startRuntime,'./evaluator-consumers':{prepare:async options=>{options.assertOperational();log.push({kind:'consumers',options});return consumers;}},'../../pgstream/activity-scheduler':{start:options=>{log.push({kind:'scheduler',options});return scheduler;}},'../../pgstream/intake-state':{worker:options=>{log.push({kind:'intake-health',options});const withdrawal=shutdownWithdrawal?local('../../pgstream/intake-state').worker({...options,bounds:{heartbeatMs:100,stallMs:1000,stepMs:100,recoveryMs:2000,pendingMs:1000},client:{},lifecycleClient:{}}):null;let ready=false;return{get available(){return ready;},assertAvailable(){assert(ready,'NO_UNQUALIFIED_HEALTH');},synchronize:async()=>{await options.revalidate();await options.reconcile();ready=true;},close:async()=>{ready=false;await withdrawal?.close();if(healthCloseError)throw healthCloseError;}};}},'../internal-api/clients':{completedOutput:()=>({hintCompletedOutput:async()=>{}}),pgstreamInput:endpoint=>({hintEvaluatorInput:async request=>{log.push({kind:'hint',endpoint,request});return{accepted:true};}})},'./evaluator-inspection':()=>()=>({})};
 const module={exports:{}};vm.runInThisContext('(function(require,module,exports,setInterval,clearInterval,setImmediate){'+mutate(fs.readFileSync(file,'utf8'))+'\n})',{filename:file})(name=>Object.hasOwn(overrides,name)?overrides[name]:local(name),module,module.exports,(fn,delay)=>{timer={fn,delay,unref(){}};return timer;},()=>{timer=null;},()=>{});
 const previousMode=require('../lib/storage/tenant-scope').getTenancyMode();
 const config={selectedIntake:{profile:p,workers:['eval0','eval1'],...(ordinal===0?{connectionString:'postgresql://'+p.binding.role+':synthetic@127.0.0.1/disposable_test',controlConnectionString:'postgresql://feed_control:synthetic@127.0.0.1/disposable_test'}:{})},partition:{kind:'evaluator',partitioned:true,ordinal,namespace:p.binding.membershipNamespace,leaseMs:1000},intakeStateSync:{assignmentRevision:p.binding.revision},pgstream:{bounds:{recoveryMs:1000,pendingMs:1000,stallMs:1000,heartbeatMs:100},outputPeer:{}},trustedWorker:{activity:p.binding.lifecycleNamespace},activity:{namespace:p.binding.lifecycleNamespace,connectionString:'postgresql://activity:synthetic@127.0.0.1/disposable_test'},registry:{namespace:'synthetic_registry'},connectionString:'postgresql://clinical_'+ordinal+':synthetic@127.0.0.1/disposable_test',namespaces:{checkpoint:p.binding.namespace,clock:'synthetic_clock'},consumer:p.binding.consumer,consumers:{realtime:{route:{id:'synthetic-notify'},partitionMetadata:{}}},maxBytes:10000,timeIntervalMs:1000,maxTenants:100,tenants:entries};
 return {api:module.exports,config,log,worker,runtime,consumers,receipts,connections,participants,self,window:f.window,timer:()=>timer,async boot(){return module.exports.boot(config,{operationWindow:f.window,intakeBinding:()=>({participant:'eval0',incarnation:A}),partitionParticipants:participants,partitionParticipant:self});},async close(){await f.window.close();require('../lib/storage/tenant-scope').setTenancyMode(previousMode);}};
}
async function heldDrainCriterion(mutate=source=>source,component='runtime'){
 const f=await compositionProtocol(1,mutate,{shutdownWithdrawal:true});let release,closed;
 const held=new Promise(resolve=>{release=resolve;});
 try{const context=await f.boot();f[component].close=()=>held.then(()=>f.worker.complete());closed=context.close();closed.catch(()=>{});
  await new Promise(resolve=>setImmediate(resolve));
  assert(!f.log.some(row=>row.kind==='worker.close'),'OWNER_MUST_REMAIN_HELD_UNTIL_ENTERED_WORK_DRAINS');
  assert(!f.log.some(row=>row.kind==='connection.end'),'POOL_END_MUST_FOLLOW_ENTERED_WORK_DRAIN');
  release();await closed;
 }finally{release();await closed?.catch(()=>{});await f.close();}
}
async function failureRetentionCriterion(mutate=source=>source){
 const primary=Object.assign(new Error('SYNTHETIC_PRIMARY_UNCERTAIN'),{commitOutcome:'uncertain'}),memberFailure=new Error('SYNTHETIC_MEMBER_CLOSE_FAILURE'),f=await compositionProtocol(0,mutate,{memberCloseError:memberFailure}),failures=[memberFailure];
 try{const context=await f.boot();f.runtime.close=async()=>{throw primary;};
  for(const connection of f.connections){const failure=new Error('SYNTHETIC_END_'+failures.length);failures.push(failure);connection.end=async()=>{f.log.push({kind:'failed.end',failure});throw failure;};}
  let result;try{await context.close();}catch(error){result=error;}
  assert(result instanceof globalThis.AggregateError&&[primary,...failures].every(reason=>result.errors.includes(reason)),'ALL_PRIMARY_AND_CLEANUP_FAILURES_MUST_BE_RETAINED');
  assert.equal(f.log.filter(row=>row.kind==='failed.end').length,3);assert.equal(primary.commitOutcome,'uncertain');
 }finally{await f.close();}
}
describe('actual selected boot source constructor boundaries (all I/O recording protocols)',()=>{
 it('starts one receipt/control feed only on ordinal zero and gives each worker its own SQL-fenced store, startup slice and notification partition',async()=>{
  for(const ordinal of [0,1]){const f=await compositionProtocol(ordinal);let context;try{context=await f.boot();const own=profile.binding.tenants.filter(id=>profile.assignment.owner(id)===ordinal);assert.deepEqual(f.log.find(row=>row.kind==='startup').ids,own);assert.deepEqual(f.log.find(row=>row.kind==='worker.admit').ids,own);assert.equal(f.log.filter(row=>row.kind==='feed').length,ordinal===0?1:0);assert.equal(f.connections.length,ordinal===0?3:1);assert.equal(f.log.find(row=>row.kind==='scheduler').options.store,f.worker);assert.equal(f.log.find(row=>row.kind==='runtime').options.durable.begin,f.worker.begin);assert.equal(f.log.find(row=>row.kind==='consumers').options.partition.self.ordinal,ordinal);assert.equal(f.log.find(row=>row.kind==='member').options.intakeProfile.digest,profile.digest);assert.equal(f.log.find(row=>row.kind==='activity.catalogue').options.catalogue.migrations.length,10);const modules=Object.keys(context.internal);assert(modules.includes('pgstream-input'));assert.equal(modules.includes('intake-state'),ordinal===0);if(ordinal===0){assert.deepEqual(f.log.find(row=>row.kind==='receipts.observe').ids,profile.binding.tenants);const feed=f.log.find(row=>row.kind==='feed').options;assert.notEqual(feed.connection,feed.controlConnection);assert.equal(feed.intakeProfile.digest,profile.digest);assert(f.connections.slice(1).every(c=>c.options.max===1));}else{assert(f.log.some(row=>row.kind==='intake-health'));assert.equal(f.log.find(row=>row.kind==='intake-health').options.peer.id,'eval0');}await f.timer().fn();}finally{await context?.close();assert.equal(f.timer(),null);await f.close();}}
 });
 it('drains ordinal-one shutdown withdrawal without re-invalidating already closed consumers or leaking the worker owner',async()=>{
  const f=await compositionProtocol(1,source=>source,{shutdownWithdrawal:true});let context;
  try{context=await f.boot();await context.close();assert.equal(f.log.filter(row=>row.kind==='worker.close').length,1);assert(f.log.some(row=>row.kind==='connection.end'));}
  finally{await f.close();}
 });
 // The inherited assertion expected release during a held runtime drain. That
 // expectation was unsafe: entered completion still needs the owner's exclusion.
 it('preserves entered component drains and still releases the owner after an independent health-close failure',async()=>{
  const failure=new Error('SYNTHETIC_HEALTH_CLOSE_FAILURE'),f=await compositionProtocol(1,source=>source,{shutdownWithdrawal:true,healthCloseError:failure});let release;const held=new Promise(resolve=>{release=resolve;});let context;
  try{context=await f.boot();f.runtime.close=()=>held;let settled=false;const closed=context.close();closed.then(()=>{settled=true;},()=>{settled=true;});
   await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false,'entered runtime drain must finish');assert(!f.log.some(row=>row.kind==='worker.close'),'OWNER_MUST_REMAIN_HELD_UNTIL_ENTERED_RUNTIME_DRAINS');assert(!f.log.some(row=>row.kind==='connection.end'),'connection must remain open during entered work');
   release();await assert.rejects(closed,error=>error instanceof globalThis.AggregateError&&error.errors.includes(failure));assert(f.log.some(row=>row.kind==='connection.end'));
  }finally{release();await f.close();}
 });
 it('retains primary uncertainty, membership and every connection-close failure; dropped-error controls are red',async()=>{
  await failureRetentionCriterion();
  for(const [needle,replacement] of [['() => member?.close()','() => {}'],['catch (error) { errors.push(error); }','catch { /* deliberately drop the error */ }']]){
   await assert.rejects(failureRetentionCriterion(source=>{assert.equal(source.split(needle).length,2);return source.replace(needle,replacement);}),/ALL_PRIMARY_AND_CLEANUP_FAILURES_MUST_BE_RETAINED/);
  }
  await failureRetentionCriterion();
 });
 it('controls: skipping the shutdown fence or independent owner drain is red, then restored source is green',async()=>{
  async function exercise(mutate,healthCloseError){const f=await compositionProtocol(1,mutate,{shutdownWithdrawal:true,healthCloseError});let context;
   try{context=await f.boot();await context.close();}finally{await f.close();}}
  await assert.rejects(exercise(source=>{const needle='if(stopping)return;';assert.equal(source.split(needle).length,2);return source.replace(needle,'if(false)return;');}),error=>error instanceof globalThis.AggregateError&&error.errors.some(reason=>reason.message==='Evaluator consumer tenant is not configured'));
  await assert.rejects(exercise(source=>{const needle='() => pgstream?.close(), () => workerStore?.close()';assert.equal(source.split(needle).length,2);return source.replace(needle,'() => pgstream?.close()');}),error=>error instanceof globalThis.AggregateError&&error.errors.some(reason=>reason.message==='OWNER_MUST_RELEASE_BEFORE_CONNECTION_END'));
  await exercise(source=>source);
 });
 it('keeps owner exclusion and pool resources until held clinical and delivery work drains; premature releases and ends are red',async()=>{
  for(const component of ['runtime','consumers'])await heldDrainCriterion(source=>source,component);
  await assert.rejects(heldDrainCriterion(source=>{const needle='      await stopped;';assert.equal(source.split(needle).length,2);return source.replace(needle,'      await workerStore?.close();\n'+needle);}),/OWNER_MUST_REMAIN_HELD_UNTIL_ENTERED_WORK_DRAINS/);
  await assert.rejects(heldDrainCriterion(source=>{const needle='      await stopped;';assert.equal(source.split(needle).length,2);return source.replace(needle,'      await connection?.end();\n'+needle);}),/OWNER_MUST_RELEASE_BEFORE_CONNECTION_END/);
  await heldDrainCriterion();
 });
 it('bounded child exits naturally after selected close releases its owned TCP pair',function(done){
  this.timeout(7000);
  const {execFile}=require('node:child_process'),mocha=require.resolve('mocha/bin/mocha.js');
  const run=mode=>new Promise(resolve=>execFile(process.execPath,[mocha,'--reporter','dot',__filename,'--grep','natural-exit child protocol'],{env:{...process.env,SELECTED_SHUTDOWN_EXIT_CHILD:mode},timeout:1500},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
  (async()=>{const green=await run('restored');assert(!green.error,green.stdout+green.stderr);
   const red=await run('omit-owner');assert(red.error?.killed,'omitted owner must retain the live TCP handle until the bounded parent kills its child');assert.match(red.stdout,/OWNER_MUST_RELEASE_BEFORE_CONNECTION_END/);
   const restored=await run('restored');assert(!restored.error,restored.stdout+restored.stderr);console.log('bounded natural-exit witness: restored exit=0, omitted-owner killed='+red.error.killed+', restored exit=0');
  })().then(()=>done(),done);
 });
 it('natural-exit child protocol',async function(){
  const mode=process.env.SELECTED_SHUTDOWN_EXIT_CHILD;if(!mode)this.skip();
  const net=require('node:net'),server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const client=net.connect(server.address().port,'127.0.0.1');await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  const mutate=source=>{if(mode!=='omit-owner')return source;const needle='() => pgstream?.close(), () => workerStore?.close()';assert.equal(source.split(needle).length,2);return source.replace(needle,'() => pgstream?.close()');};
  const f=await compositionProtocol(1,mutate,{shutdownWithdrawal:true}),context=await f.boot(),release=f.worker.close;
  f.worker.close=async()=>{await release();client.end();};
  const end=f.connections[0].end;f.connections[0].end=async()=>{await end();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));};
  try{await context.close();}catch(error){console.log(error.errors?.map(reason=>reason.message).join(','));throw error;}finally{await f.close();}
 });
 it('refuses forged/ambiguous/wrong-self or wrong-role participant mappings before any connection or member construction',async()=>{
  const f=await compositionProtocol(1);try{for(const change of [{partitionParticipants:[]},{partitionParticipant:f.participants[0]},{partitionParticipants:f.participants.map(p=>({...p}))}])await assert.rejects(f.api.boot(f.config,{operationWindow:f.window,partitionParticipants:f.participants,partitionParticipant:f.self,...change}),/SELECTED_PARTICIPANTS/);assert.equal(f.connections.length,0);assert(!f.log.some(row=>row.kind==='member'));}finally{await f.close();}
 });
});


describe('selected runtime authority controls',()=>{
 it('fixed registry additions/removals withdraw the process and never schedule a new dynamic tenant',async()=>{
  for(const action of ['add','remove']){const f=await compositionProtocol(0);let context;try{context=await f.boot();const before=f.log.filter(row=>row.kind==='recover').length;if(action==='add')f.config.tenants.set('33333333-3333-4333-8333-333333333333',{});else f.config.tenants.delete(profile.binding.tenants[0]);await f.timer().fn();assert.equal((await context.failure).message,'PGSTREAM_FIXED_REGISTRY_CHANGED');assert.equal(f.log.filter(row=>row.kind==='recover').length,before);}finally{await context?.close();await f.close();}}
 });
 it('control: allowing ordinal one to construct the feed makes the sole-intake criterion RED; restored GREEN',async()=>{
  async function criterion(mutate){const f=await compositionProtocol(1,mutate);let context;try{context=await f.boot();assert.equal(f.log.filter(row=>row.kind==='feed').length,0,'ORDINAL_ONE_MUST_NOT_CONSTRUCT_FEED');}finally{await context?.close();await f.close();}}
  await assert.rejects(criterion(source=>{const needle='if(ordinal===0){\n      intakeConnection';assert.equal(source.split(needle).length,2);return source.replace(needle,'if(true){\n      intakeConnection');}),{code:'ERR_ASSERTION'});await criterion(source=>source);
 });
 it('control: reverting fixed selection to dynamic slice adopts a changed desired count and makes no-resize criterion RED; restored GREEN',async()=>{
  async function criterion(mutate){const f=memberProtocol(mutate),m=await f.api.create({kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile,operationWindow:f.window,onAlert:()=>{}});try{await m.register();f.state.rows.push({ordinal:1,memberId:'33333333-3333-4333-8333-333333333333',rule:profile.assignment.rule,appliedMembers:2,live:true});f.state.desired={...f.state.desired,members:1};const verdict=await m.slice();assert.equal(verdict.eligible,false,'CHANGED_FIXED_DESIRED_MUST_REFUSE');assert.equal(f.state.rows[0].appliedMembers,2);}finally{await m.close();}}
  await assert.rejects(criterion(source=>{const needle='      if(selected){';assert.equal(source.split(needle).length,2);return source.replace(needle,'      if(false){');}),{code:'ERR_ASSERTION'});await criterion(source=>source);
 });
 it('actual selected window catalogue is source-owned and reused, while unselected/forged/closed boundaries stay exact',async()=>{
  const windows=require('../lib/tenant-lifecycle/operation-window'),f=require('./fixtures/operation-window-runtime-protocol')({intakeProfile:profile}),legacy=require('./fixtures/operation-window-runtime-protocol')();try{const selected=windows.catalogue(f.window);assert.equal(selected.migrations.length,10);assert.strictEqual(windows.intakeRoster(f.window),profile.binding.tenants);assert(Object.isFrozen(windows.intakeRoster(f.window)));assert.equal(windows.intakeRoster(legacy.window),undefined);assert.throws(()=>windows.intakeRoster({...f.window}),/SCOPE_INVALID/);assert.strictEqual(windows.catalogue(f.window),selected);assert.equal(windows.catalogue(legacy.window).migrations.length,9);assert.throws(()=>windows.catalogue({...f.window}),/SCOPE_INVALID/);await f.window.close();assert.throws(()=>windows.catalogue(f.window),/SCOPE_INVALID/);assert.throws(()=>windows.intakeRoster(f.window),/SCOPE_INVALID/);}finally{await f.window.close();await legacy.window.close();}
 });
});

describe('selected executable config and private transport planning',()=>{
 function configured(ordinal){const {doc,p}=document();doc.datastore={hostname:'127.0.0.1',port:5432,database:'disposable_test'};const source={MULTITENANT_EVALUATOR_CAPABILITY:'pgstream-fixed-intake-v1',MULTITENANT_POOL_EVALUATOR_PARTITION:'on',MULTITENANT_POOL_EVALUATOR_ORDINAL:String(ordinal),MULTITENANT_POOL_EVALUATOR_DATABASE_URL:'postgresql://membership:synthetic@127.0.0.1/disposable_test',MULTITENANT_POOL_EVALUATOR_NAMESPACE:p.binding.membershipNamespace,NS_PGSTREAM_BINARY:'/synthetic/pgstream',NS_PGSTREAM_CONFIG:'/synthetic/pgstream.json'};function envs(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(key==='connectionEnv')source[child]='postgresql://'+child.toLowerCase()+':synthetic@127.0.0.1/disposable_test';else envs(child);}}envs(doc);doc.selectedIntake={profile:JSON.parse(JSON.stringify(p)),workers:['eval0','eval1'],...(ordinal===0?{connectionEnv:'NS_RECEIPT',controlConnectionEnv:'NS_CONTROL'}:{})};source.NS_RECEIPT='postgresql://'+p.binding.role+':synthetic@127.0.0.1/disposable_test';source.NS_CONTROL='postgresql://feed_control:synthetic@127.0.0.1/disposable_test';doc.intakeStateSync={assignmentRevision:p.binding.revision};doc.consumers.realtime.partitionMetadata={checkpointNamespace:p.binding.namespace,membershipNamespace:p.binding.membershipNamespace,lifecycleNamespace:p.binding.lifecycleNamespace};return{doc,p,source};}
 it('resolves distinct receipt/control credentials only on ordinal zero, requires same datastore and registers actual hint routes for both workers',()=>{
  const config=require('../lib/server/serve/evaluator-config'),listeners=require('../lib/server/serve/internal-listener');for(const ordinal of [0,1]){const f=configured(ordinal),parsed=config.parse(f.doc,f.source);assert.equal(parsed.selectedIntake.profile.digest,f.p.digest);assert.equal(Object.hasOwn(parsed.selectedIntake,'connectionString'),ordinal===0);if(ordinal===1){assert(!Object.hasOwn(parsed.pgstream,'binary'));assert(!Object.hasOwn(parsed.pgstream,'configFile'));}const rows=listeners.plan(['evaluator'],{evaluatorPreview:{...parsed,partition:config.partitionFor(f.source)},participant:{roles:['evaluator'],endpoint:{maxBytes:100000,timeoutMs:1000}}});assert(rows.some(row=>row.id==='pgstream-input'));assert.equal(rows.some(row=>row.id==='intake-state'),ordinal===0);const foreign={...f.source,MULTITENANT_POOL_EVALUATOR_DATABASE_URL:'postgresql://membership:synthetic@127.0.0.1/other_database'};assert.throws(()=>config.parse(f.doc,foreign),/invalid explicit evaluator/);if(ordinal===1)assert.throws(()=>config.parse({...f.doc,selectedIntake:{...f.doc.selectedIntake,connectionEnv:'NS_RECEIPT'}},f.source),/invalid explicit evaluator/);}
 });
});


describe('original raw membership backend admission',()=>{
 async function open(f){return f.api.create({kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile,operationWindow:f.window,onAlert:()=>{}});}
 it('refuses a different actual postmaster before registration mutates membership and records original admitted identities for census',async()=>{
  const f=memberProtocol(),m=await open(f);try{f.state.backend={postmaster_birth:'1700000001.000000'};await assert.rejects(m.register(),e=>e.code==='POOL_UNAVAILABLE'&&e.cause?.code==='POOL_FIXED_DATASTORE_REFUSED');assert.equal(f.writes(),0);assert.throws(m.backends,{code:'POOL_FIXED_DATASTORE_REFUSED'});}finally{await m.close();}
  const good=memberProtocol(),owned=await open(good);try{await owned.register();assert.deepEqual(owned.backends(),[{pid:77,role:'membership',birth:'1700000000.000001'}]);good.client.emit('end');assert.deepEqual(owned.backends(),[]);}finally{await owned.close();}
 });
 it('refuses a reused client PID or changed original birth before renewal, latches the census unavailable and never writes another lease',async()=>{
  for(const mode of ['pid','birth']){const f=memberProtocol(),m=await open(f);try{await m.register();const writes=f.writes();if(mode==='pid')f.client.processID=78;else f.state.backend={birth:'1700000000.000002'};assert.equal((await m.heartbeat()).renewed,false);assert.equal(f.writes(),writes);assert.throws(m.backends,{code:'POOL_FIXED_BACKEND_CHANGED'});}finally{await m.close().catch(error=>assert.equal(error.code,'POOL_FIXED_BACKEND_CHANGED'));}}
 });
 it('control: omitting actual datastore equality allows wrong-postmaster registration, so the intended admission refusal is RED; restoration GREEN',async()=>{
  async function criterion(mutate){const f=memberProtocol(mutate),m=await open(f);try{f.state.backend={postmaster_birth:'1700000001.000000'};await assert.rejects(m.register(),e=>e.cause?.code==='POOL_FIXED_DATASTORE_REFUSED');assert.equal(f.writes(),0);}finally{await m.close();}}
  await assert.rejects(criterion(source=>{const needle="  if(!same(database,window.datastore))throw refuse('POOL_FIXED_DATASTORE_REFUSED');";assert.equal(source.split(needle).length,2);return source.replace(needle,'');}),{code:'ERR_ASSERTION'});await criterion(source=>source);
 });
});


describe('fixed raw member principal scope and every checkout',()=>{
 it('reobserves the original backend for registration, renewal, slice, inspection and close; extra protected writes refuse before mutation',async()=>{
  const f=memberProtocol(),m=await f.api.create({kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile,operationWindow:f.window,onAlert:()=>{}});await m.register();await m.heartbeat();await m.slice();await m.inspect();assert.equal(f.log.filter(row=>row.sql.includes('fixed-member-backend')).length,4);await m.close();assert.equal(f.log.filter(row=>row.sql.includes('fixed-member-backend')).length,5);
  const bad=memberProtocol(),refused=await bad.api.create({kind:'evaluator',ordinal:0,namespace:profile.binding.membershipNamespace,leaseMs:1000,fixedProtocol:true,intakeProfile:profile,operationWindow:bad.window,onAlert:()=>{}});try{bad.state.backend={unrelated_writes:true};await assert.rejects(refused.register(),e=>e.cause?.code==='POOL_FIXED_BACKEND_REFUSED');assert.equal(bad.writes(),0);}finally{await refused.close();}
 });
});


describe('feed control source grants through actual lower-window readiness',()=>{
 function grantSource(mutate=source=>source){const file=require.resolve('../lib/pgstream/feed-control'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));m._compile(mutate(fs.readFileSync(file,'utf8')),file);return m.exports;}
 async function admission(api,{selected=true,change=()=>{}}={}){
  const grants=api.grants({profile,clockNamespace:'synthetic_clock',role:'feed_control'}),execute=grants.some(sql=>sql.startsWith('GRANT EXECUTE ON FUNCTION "'+profile.binding.lifecycleNamespace+'".tenant_lifecycle_backend_birth() TO ')),metadata=require('./fixtures/lifecycle-domain-profile').metadata(selected?profile:undefined,(kind,rows)=>{if(kind==='function')rows[0].executes=execute;change(kind,rows);}),protocol=require('./fixtures/operation-window-admission-protocol')(metadata);
  return require('../lib/tenant-lifecycle/operation-window-readiness').admit({query:async(sql,values)=>protocol(sql,values)},profile.binding.lifecycleNamespace,selected?{intakeProfile:profile}:{});
 }
 it('reproduces old source-granted EXECUTE refusal, then admits the corrected readonly lower role without changing readiness',async()=>{
  const old=grantSource(source=>{const needle=" ...Object.keys(profiles.CONTROL_READS).map(table=>'GRANT SELECT ON '+control+'.'+table+' TO '+role),\n";assert.equal(source.split(needle).length,2);return source.replace(needle,needle+" 'GRANT EXECUTE ON FUNCTION '+control+'.tenant_lifecycle_backend_birth() TO '+role\n");});
  await assert.rejects(admission(old),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  const fixed=grantSource();assert(!fixed.grants({profile,clockNamespace:'synthetic_clock',role:'feed_control'}).some(sql=>sql.startsWith('GRANT EXECUTE')));await admission(fixed);await admission(fixed,{selected:false});
 });
 it('keeps required canonical metadata SELECT and exact backend-birth function shape mandatory for lower admission',async()=>{
  const fixed=grantSource();for(const table of ['schema_migrations','tenant_lifecycle_windows','tenant_lifecycle_operations'])await assert.rejects(admission(fixed,{change:(kind,rows)=>{if(kind===table)rows[0].reads=false;}}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});
  await assert.rejects(admission(fixed,{change:(kind,rows)=>{if(kind==='function')rows[0].prosrc='SELECT now()';}}),{code:'LIFECYCLE_WINDOW_SCHEMA_UNSAFE'});await admission(fixed);
 });
});
