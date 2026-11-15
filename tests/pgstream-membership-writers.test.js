'use strict';
// Executes actual membership/operator modules with a recording SQL client.
// No database, row-lock semantics, trigger execution or lease clock is modeled.
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
const protocol=require('../lib/pool-membership/fixed-protocol');
const {RULE}=require('../lib/pool-membership/slice');
function load(file,overrides){const module={exports:{}},local=createRequire(file);vm.runInThisContext('(function(require,module,exports){'+fs.readFileSync(file,'utf8')+'\n})',{filename:file})(name=>Object.hasOwn(overrides,name)?overrides[name]:local(name),module,module.exports);return module.exports;}
function fixture(capability='member',brokenLock=false){
 const calls=[],releases=[],migration=[];let expired=false,desired=null,id=null,xid=0,commit='COMMIT';
 const selected=capability==='member'?{pool_membership:[true,true,['applied_members','heartbeat_at','lease_expires_at']],pool_desired:[false,false,[]]}:{pool_membership:[false,false,[]],pool_desired:[true,false,['members','previous_members','revision','slice_rule','updated_at']]};
 const installed=['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:protocol.BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}));
 const query=async(text,values)=>{
  calls.push({text,values});
  if(text.includes('has_table_privilege')){const table=values[0].split('.').at(-1),[inserts,deletes,updates]=selected[table];return {rows:[{owns:false,destroys:false,reads:true,inserts,deletes,updates:[...updates].sort()}]};}
  if(text.includes('FROM pg_trigger'))return {rows:installed};
  if(text==='BEGIN'){xid++;return {rows:[]};}
  if(text==='COMMIT')return {rows:[],command:commit};
  if(text==='ROLLBACK')return {rows:[],command:'ROLLBACK'};
  if(text.includes('pg_advisory_xact_lock'))return {rows:[{backend_pid:41,transaction_id:String(xid)}]};
  if(text.startsWith('INSERT INTO')&&text.includes('pool_membership')){id=values[2];return {rows:[],rowCount:1};}
  if(text.startsWith('UPDATE')&&text.includes('pool_membership'))return {rows:[],rowCount:expired?0:1};
  if(text.startsWith('INSERT INTO')&&text.includes('pool_desired')){desired={members:values[1],rule:RULE,revision:'1'};return {rows:[{pool_kind:'evaluator'}],rowCount:1};}
  if(text.startsWith('SELECT members FROM'))return {rows:[{members:desired.members}]};
  if(text.includes('AS desired')&&text.includes('AS rows'))return {rows:[{desired,rows:id?[{ordinal:0,memberId:id,rule:RULE,live:!expired,leaseRemainingMs:1,heartbeatAgeMs:0}]:[]}]};
  return {rows:[],rowCount:1};
 };
 const client={query,release:error=>releases.push(error)};
 class Pool{on(){}query(...args){return query(...args);}async connect(){return client;}async end(){}}
 const lock=require('../lib/pool-membership/transaction-lock');
 const postgres=load(require.resolve('../lib/pool-membership/postgres'),{
  pg:{Pool,Client:class{}},'../storage/connection-admission':{wrapPool:value=>value,poolOptions:(_name,value)=>value},
  '../migrations/postgres':{run:async(action,options)=>migration.push({action,options})},'../diagnostics/m7':{observePool(){}},
  './transaction-lock':brokenLock?{lock:async()=>{}}:lock
 });
 const operator=load(require.resolve('../lib/pool-membership/operator'),{'./postgres':postgres,'./transaction-lock':brokenLock?{lock:async()=>{}}:lock});
 return {postgres,operator,calls,releases,migration,setExpired:value=>{expired=value;},setCommit:value=>{commit=value;}};
}
function lockedTransactions(calls){
 const sql=calls.map(row=>row.text);let active=false,locked=false;
 for(const text of sql){if(text==='BEGIN'){active=true;locked=false;}else if(text.includes('pg_advisory_xact_lock')){assert(active);assert(!text.includes('_shared'));locked=true;}else if(/^(INSERT|UPDATE|DELETE)/.test(text)){assert(active&&locked,'membership/desired mutation must follow exclusive lock in transaction');}else if(text==='COMMIT'||text==='ROLLBACK'){active=false;}}
}
it('all actual member writers take exclusive transaction lock; fixed heartbeat cannot resurrect expired incarnation',async()=>{
 const f=fixture(),member=await f.postgres.create({kind:'evaluator',ordinal:0,leaseMs:5000,connectionString:'synthetic',namespace:'test_membership',fixedProtocol:true,onAlert:()=>{}});
 await member.register();assert.deepEqual(await member.heartbeat(),{renewed:true});
 f.setExpired(true);assert.deepEqual(await member.heartbeat(),{renewed:false,reason:'POOL_INCARNATION_EXPIRED'});
 const count=f.calls.length;assert.deepEqual(await member.heartbeat(),{renewed:false,reason:'POOL_INCARNATION_EXPIRED'});assert.equal(f.calls.length,count);
 await assert.rejects(member.register(),{code:'POOL_INCARNATION_EXPIRED'});await member.close();lockedTransactions(f.calls);
 assert.equal(f.calls.filter(row=>row.text.startsWith('INSERT INTO')&&row.text.includes('pool_membership')).length,1);
 assert(f.calls.filter(row=>row.text.startsWith('UPDATE')).every(row=>row.text.includes('lease_expires_at>clock_timestamp()')));
 assert.equal(f.migration[0].action,'check');assert.equal(f.migration[0].options.catalogue.migrations.at(-1).name,'0004_pool_mutation_function_execution');
});
it('generic member behavior remains selectable and new operator writes cooperate without any desired grant change',async()=>{
 const f=fixture(),member=await f.postgres.create({kind:'evaluator',ordinal:0,leaseMs:5000,connectionString:'synthetic',namespace:'test_membership',onAlert:()=>{}});
 await member.register();f.setExpired(true);assert.deepEqual(await member.heartbeat(),{renewed:true});await member.close();lockedTransactions(f.calls);
 assert.equal(f.migration[0].options.catalogue.migrations.length,2);
 const o=fixture('operator'),operator=await o.operator.create({connectionString:'synthetic',namespace:'test_membership',kinds:['evaluator']});
 assert.equal((await operator.setMembers('evaluator',2)).outcome,'applied');await operator.close();lockedTransactions(o.calls);
 const grants=f.postgres.grants({namespace:'test_membership',member:'synthetic_member'});
 assert(!grants.some(sql=>sql.startsWith('GRANT UPDATE')&&sql.includes('pool_desired')));
});
it('unconfirmed membership COMMIT evicts client and cannot report registered',async()=>{
 const f=fixture(),member=await f.postgres.create({kind:'evaluator',ordinal:0,leaseMs:5000,connectionString:'synthetic',namespace:'test_membership',onAlert:()=>{}});
 f.setCommit('ROLLBACK');await assert.rejects(member.register(),{code:'POOL_UNAVAILABLE'});assert(f.releases.some(Boolean));
 assert.deepEqual(await member.heartbeat(),{renewed:false,reason:'POOL_NOT_REGISTERED'});await member.close();
});
it('fixed registration cannot reuse its incarnation after an unconfirmed registration transaction',async()=>{
 const f=fixture(),member=await f.postgres.create({kind:'evaluator',ordinal:0,leaseMs:5000,connectionString:'synthetic',namespace:'test_membership',fixedProtocol:true,onAlert:()=>{}});
 f.setCommit('ROLLBACK');await assert.rejects(member.register(),{code:'POOL_UNAVAILABLE'});f.setCommit('COMMIT');
 const count=f.calls.length;await assert.rejects(member.register(),{code:'POOL_INCARNATION_UNCERTAIN'});assert.equal(f.calls.length,count);await member.close();
});
it('control: omit exclusive writer lock; actual mutation ordering criterion turns red then restores',async()=>{
 async function qualify(broken){const f=fixture('member',broken),member=await f.postgres.create({kind:'evaluator',ordinal:0,leaseMs:5000,connectionString:'synthetic',namespace:'test_membership',onAlert:()=>{}});await member.register();await member.close();lockedTransactions(f.calls);}
 await assert.rejects(qualify(true),{code:'ERR_ASSERTION'});await qualify(false);
});
it('optional migration checksum/prefix and lock key are exact and default catalogue is unchanged',()=>{
 const {validateCatalogue}=require('../lib/migrations/catalogue'),catalogue=require('../migrations/candidates/postgres-pool-mutation-v1.json'),base=require('../lib/pool-membership/postgres-candidate.json');
 assert.equal(validateCatalogue(catalogue).length,4);
 assert.equal(catalogue.migrations[2].name,'0003_pool_mutation_protocol');
 assert.deepEqual(catalogue.migrations[3].up,['REVOKE EXECUTE ON FUNCTION pool_mutation_lock_required() FROM PUBLIC']);assert.deepEqual(catalogue.migrations.slice(0,2),base.migrations);
 const lock=require('../lib/pool-membership/transaction-lock'),bytes=require('node:crypto').createHash('sha256').update('nightscout:pool-membership:xact:v1:test_membership:evaluator').digest();
 assert.deepEqual(lock.key('test_membership','evaluator'),[bytes.readInt32BE(0),bytes.readInt32BE(4)]);
 assert.notDeepEqual(lock.key('test_membership','evaluator'),lock.key('test_membership','vcpool'));assert.notDeepEqual(lock.key('test_membership','evaluator'),lock.key('another_membership','evaluator'));
 assert(protocol.BODY.includes('objsubid=2')&&protocol.BODY.includes("mode='ExclusiveLock'"));
});
