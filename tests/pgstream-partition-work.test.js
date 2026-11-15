'use strict';
// Actual optional checkpoint modules against a transactional JavaScript model.
// The model does not establish PostgreSQL trigger, lock, planner or COMMIT semantics.
const assert=require('node:assert/strict');
const checkpoint=require('../lib/pgstream/checkpoint'),work=require('../lib/pgstream/work-state');
const fixed=require('../lib/pgstream/fixed-assignment'),candidate=require('../lib/pgstream/assignment-candidate');
const membershipProtocol=require('../lib/pool-membership/fixed-protocol');
const {RULE,bucket}=require('../lib/pool-membership/slice');
const copy=value=>JSON.parse(JSON.stringify(value));
const ids=Array.from({length:128},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const REV='9007199254740993',NS='test_checkpoint',MEMBERSHIP='test_membership',LIFECYCLE='test_control';
function instrumentation(){
 const built=candidate.build({membershipNamespace:MEMBERSHIP,lifecycleNamespace:LIFECYCLE});
 const effect=(name,type,source,fn,columns,deferred)=>({name,type,source,function_name:fn,columns,deferrable:deferred,deferred,enabled:'A',arguments:0,unconditional:true,function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']});
 return {assignment:[effect('pgstream_assignment_protocol',31,built.assignmentBody,'pgstream_assignment_required',candidate.ASSIGNMENT_COLUMNS,false),effect('pgstream_effect_protocol',19,built.effectBody,'pgstream_assigned_effect_required',candidate.EFFECT_COLUMNS,false),effect('pgstream_effect_commit',17,built.effectBody,'pgstream_assigned_effect_required',[],true)],
  indexes:candidate.INDEXES.map(index=>({...index,valid:true,ready:true,unique:false,method:'btree'})),
  membership:['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:membershipProtocol.BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}))};
}
function fixture({ordinal=0,partitioned=true,enforceOldWriter=true,boundary=true,creator=checkpoint.create}={}){
 const assignment=fixed.create({tenants:ids,members:2,revision:REV}),self={ordinal,memberId:ids[ordinal],rule:RULE};
 let generation='7',live=true,resourceHeld=true,active=null,xid=0,failCommit=false,beforeCommit=()=>{},afterUpdate=()=>{},digest;
 const rows=new Map(),calls=[],events=[],keys=[],hints=[],instruments=instrumentation();
 const selectedRows=()=>active?.rows||rows;
 function base(tenant){return {tenant,contract_digest:digest,work_version:2,work_observed:work.array({clock:'1'}),work_completed:work.array({}),work_observed_at:work.array({clock:'10'}),work_pending_at:'10',work_due_at:null,work_completed_at:null,work_enabled:true,work_activity_enabled:true,work_lifecycle_enabled:true,delivery_revision:'0',delivery_ack_revision:'0',output_identity:null,output_digest:null,output_revision:'0',output_restore_generation:null,work_owner_ordinal:assignment.owner(tenant),work_assignment_revision:REV,projection:[{kind:'evaluator-work-v2',output:null}]};}
 function metadata(row){const output=row.projection?.[0]?.output,summary=copy(output);if(summary){delete summary.rows;delete summary.frame;}return {...copy(row),output_summary:summary,frame_at:output?.frame?.lastUpdated};}
 function trigger(row){if(row.work_owner_ordinal===null||!enforceOldWriter)return;const context=active?.context;if(!resourceHeld||!context||context.tenant!==row.tenant||context.ordinal!==row.work_owner_ordinal||context.revision!==row.work_assignment_revision||context.backendPid!==41||context.transactionId!==String(xid)||context.memberId!==self.memberId||!live||context.restoreGeneration!==generation||row.output_revision!=='0'&&row.output_restore_generation!==generation)throw new Error('MODEL_ASSIGNED_EFFECT_REFUSED');}
 const connection={
  async holdAdvisoryLock(key){keys.push(key);let available=true;return {async withTenantTransaction(tenant,fn){assert(!active,'no ambient selected transaction');events.push('EXPLICIT_BOUNDARY');return this.withTenant(tenant,fn);},get available(){return available;},get backendPid(){assert(available);return 41;},async close(){available=false;},async withTenant(tenant,fn){assert(!active);active={tenant,rows:new Map([...rows].map(([id,row])=>[id,copy(row)])),context:null,effects:new Set()};xid++;events.push('BEGIN');try{const result=await fn();await beforeCommit();for(const id of active.effects)trigger(active.rows.get(id));if(failCommit)throw Error('COMMIT_UNCONFIRMED');for(const [id,row]of active.rows)rows.set(id,copy(row));events.push('COMMIT');return result;}catch(error){events.push('ROLLBACK');throw error;}finally{active=null;}}};},
  async observeEvaluatorTyped(options){calls.push({observation:options});return options.observations.map(()=>({deliveryPending:false}));},
  async admitEvaluatorTyped(options){calls.push({admission:options});},
  async acknowledgeEvaluatorTyped(){throw Error('PARTITION_ACK_MUST_USE_OWNER_BACKEND');},
  async query(sql,values){calls.push({sql,values,transaction:active?String(xid):null});assert(active,'effect queries require owner transaction');
   const identity={backend_pid:41,transaction_id:String(xid)};
   if(sql.includes('pg_advisory_xact_lock'))return {rows:[identity]};
   if(sql.includes('FROM "'+MEMBERSHIP+'".pool_desired'))return {rows:[{...identity,members:2,revision:REV,rule:RULE}]};
   if(sql.includes('json_agg(json_build_object'))return {rows:[{...identity,members:[0,1].map(index=>({ordinal:index,memberId:ids[index],rule:RULE,live,appliedMembers:2}))}]};
   if(sql.startsWith("SELECT set_config('app.pgstream_partition_effect'")){active.context=JSON.parse(values[0]);events.push('CONTEXT');return {rows:[]};}
   if(sql.startsWith('SELECT tenant_id')){events.push('LOCK_ROW');return {rows:[metadata(selectedRows().get(values[0]))]};}
   if(sql.startsWith("SELECT projection->0->'output'"))return {rows:[{output:copy(selectedRows().get(values[0]).projection[0].output)}]};
   if(sql.startsWith('UPDATE')){const row=selectedRows().get(values[0]);trigger(row);
    if(sql.includes('SET checkpoint=')){Object.assign(row,{checkpoint:values[2],work_completed:values[3],work_due_at:values[4]===null?null:String(values[4]),work_pending_at:values[5]===null?null:String(values[5]),work_completed_at:String(values[6]),output_identity:values[7],output_digest:values[8],output_revision:String(values[9]),output_restore_generation:values[10],delivery_revision:String(BigInt(row.delivery_revision)+BigInt(values[11]))});if(sql.includes('projection=$13'))row.projection=JSON.parse(values[12]);}
    else if(sql.includes('SET delivery_ack_revision='))row.delivery_ack_revision=values[2];else assert.fail(sql);
    active.effects.add(row.tenant);events.push('UPDATE');await afterUpdate();return {rows:[],rowCount:1};
   }
   assert.fail(sql);
  },
  async readOnly(sql,values){calls.push({sql,values,transaction:null});
   if(sql.includes('/* evaluator-worker-grants */'))return {rows:[{principal:'worker_'+ordinal,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,memberships:false,uses_schema:true,creates:false,owns:false,secured:true,reads:true,forbidden:false,updates:[...require('../lib/pgstream/worker-grants').UPDATES].sort()}]};
   if(sql.includes('/* evaluator-worker-policies */')){const plan=require('../lib/pgstream/worker-grants').build({role:'worker_'+ordinal,namespace:NS,consumer:'evaluator-partition',assignment,ordinal,membershipNamespace:MEMBERSHIP}),expression=plan.find(sql=>sql.startsWith('CREATE POLICY')).split(' USING (')[1].split(') WITH CHECK')[0];return {rows:['allow','restrict'].map(kind=>({name:'pgstream_worker_'+kind+'_'+ordinal,command:'*',permissive:kind==='allow',using:expression,check:expression}))};}
   if(sql.includes('FROM pg_trigger'))return {rows:sql.includes('t.tgname AS name')?copy(instruments.assignment):copy(instruments.membership)};
   if(sql.includes('FROM pg_index'))return {rows:copy(instruments.indexes)};
   let found=[...rows.values()];
   if(sql.includes('work_owner_ordinal=$')){const ordinalIndex=Number(sql.match(/work_owner_ordinal=\$(\d+)/)[1])-1,revisionIndex=Number(sql.match(/work_assignment_revision=\$(\d+)/)[1])-1;found=found.filter(row=>row.work_owner_ordinal===values[ordinalIndex]&&row.work_assignment_revision===values[revisionIndex]);}
   if(sql.startsWith('SELECT min(work_due_at)')){const due=found.map(row=>row.work_due_at).filter(value=>value!==null).map(Number);return {rows:[{due:due.length?String(Math.min(...due)):null}]};}
   if(sql.startsWith('SELECT min(work_pending_at)'))return {rows:[{oldest:found.find(row=>row.work_pending_at!==null)?.work_pending_at??null}]};
   if(sql.includes('delivery_revision>delivery_ack_revision'))return {rows:found.filter(row=>BigInt(row.delivery_revision)>BigInt(row.delivery_ack_revision)).sort((a,b)=>a.tenant.localeCompare(b.tenant)).slice(0,values[1]).map(row=>({tenant:row.tenant,revision:row.delivery_revision}))};
   if(sql.includes('tenant_id=ANY($2::uuid[])'))return {rows:found.filter(row=>values[1].includes(row.tenant)).map(metadata)};
   if(sql.startsWith('SELECT tenant_id'))return {rows:found.filter(row=>row.work_enabled&&(row.work_pending_at!==null||row.work_due_at!==null&&Number(row.work_due_at)<=100)).sort((a,b)=>a.tenant.localeCompare(b.tenant)).slice(0,values[2]).map(metadata)};
   assert.fail(sql);
  }
 };
 if(!boundary){const hold=connection.holdAdvisoryLock.bind(connection);connection.holdAdvisoryLock=async(...args)=>{const capability=await hold(...args);delete capability.withTenantTransaction;return capability;};}
 const selection={assignment,self,membershipNamespace:MEMBERSHIP,lifecycleNamespace:LIFECYCLE,currentGeneration:()=>generation};
 const store=creator({connection,namespace:NS,consumer:'evaluator-partition',maxBytes:100000,timeIntervalMs:60000,typed:true,now:()=>100,onCommit:()=>{hints.push(events.at(-1));},...(partitioned?{partition:selection}:{})});digest=store.digest;
 for(const tenant of ids)rows.set(tenant,base(tenant));
 const owned=ids.find(id=>assignment.owner(id)===ordinal),foreign=ids.find(id=>assignment.owner(id)!==ordinal);
 return {store,rows,calls,events,keys,hints,assignment,selection,connection,instruments,owned,foreign,
  setResource:value=>{resourceHeld=value;},setGeneration:value=>{generation=value;},setLive:value=>{live=value;},setFail:value=>{failCommit=value;},beforeCommit:fn=>{beforeCommit=fn;},afterUpdate:fn=>{afterUpdate=fn;},
  result:()=>({checkpoint:1,trigger:'acquisition',properties:{synthetic:true},emitted:[],requested:[],encodedRows:[],frame:{sgvs:[],lastUpdated:10},due:{dueAt:200,slow:[]}}),
  complete:(value={})=>store.complete(owned,{observed:{clock:'1'},identity:'a'.repeat(64),result:{checkpoint:1,trigger:'acquisition',properties:{synthetic:true},emitted:[],requested:[],encodedRows:[],frame:{sgvs:[],lastUpdated:10},due:{dueAt:200,slow:[]}},restoreGeneration:'7',...value})};
}
it('optional partition forwarding keeps stable consumer, distinct ordinal keys, exact revision and filters before bounded work/delivery pages',async()=>{
 const a=fixture(),b=fixture({ordinal:1});await a.store.own(()=>{});await b.store.own(()=>{});assert.equal(a.store.consumer,b.store.consumer);assert.notEqual(a.keys[0],b.keys[0]);
 const rows=await a.store.work(64);assert(rows.length&&rows.every(row=>a.assignment.owner(row.tenant)===0));assert.equal(rows.length,Math.min(64,ids.filter(id=>a.assignment.owner(id)===0).length));
 a.rows.get(a.owned).work_due_at='200';a.rows.get(a.foreign).work_due_at='100';assert.equal(await a.store.nextDue(),200);
 a.rows.get(a.owned).delivery_revision='1';a.rows.get(a.foreign).delivery_revision='1';assert.deepEqual(await a.store.deliveries(),[{tenant:a.owned,revision:'1'}]);
 for(const call of a.calls.filter(call=>call.sql&&(/SELECT tenant_id|SELECT min\(work_/.test(call.sql)))){assert(call.sql.includes('work_owner_ordinal=$')&&call.sql.includes('work_assignment_revision=$'));assert(call.values.includes(REV));}
 await assert.rejects(a.store.work(65),/Bounded/);await assert.rejects(a.store.deliveries(65),/Bounded/);
 await a.store.admit([a.owned].values());assert(!a.calls.some(call=>call.admission));await a.store.close();await b.store.close();
});
it('owner completion retains newer input and due work, commits before hint, and ACK uses same guarded backend transaction',async()=>{
 const f=fixture();await f.store.own(()=>{});f.rows.get(f.owned).work_observed=work.array({clock:'2'});
 const completed=await f.complete();assert.equal(completed.pendingAt,10);assert.deepEqual(work.map(f.rows.get(f.owned).work_completed),{clock:'1'});assert.equal(f.rows.get(f.owned).work_due_at,'200');assert.deepEqual(f.hints,['COMMIT']);
 await f.store.acknowledge(f.owned,'1');assert.equal(f.rows.get(f.owned).delivery_ack_revision,'1');assert(f.calls.filter(call=>call.sql?.startsWith('UPDATE')).every(call=>call.transaction));await f.store.close();
});
it('unassigned/wrong revision rows, foreign tenant, changed restore, final lease loss and unconfirmed COMMIT refuse with no hint or durable progress',async()=>{
 for(const phase of ['unassigned','revision','foreign','restore','final-lease','deferred-expiry','deferred-restore','deferred-owner-resource','commit']){
  const f=fixture();await f.store.own(()=>{});if(phase==='unassigned')f.rows.get(f.owned).work_owner_ordinal=null;if(phase==='revision')f.rows.get(f.owned).work_assignment_revision='1';if(phase==='restore')f.setGeneration('8');if(phase==='final-lease')f.afterUpdate(()=>f.setLive(false));if(phase==='deferred-expiry')f.beforeCommit(()=>f.setLive(false));if(phase==='deferred-restore')f.beforeCommit(()=>f.setGeneration('8'));if(phase==='deferred-owner-resource')f.beforeCommit(()=>f.setResource(false));if(phase==='commit')f.setFail(true);
  const before=copy(f.rows.get(f.owned));const action=phase==='foreign'?()=>f.store.complete(f.foreign,{observed:{clock:'1'},identity:'a'.repeat(64),result:f.result(),restoreGeneration:'7'}):()=>f.complete();
  await assert.rejects(action());assert.deepEqual(f.rows.get(f.owned),before,phase);assert.deepEqual(f.hints,[],phase);await f.store.close();
 }
});
it('legacy/default typed writer cannot complete assigned rows in the enforcing model; removal of that actual model trigger makes the refusal criterion red',async()=>{
 async function qualify(enforce){const f=fixture({partitioned:false,enforceOldWriter:enforce});await f.store.own(()=>{});try{await assert.rejects(f.complete(),/MODEL_ASSIGNED_EFFECT_REFUSED/);assert.deepEqual(f.hints,[]);}finally{await f.store.close();}}
 await qualify(true);await assert.rejects(qualify(false),{code:'ERR_ASSERTION'});await qualify(true);
});
it('candidate binds selected namespaces without metadata table, adds deferred effect trigger and preserves standalone NULL columns/catalogue prefix',async()=>{
 const {validateCatalogue}=require('../lib/migrations/catalogue'),base=require('../migrations/candidates/postgres-evaluator-work-v2.json'),a=candidate.build({membershipNamespace:MEMBERSHIP,lifecycleNamespace:LIFECYCLE}),b=candidate.build({membershipNamespace:'other_membership',lifecycleNamespace:LIFECYCLE});
 assert.equal(validateCatalogue(a.catalogue).length,3);assert.deepEqual(a.catalogue.migrations.slice(0,2),base.migrations);assert.notEqual(a.catalogue.migrations[2].checksum,b.catalogue.migrations[2].checksum);
 assert(a.effectBody.includes('FROM "'+MEMBERSHIP+'".pool_membership'));assert(a.effectBody.includes('FROM "'+LIFECYCLE+'".tenant_lifecycle_windows'));assert(a.effectBody.includes('EVALUATOR_ASSIGNED_OWNER_RESOURCE'));assert(a.effectBody.startsWith('\n')&&a.effectBody.endsWith('\n'));assert(!a.effectBody.includes('context->>\'namespace\''));assert(a.catalogue.migrations[2].up.some(sql=>sql.includes('DEFERRABLE INITIALLY DEFERRED')));assert(!a.catalogue.migrations[2].up.some(sql=>sql.startsWith('CREATE TABLE')));
 assert.throws(()=>candidate.build({membershipNamespace:'bad"name',lifecycleNamespace:LIFECYCLE}),/NAMESPACE/);
 const f=fixture();f.instruments.assignment[0].source=b.assignmentBody;await assert.rejects(f.store.own(()=>{}),/PROTOCOL_UNQUALIFIED/);assert.equal(f.store.available,false);
 const g=fixture();g.instruments.indexes.pop();await assert.rejects(g.store.own(()=>{}),/INDEX_UNQUALIFIED/);assert.equal(g.store.available,false);
});
it('standalone unassigned rows still use global owner and original completion path',async()=>{
 const f=fixture({partitioned:false});for(const row of f.rows.values()){row.work_owner_ordinal=null;row.work_assignment_revision=null;}await f.store.own(()=>{});await f.complete({restoreGeneration:null});assert.deepEqual(f.hints,['COMMIT']);assert(!f.calls.some(call=>call.sql?.includes('app.pgstream_partition_effect')));await f.store.close();
});
it('control: removing the SQL owner filter breaks the owned-page criterion before results can be silently discarded; restoration passes',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/pgstream/typed-checkpoint'),source=fs.readFileSync(file,'utf8');
 const needle="' WHERE consumer=$1 AND work_version=2 AND work_enabled'+assignment.sql+' AND (work_pending_at";
 assert.equal(source.split(needle).length,2);const broken={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,"' WHERE consumer=$1 AND work_version=2 AND work_enabled'+' AND (work_pending_at")+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
 async function qualify(creator){const f=fixture({creator});try{await f.store.own(()=>{});const rows=await f.store.work();assert(rows.length&&rows.every(row=>f.assignment.owner(row.tenant)===0),'only assigned page rows');}finally{await f.store.close();}}
 await assert.rejects(qualify(options=>broken.exports.create(options)),/ASSIGNMENT_REFUSED|only assigned/);await qualify(checkpoint.create);
});
it('per-ordinal owner resource is stable when fixed revision changes; namespace/consumer/ordinal still distinguish it',()=>{
 const configure=require('../lib/pgstream/partition-work').configure,assignment=fixed.create({tenants:ids,members:2,revision:'1'}),other=fixed.create({tenants:ids,members:2,revision:'2'});
 const selection={assignment,self:{ordinal:0,memberId:ids[0],rule:RULE},membershipNamespace:MEMBERSHIP,lifecycleNamespace:LIFECYCLE,currentGeneration:()=> '7'};
 const key=(partition,namespace=NS,consumer='evaluator-partition')=>configure(partition,{namespace,consumer}).key;
 assert.equal(key(selection),key({...selection,assignment:other}));assert.notEqual(key(selection),key({...selection,self:{...selection.self,ordinal:1}}));assert.notEqual(key(selection),key(selection,'other_checkpoint'));assert.notEqual(key(selection),key(selection,NS,'evaluator-other'));
});

it('selected effects require the explicit owner COMMIT capability and cannot silently fall back to ordinary withTenant',async()=>{
 const missing=fixture({boundary:false});await assert.rejects(missing.store.own(()=>{}),/OWNER_BOUNDARY_REQUIRED/);assert.equal(missing.store.available,false);assert.equal(missing.calls.length,0);
 const f=fixture();await f.store.own(()=>{});await f.complete();await f.store.acknowledge(f.owned,'1');assert.equal(f.events.filter(event=>event==='EXPLICIT_BOUNDARY').length,2);await f.store.close();
});

it('selected worker refuses input APIs before any SQL; standalone observation remains available',async()=>{
 const selected=fixture();await assert.rejects(selected.store.observe(selected.owned,'clock','2'),/WORKER_OBSERVATION_REFUSED/);await assert.rejects(selected.store.observeMany([{tenant:selected.owned,observed:{clock:'2'}}]),/WORKER_OBSERVATION_REFUSED/);assert.deepEqual(selected.calls,[]);
 const standalone=fixture({partitioned:false});await standalone.store.observe(standalone.owned,'clock','2');await standalone.store.observeMany([{tenant:standalone.owned,observed:{clock:'3'}}]);assert.equal(standalone.calls.filter(call=>call.observation).length,2);
});
it('selected admission validates existing assignment without conversion; missing/foreign/version/assignment rows refuse',async()=>{
 for(const kind of ['missing','foreign','version','assignment','valid']){const f=fixture();if(kind==='missing')f.rows.delete(f.owned);if(kind==='version')f.rows.get(f.owned).work_version=0;if(kind==='assignment')f.rows.get(f.owned).work_owner_ordinal=1;const admission=()=>f.store.admit([kind==='foreign'?f.foreign:f.owned]);if(kind==='valid')await admission();else await assert.rejects(admission());assert(!f.calls.some(call=>call.admission||call.sql?.startsWith('UPDATE')));}
});
it('selected completion cannot erase an already completed source omitted by its caller',async()=>{
 const f=fixture();f.rows.get(f.owned).work_completed=work.array({clock:'1'});await f.store.own(()=>{});await assert.rejects(f.complete({observed:{}}),/COMPLETION_VERSION_REFUSED/);assert(!f.calls.some(call=>call.sql?.startsWith('UPDATE')));assert.deepEqual(f.hints,[]);await f.store.close();
});
it('completion and ACK select distinct guarded operation transitions on their held transaction',async()=>{
 const f=fixture();await f.store.own(()=>{});await f.complete();await f.store.acknowledge(f.owned,'1');assert.deepEqual(f.calls.filter(call=>call.sql?.includes("set_config('app.pgstream_partition_effect'")).map(call=>JSON.parse(call.values[0]).operation),['complete','ack']);await f.store.close();
});
it('control: removing selected observation refusal exposes input writes; restored actual module refuses',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../lib/pgstream/typed-checkpoint'),source=fs.readFileSync(file,'utf8'),needle="if(selected)throw new Error('EVALUATOR_WORKER_OBSERVATION_REFUSED');",broken={exports:{}};assert.equal(source.split(needle).length,3);vm.runInThisContext('(function(require,module,exports){'+source.replaceAll(needle,'')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
 async function criterion(creator){const f=fixture({creator});await assert.rejects(f.store.observe(f.owned,'clock','2'),/WORKER_OBSERVATION_REFUSED/);assert(!f.calls.some(call=>call.observation));}await assert.rejects(criterion(options=>broken.exports.create(options)),{code:'ERR_ASSERTION'});await criterion(checkpoint.create);
});
it('selected readiness refuses observation grants and missing/foreign policies; restoration admits',async()=>{
 const grants=require('../lib/pgstream/worker-grants');for(const kind of ['input-grant','missing-policy','foreign-policy','valid']){const f=fixture(),read=f.connection.readOnly.bind(f.connection);f.connection.readOnly=async(sql,values)=>{const result=await read(sql,values);if(kind==='input-grant'&&sql.includes('/* evaluator-worker-grants */'))result.rows[0].updates.push('work_observed');if(kind==='missing-policy'&&sql.includes('/* evaluator-worker-policies */'))result.rows.pop();if(kind==='foreign-policy'&&sql.includes('/* evaluator-worker-policies */'))result.rows[0].using='true';return result;};if(kind==='valid'){await f.store.own(()=>{});await f.store.close();}else{await assert.rejects(f.store.own(()=>{}),/WORKER_GRANTS_REFUSED|WORKER_POLICY_REFUSED/);assert.equal(f.store.available,false);}}
 assert(grants.UPDATES.includes('contract_digest'),'base-consumer replay still needs contract update');assert(grants.UPDATES.includes('work_pending_at'));assert(grants.UPDATES.includes('delivery_revision'));assert(grants.INPUT_COLUMNS.every(column=>!grants.UPDATES.includes(column)));
});

it('selected TIME-only completion advances due without inventing input or a new output delivery',async()=>{
 const f=fixture();await f.store.own(()=>{});await f.complete();await f.store.acknowledge(f.owned,'1');const before=copy(f.rows.get(f.owned));const result={...f.result(),trigger:'time-only',due:{dueAt:300,slow:[]}};const next=await f.complete({result});const after=f.rows.get(f.owned);assert.equal(next.changed,false);assert.deepEqual(after.work_observed,before.work_observed);assert.deepEqual(after.work_observed_at,before.work_observed_at);assert.deepEqual(after.work_completed,before.work_completed);assert.equal(after.work_pending_at,null);assert.equal(after.work_due_at,'300');assert.equal(after.delivery_revision,before.delivery_revision);assert.equal(after.delivery_ack_revision,'1');assert(!f.calls.some(call=>call.observation));assert.equal(f.events.filter(event=>event==='EXPLICIT_BOUNDARY').length,3);await f.store.close();
});

it('cold worker admission refuses the older NULL-skipping aggregate body; exact restored protocol admits',async()=>{
 const f=fixture(),old='bool_and(ordinal>=0 AND ordinal<desired.members AND applied_members=desired.members AND slice_rule=desired.slice_rule)',current='bool_and(coalesce(ordinal>=0 AND ordinal<desired.members AND applied_members=desired.members AND slice_rule=desired.slice_rule,false))';const body=f.instruments.assignment[1].source;assert(body.includes(current));f.instruments.assignment[1].source=body.replace(current,old);await assert.rejects(f.store.own(()=>{}),/PROTOCOL_UNQUALIFIED/);assert.equal(f.store.available,false);f.instruments.assignment[1].source=body;await f.store.own(()=>{});await f.store.close();
});
