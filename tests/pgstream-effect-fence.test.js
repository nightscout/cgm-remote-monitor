'use strict';
const {it}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
it('source discriminator: an existing outer tenant transaction bypasses run heldClient; partition admission must refuse that nesting',async()=>{
 const file=require.resolve('../lib/storage/postgres-connection'),source=fs.readFileSync(file,'utf8');
 const start=source.indexOf('  async function run (tenant, fn, begin = '),end=source.indexOf('\n  }\n',start)+5;
 assert(start>=0&&end>start);const body=source.slice(start,end).trimEnd();
 assert(body.endsWith('\n  }'));assert(body.includes('return outcome;'));
 const held={name:'owner-backend'},foreign={name:'outer-backend'},outer={client:foreign};let effects=0;
 // Evaluate the exact source function. Only its early nested-transaction branch
 // executes; no database/backend/restore behavior is represented by this fixture.
 const compile=text=>new Function('activeTransaction','assertUsable','return ('+text+');')(()=>outer,transaction=>assert.equal(transaction,outer));
 const run=compile(body);
 assert.equal(await run('synthetic-tenant',async()=>{effects++;return 'outer-effect';},'BEGIN',undefined,held),'outer-effect');
 assert.equal(effects,1);assert.notEqual(outer.client,held);
 // The needed held-owner criterion fails on the exact current source.
 const qualify=async candidate=>{effects=0;await assert.rejects(candidate('synthetic-tenant',async()=>{effects++;},'BEGIN',undefined,held),/PARTITION_NESTED_OWNER/);assert.equal(effects,0);};
 await assert.rejects(qualify(run),{code:'ERR_ASSERTION'});
 const needle='if (outer) { assertUsable(outer); return fn(); }';assert.equal(body.split(needle).length,2);
 const refusing=body.replace(needle,"if (outer) { if (heldClient && outer.client !== heldClient) throw new Error('PARTITION_NESTED_OWNER'); assertUsable(outer); return fn(); }");
 await qualify(compile(refusing));
 // Restore the original source-derived behavior, rather than silently claiming
 // the local conceptual refusal is implemented in postgres-connection.
 assert.equal(await run('synthetic-tenant',async()=>'original','BEGIN',undefined,held),'original');
});

const fixed=require('../lib/pgstream/fixed-assignment'),fence=require('../lib/pgstream/effect-fence');
const {RULE}=require('../lib/pool-membership/slice');
const ids=Array.from({length:16},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
const assignment=fixed.create({tenants:ids,members:2,revision:'9007199254740993'});
const self={ordinal:0,memberId:ids[0],rule:RULE};
const desired={members:2,rule:RULE,revision:'9007199254740993',backend_pid:41,transaction_id:'501'};
const members=[0,1].map(ordinal=>({ordinal,memberId:ids[ordinal],rule:RULE,live:true,appliedMembers:2}));
const tenant=ids.find(id=>assignment.owner(id)===0);
const guard=()=>fence.create({namespace:'test_membership',assignment,self,backendPid:41});
function queryWith(patch={},events=[]){let step=0;return async(sql,values)=>{events.push(sql);assert.deepEqual(values,['evaluator']);return {rows:[++step===1?{...desired,...patch.desired}:{backend_pid:41,transaction_id:'501',members,...patch.snapshot}]};};}
it('effect guard awaits the desired row SHARE lock before reading members and preserves exact bigint revision',async()=>{
 let release;const held=new Promise(r=>{release=r;}),events=[];const query=queryWith({},events);let reads=0;
 const pending=guard().admit(async(...args)=>{if(++reads===1)await held;return query(...args);},tenant);
 assert.equal(reads,1);assert.equal(events.length,0);release();const selected=await pending;
 assert(selected.includes(tenant));assert.equal(selected.revision,'9007199254740993');assert.match(events[0],/FOR SHARE$/);assert.match(events[1],/clock_timestamp/);
});
it('effect guard refuses foreign or autocommit backends, changed assignment, stale incarnation and missing peer before effects',async()=>{
 for(const patch of [{desired:{backend_pid:42}},{snapshot:{backend_pid:42}},{snapshot:{transaction_id:'502'}},
   {desired:{revision:'9007199254740992'}},{snapshot:{members:[members[0]]}},
   {snapshot:{members:members.map(row=>row.ordinal===0?{...row,memberId:ids[3]}:row)}}]){
   let effects=0;await assert.rejects(async()=>{await guard().admit(queryWith(patch),tenant);effects++;},/PGSTREAM_EFFECT_/);assert.equal(effects,0);
 }
 const foreign=ids.find(id=>assignment.owner(id)===1);await assert.rejects(guard().admit(()=>assert.fail('foreign tenant must not query'),foreign),/FOREIGN_TENANT/);
});
it('control: removing transaction identity comparison admits autocommit; its refusal criterion goes red and restores',async()=>{
 const {createRequire}=require('node:module'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/effect-fence'),source=fs.readFileSync(file,'utf8');
 const needle='||row[0].transaction_id!==locked[0].transaction_id';assert.equal(source.split(needle).length,2);
 const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'')+'\n})',{filename:file})(createRequire(file),broken,broken.exports);
 const qualify=async module=>assert.rejects(module.create({namespace:'test_membership',assignment,self,backendPid:41}).admit(queryWith({snapshot:{transaction_id:'502'}}),tenant),/OWNER_TRANSACTION/);
 await assert.rejects(qualify(broken.exports),{code:'ERR_ASSERTION'});await qualify(fence);
});
