'use strict';
const {it}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../lib/pgstream/receiver');
const assignment=require('../lib/pgstream/fixed-assignment');
const {RULE}=require('../lib/pool-membership/slice');
const ids=Array.from({length:16},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
it('one actual receiver persists before hinting the selected member; a lost hint leaves pending truth (memory store only)',async()=>{
 const fixed=assignment.create({tenants:ids,members:2,revision:'1'}),pending=new Map(),seen=[[],[]];let resolve,entered;
 const started=new Promise(r=>{entered=r;}),commit=new Promise(r=>{resolve=r;});
 const routes=[{schema:'test_clock',table:'tenant_write_clock',kind:'clock'}];
 const receive=create({routes,store:{observe:async(tenant,kind,version)=>{entered();await commit;const old=pending.get(tenant);const observed={clock:old&&BigInt(old.observed.clock)>BigInt(version)?old.observed.clock:version};const row={observed,completed:{},pendingAt:1};pending.set(tenant,row);return row;}},
   onInput:tenant=>{assert(pending.has(tenant));seen[fixed.owner(tenant)].push(tenant);throw new Error('synthetic hint lost');},onHeartbeat:()=>{},onSchema:()=>{}});
 const event=(id,version)=>({Data:{action:'U',schema:'test_clock',table:'tenant_write_clock',columns:[{name:'tenant_id',value:id},{name:'last_stamp',value:version}]}});
 let ack=false;const first=receive(event(ids[0],'2')).then(()=>{ack=true;});await started;assert.equal(ack,false);assert.equal(pending.size,0);resolve();await first;
 for(const id of ids.slice(1))await receive(event(id,'2'));
 await receive(event(ids[0],'1'));assert.equal(pending.get(ids[0]).observed.clock,'2');
 for(let ordinal=0;ordinal<2;ordinal++){
   const rows=[0,1].map(i=>({ordinal:i,memberId:ids[i],rule:RULE,live:true,appliedMembers:2}));
   const slice=fixed.select({self:rows[ordinal],rows,desired:{members:2,revision:'1',rule:RULE}});
   // A cold worker can select persisted pending rows without another input hint.
   const recovered=[...pending.keys()].filter(slice.includes);assert(recovered.length);assert.deepEqual(recovered.sort(),slice.tenants);
   assert(seen[ordinal].every(slice.includes));
 }
 await assert.rejects(receive({Data:{...event(ids[0],'3').Data,table:'tenant_consumer_checkpoint'}}),/UNROUTED/);
});
