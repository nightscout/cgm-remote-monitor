'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const fixed=require('../lib/pgstream/fixed-assignment'),fence=require('../lib/pgstream/effect-fence');
const protocol=require('../lib/pool-membership/fixed-protocol'),transactionLock=require('../lib/pool-membership/transaction-lock');
const {RULE}=require('../lib/pool-membership/slice');
const ids=Array.from({length:16},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const assignment=fixed.create({tenants:ids,members:2,revision:'9007199254740993'});
const self={ordinal:0,memberId:ids[0],rule:RULE};
const desired={members:2,rule:RULE,revision:'9007199254740993',backend_pid:41,transaction_id:'501'};
const members=[0,1].map(ordinal=>({ordinal,memberId:ids[ordinal],rule:RULE,live:true,appliedMembers:2}));
const tenant=ids.find(id=>assignment.owner(id)===0);
const installed=()=>['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:protocol.BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}));
const guard=()=>fence.open({namespace:'test_membership',assignment,self,backendPid:41,query:async()=>({rows:installed()})});
function queryWith(patch={},events=[]){return async(sql,values)=>{
 events.push(sql);
 if(sql.includes('pg_advisory_xact_lock')){assert.deepEqual(values,transactionLock.key('test_membership','evaluator'));return {rows:[{backend_pid:41,transaction_id:'501',...patch.lock}]};}
 assert.deepEqual(values,['evaluator']);
 return {rows:[sql.includes('FROM "test_membership".pool_desired')?{...desired,...patch.desired}:{backend_pid:41,transaction_id:'501',members,...patch.snapshot}]};
};}
it('held-owner nesting refuses a foreign backend while ordinary and same-owner nesting remain supported; ablation goes red',async()=>{
 const file=require.resolve('../lib/storage/postgres-connection'),source=fs.readFileSync(file,'utf8');
 const start=source.indexOf('  async function run (tenant, fn, begin = '),end=source.indexOf('\n  }\n',start)+5,body=source.slice(start,end).trimEnd();
 assert(start>=0&&end>start&&body.endsWith('\n  }')&&body.includes('return outcome;'));
 const held={},outer={client:{}};let effects=0;
 const compile=text=>new Function('activeTransaction','assertUsable','return ('+text+');')(()=>outer,transaction=>assert.equal(transaction,outer));
 const qualify=async candidate=>{effects=0;await assert.rejects(candidate('synthetic-tenant',async()=>effects++,'BEGIN',undefined,held),{code:'POSTGRES_OWNER_TRANSACTION_MISMATCH'});assert.equal(effects,0);};
 const run=compile(body);await qualify(run);
 assert.equal(await run('synthetic-tenant',async()=>'ordinary'),'ordinary');
 outer.client=held;assert.equal(await run('synthetic-tenant',async()=>'same-owner','BEGIN',undefined,held),'same-owner');outer.client={};
 const needle="if (heldClient && outer.client !== heldClient) throw Object.assign(new Error('PostgreSQL held owner cannot join another backend transaction'), { code: 'POSTGRES_OWNER_TRANSACTION_MISMATCH' });";
 assert.equal(body.split(needle).length,2);await assert.rejects(qualify(compile(body.replace(needle,''))),{code:'ERR_ASSERTION'});await qualify(run);
});
it('effect guard awaits shared advisory lock before desired/membership reads and keeps exact revision without FOR SHARE',async()=>{
 let release;const held=new Promise(r=>{release=r;}),events=[],query=queryWith({},events),selectedGuard=await guard();let reads=0;
 const pending=selectedGuard.admit(async(...args)=>{if(++reads===1)await held;return query(...args);},tenant);
 assert.equal(reads,1);assert.equal(events.length,0);release();const selected=await pending;
 assert(selected.includes(tenant));assert.equal(selected.revision,'9007199254740993');assert.match(events[0],/pg_advisory_xact_lock_shared/);assert(events.every(sql=>!sql.includes('FOR SHARE')));assert.match(events[2],/clock_timestamp/);
});
it('boot refuses missing, disabled or altered mutation triggers, including mixed old-writer installations',async()=>{
 for(const rows of [[],installed().slice(0,1),installed().map(row=>({...row,enabled:'O'})),installed().map(row=>({...row,source:row.source+' '}))])await assert.rejects(fence.open({namespace:'test_membership',assignment,self,backendPid:41,query:async()=>({rows})}),/PROTOCOL_UNQUALIFIED/);
});
it('effect guard refuses foreign/autocommit backend, changed assignment, stale incarnation, expired lease and missing peer before effects',async()=>{
 for(const patch of [{lock:{backend_pid:42}},{desired:{backend_pid:42}},{snapshot:{backend_pid:42}},{desired:{transaction_id:'502'}},{snapshot:{transaction_id:'502'}},
   {desired:{revision:'9007199254740992'}},{snapshot:{members:[members[0]]}},
   {snapshot:{members:members.map(row=>row.ordinal===0?{...row,live:false}:row)}},
   {snapshot:{members:members.map(row=>row.ordinal===0?{...row,memberId:ids[3]}:row)}}]){
   let effects=0;await assert.rejects(async()=>{await (await guard()).admit(queryWith(patch),tenant);effects++;},/PGSTREAM_EFFECT_/);assert.equal(effects,0);
 }
 const foreign=ids.find(id=>assignment.owner(id)===1);await assert.rejects((await guard()).admit(()=>assert.fail('foreign tenant must not query'),foreign),/FOREIGN_TENANT/);
});
it('control: removing snapshot transaction comparison admits autocommit; refusal criterion goes red and restores',async()=>{
 const {createRequire}=require('node:module'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/effect-fence'),source=fs.readFileSync(file,'utf8');
 const needle='||row[0].transaction_id!==locked[0].transaction_id';assert.equal(source.split(needle).length,2);const broken={exports:{}};
 vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
 const qualify=async module=>assert.rejects((await module.open({namespace:'test_membership',assignment,self,backendPid:41,query:async()=>({rows:installed()})})).admit(queryWith({snapshot:{transaction_id:'502'}}),tenant),/OWNER_TRANSACTION/);
 await assert.rejects(qualify(broken.exports),{code:'ERR_ASSERTION'});await qualify(fence);
});
