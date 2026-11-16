'use strict';
// Source I/O controls; native PostgreSQL trigger and COMMIT behavior is unmeasured here.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const path=require('node:path');
const candidate=require('../lib/tenant-notifications/pool-partition-candidate'),legacy=require('../lib/tenant-notifications/partition-candidate');
const profiles=require('../lib/pgstream/pool-intake-profile'),views=require('../lib/pgstream/pool-assignment'),grants=require('../lib/tenant-notifications/partition-grants');
const {RULE}=require('../lib/pool-membership/slice');
const binding={checkpointNamespace:'test_checkpoint',membershipNamespace:'test_membership',lifecycleNamespace:'test_control',consumer:'synthetic',evaluatorConsumer:'evaluator-synthetic-completed'};
const profile=profiles.create({namespace:binding.checkpointNamespace,membershipNamespace:binding.membershipNamespace,lifecycleNamespace:binding.lifecycleNamespace,consumer:'evaluator-synthetic',role:'intake_writer',operatorRole:'intake_operator',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:RULE});
const ids=Array.from({length:100},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
function load(file,overrides={},mutate=x=>x){const filename=path.resolve(__dirname,'..',file),requireSource=createRequire(filename),module={exports:{}};vm.runInNewContext('(function(require,module,exports){'+mutate(fs.readFileSync(filename,'utf8'))+'\n})',{Buffer})(key=>overrides[key]||requireSource(key),module,module.exports);return module.exports;}
function fixture({partitioned=true,members=3,ordinal=0,memberId=ids[ordinal],mutate}={}){
 let current={partitioned,members,revision:'9',rule:RULE},desired={...current},rows=partitioned?Array.from({length:members},(_,i)=>({ordinal:i,memberId:ids[i],live:true,rule:RULE,appliedMembers:members})):[],assigned='9',pid=41,active=false,held=false,loss,generation='7';
 const assignment=views.view({current:()=>current}),self={ordinal,memberId,rule:RULE},events=[],contexts=[];
 const guard=load('lib/pgstream/pool-effect-fence.js',{'../pool-membership/pool-candidate':{async assertInstalled(){events.push('POOL5');}}});
 const owner=load('lib/tenant-notifications/partition-owner.js',{'./partition-grants':{async assertReady(read,b,p){assert.equal(p,profile);events.push('GRANTS');}},'./partition-protocol':{async assertInstalled(read,n,b,p){assert.equal(p,profile);events.push('OUTBOX5');}},'../pgstream/assignment-protocol':{async assertInstalled(read,options){assert.equal(options.poolProfile,profile);assert.equal(options.poolIntake,true);events.push('CHECKPOINT');}},'../pgstream/pool-effect-fence':guard},mutate);
 const selection=owner.configure({...binding,intakeProfile:profile,assignment,self,currentGeneration:()=>generation},'test_outbox');
 const connection={async readOnly(){assert.fail('unexpected unchecked read');},async holdAdvisoryLock(key,onLoss){held=true;loss=onLoss;return {backendPid:41,get available(){return held;},async check(){assert(held);},async close(){held=false;},async withTenantTransaction(tenant,fn){assert(!active);active=true;events.push('BEGIN');try{const value=await fn();events.push('COMMIT');return value;}catch(error){events.push('ROLLBACK');throw error;}finally{active=false;}}};},async query(sql,values){assert(active);const identity={backend_pid:pid,transaction_id:'13'};
  if(sql.includes('pg_advisory_xact_lock_shared'))return {rows:[identity]};
  if(sql.includes('.pool_desired'))return {rows:[{...identity,...desired}]};
  if(sql.includes('json_agg(json_build_object'))return {rows:[{...identity,members:rows}]};
  if(sql.includes('SELECT work_owner_ordinal'))return {rows:[{work_owner_ordinal:ordinal,work_assignment_revision:assigned}]};
  if(sql.includes('set_config')){contexts.push(JSON.parse(values[0]));return {rows:[]};}assert.fail(sql);
 }};
 return {selection,connection,events,contexts,self,assignment,tenant:ids.find(id=>assignment.owner(id)===ordinal),setCurrent(value){current={...current,...value};},setDesired(value){desired={...desired,...value};},setRows(value){rows=value;},get rows(){return rows;},assigned(value){assigned=value;},pid(value){pid=value;},generation(value){generation=value;},lose(){held=false;loss();}};
}
describe('live pool notification partition source',()=>{
 it('appends only migration five and preserves all-table before and deferred source/lock identities',()=>{
  const built=candidate.build({binding,intakeProfile:profile}),old=legacy.build(binding);
  assert.deepEqual(built.catalogue.migrations.slice(0,4),old.catalogue.migrations);assert.equal(candidate.expectedMigrations(built.catalogue).length,5);
  for(const needle of ["jsonb_typeof(context->'partitioned') IS DISTINCT FROM 'boolean'","context->>'partitioned' IS DISTINCT FROM desired.partitioned::text",'desired.members>1024',"context->'memberId' IS DISTINCT FROM 'null'::jsonb",'roster.selves<>1','roster.live_count<>desired.members',"context->>'revision' IS DISTINCT FROM assignment.revision","context->>'backendPid' IS DISTINCT FROM pg_backend_pid()::text","context->>'transactionId' IS DISTINCT FROM pg_current_xact_id()::text",'NOTIFICATION_ASSIGNED_OWNER_RESOURCE','NOTIFICATION_ASSIGNED_SHARED_REQUIRED','NOTIFICATION_ASSIGNED_CHECKPOINT',"lifetime.generation IS DISTINCT FROM context->>'restoreGeneration'",'EXCEPTION WHEN OTHERS THEN','lifetime_found:=FOUND;'])assert(built.body.includes(needle),needle);
  assert.equal((old.catalogue.migrations[2].up.join('\n').match(/CREATE CONSTRAINT TRIGGER/g)||[]).length,3);
  assert.equal((built.body.match(/set_config\('app.current_tenant_id',coalesce\(previous_tenant,''\),true\)/g)||[]).length,2);
  assert.throws(()=>candidate.build({binding:{...binding,evaluatorConsumer:'evaluator-other-completed'},intakeProfile:profile}),/PROFILE_BINDING/);
 });
 it('requires a branded live view and keeps the ordinal key stable across epochs and singleton mode',()=>{
  const a=fixture(),b=fixture({partitioned:false,members:1,memberId:null});assert.equal(a.selection.key,b.selection.key);
  assert.throws(()=>require('../lib/tenant-notifications/partition-owner').configure({...binding,intakeProfile:profile,assignment:{members:3,revision:'9',select(){},owner(){}},self:a.self,currentGeneration:()=> '7'},'test_outbox'),/VIEW_SOURCE_REQUIRED/);
 });
 it('admits full current N on the held PID, follows live revision, and stamps primitive mode',async()=>{
  const f=fixture();await f.selection.own(f.connection);assert.deepEqual(f.events,['GRANTS','OUTBOX5','CHECKPOINT','POOL5']);
  await f.selection.transaction(f.connection,f.tenant,async()=>{});assert.equal(f.contexts[0].partitioned,true);
  f.setCurrent({revision:'10'});f.setDesired({revision:'10'});f.assigned('10');await f.selection.transaction(f.connection,f.tenant,async()=>{});assert.equal(f.contexts.at(-1).revision,'10');await f.selection.close();
 });
 it('supports an ordinal above the old two-member ceiling and derives null identity eligibility at admission',async()=>{
  const f=fixture({ordinal:2});await f.selection.own(f.connection);await f.selection.transaction(f.connection,f.tenant,async()=>{});assert.equal(f.contexts[0].ordinal,2);await f.selection.close();
  for(const options of [{memberId:null},{partitioned:false,members:1,memberId:ids[0]}]){const g=fixture(options);await g.selection.own(g.connection);await assert.rejects(g.selection.transaction(g.connection,g.tenant,async()=>{}),/MEMBERSHIP_REFUSED/);await g.selection.close();}
 });
 it('admits no-member singleton and refuses a live incarnation or wrong actual mode/epoch/PID',async()=>{
  const f=fixture({partitioned:false,members:1,memberId:null});await f.selection.own(f.connection);await f.selection.transaction(f.connection,f.tenant,async()=>{});assert.equal(f.contexts[0].memberId,null);assert.equal(f.contexts[0].partitioned,false);
  f.setRows([{ordinal:0,memberId:ids[0],rule:RULE,appliedMembers:1,live:true}]);await assert.rejects(f.selection.transaction(f.connection,f.tenant,async()=>{}),/MEMBERSHIP_REFUSED/);f.setRows([]);
  for(const desired of [{partitioned:true},{revision:'10'},{members:2}]){f.setDesired(desired);await assert.rejects(f.selection.transaction(f.connection,f.tenant,async()=>{}),/MEMBERSHIP_REFUSED/);f.setDesired({partitioned:false,revision:'9',members:1});}
  f.pid(42);await assert.rejects(f.selection.transaction(f.connection,f.tenant,async()=>{}),/OWNER_TRANSACTION/);await f.selection.close();
 });
 it('refuses missing, duplicate, unapplied and changed self incarnations and stale checkpoints',async()=>{
  for(const change of [rows=>rows.slice(1),rows=>[...rows,rows[0]],rows=>rows.map((r,i)=>i?{...r,appliedMembers:null}:r),rows=>rows.map((r,i)=>i? r:{...r,memberId:ids[9]})]){const f=fixture();await f.selection.own(f.connection);f.setRows(change(f.rows));await assert.rejects(f.selection.transaction(f.connection,f.tenant,async()=>{}),/MEMBERSHIP_REFUSED/);await f.selection.close();}
  const f=fixture();await f.selection.own(f.connection);f.assigned('8');assert.equal(await f.selection.beforeSend(f.connection,f.tenant),false);await f.selection.close();
 });
 it('rechecks the actual final pre-send context and live incarnation before permission returns',async()=>{
  for(const change of [f=>f.generation('8'),f=>f.setRows(f.rows.slice(1)),f=>f.lose()]){const f=fixture();await f.selection.own(f.connection);assert.equal(await f.selection.beforeSend(f.connection,f.tenant,async()=>change(f)),false);assert.equal(f.events.at(-1),'ROLLBACK');await f.selection.close();}
 });
 it('cold admission requires exact v2 source on all six before/deferred triggers',async()=>{
  const protocol=require('../lib/tenant-notifications/partition-protocol'),body=candidate.build({binding,intakeProfile:profile}).body;
  const rows=legacy.TABLES.flatMap(table_name=>['notification_partition_effect','notification_partition_commit'].map(name=>{const deferred=name.endsWith('commit');return {table_name,name,type:deferred?29:31,enabled:'A',deferrable:deferred,deferred,arguments:0,unconditional:true,column_count:0,source:body,function_name:'pgstream_notification_partition',function_arguments:0,trigger_result:true,definer:false,language:'plpgsql',config:['search_path=pg_catalog']};}));
  await protocol.assertInstalled(async()=>({rows}),'test_outbox',binding,profile);
  for(const omission of [" OR context->>'partitioned' IS DISTINCT FROM desired.partitioned::text"," OR context->>'revision' IS DISTINCT FROM assignment.revision",' OR roster.selves<>1']){
   assert(body.includes(omission));const changed=rows.map(row=>({...row,source:row.source.replace(omission,'')}));await assert.rejects(protocol.assertInstalled(async()=>({rows:changed}),'test_outbox',binding,profile),/PROTOCOL_UNQUALIFIED/);
  }
  await assert.rejects(protocol.assertInstalled(async()=>({rows:rows.slice(1)}),'test_outbox',binding,profile),/PROTOCOL_UNQUALIFIED/);
 });
 it('grants only seven desired columns and the exact membership ledger in v2',async()=>{
  const plan=grants.build({...binding,outboxRole:'outbox_writer',intakeProfile:profile}).join('\n');assert(plan.includes('partitioned,previous_partitioned'));assert(plan.includes('SELECT(name,checksum) ON "test_membership".schema_migrations'));assert(!/INSERT|UPDATE|DELETE/.test(plan));
  const old=grants.build({...binding,outboxRole:'outbox_writer'}).join('\n');assert(!old.includes('schema_migrations'));assert(!old.includes('partitioned'));
  const columns={pool_membership:grants.MEMBERS,pool_desired:grants.POOL_DESIRED,tenant_consumer_checkpoint:grants.ASSIGNMENT,schema_migrations:grants.LEDGER},seen=[];
  const query=async(sql,values)=>{seen.push(values[1]);return {rows:[{uses_schema:true,creates:false,owns:false,broad_reads:false,writes:false,reads:[...columns[values[1]]].sort()}]};};
  await grants.assertReady(query,binding,profile);assert.deepEqual(seen,Object.keys(columns));
  await assert.rejects(grants.assertReady(async(sql,values)=>{const result=await query(sql,values);if(values[1]==='schema_migrations')result.rows[0].reads.push('extra');return result;},binding,profile),/GRANTS_REFUSED/);

 });
});
