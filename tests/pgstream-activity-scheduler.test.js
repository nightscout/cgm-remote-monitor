'use strict';
const assert=require('node:assert/strict');
const scheduler=require('../lib/pgstream/activity-scheduler');
function fixture({poison,start=scheduler.start,admits=()=>true,admitRecovered,onRun,maxTenants=10000}={}){let now=100,nextDue=null,dueByTenant=null,work=[];const timers=new Map(),calls={work:0,due:0,scan:[],run:[]};let id=0;const store={async work(limit,{after,exclude=[]}={}){calls.work++;return work.filter(row=>(!after||row.tenant>after)&&!exclude.includes(row.tenant)&&(row.dueAt===undefined||row.pendingAt!==null||row.dueAt<=now)).slice(0,limit); },async nextDue({exclude=[]}={}){calls.due++;return dueByTenant?Math.min(...Object.entries(dueByTenant).filter(([tenant])=>!exclude.includes(tenant)).map(([,at])=>at),Infinity)===Infinity?null:Math.min(...Object.entries(dueByTenant).filter(([tenant])=>!exclude.includes(tenant)).map(([,at])=>at)):nextDue;}};const value=start({store,admits,admitRecovered,maxTenants,scan:async ids=>calls.scan.push(ids),run:async(tenant,kind)=>{calls.run.push([tenant,kind]);if(onRun)await onRun(tenant,kind);if(tenant===poison)throw Error('POISON');work=work.filter(row=>row.tenant!==tenant);if(dueByTenant)delete dueByTenant[tenant];},now:()=>now,setTimer(fn,delay){const key=++id;timers.set(key,{fn,at:now+delay});return key;},clearTimer:key=>timers.delete(key)});return {value,calls,timers,setWork:rows=>{work=rows;},setDue:at=>{nextDue=at;},setDueByTenant:value=>{dueByTenant=value;},async flush(ms=0){now+=ms;for(let turns=0;turns<20;turns++){const due=[...timers].filter(([,row])=>row.at<=now);if(!due.length)return;for(const [key,row]of due){timers.delete(key);await row.fn();}await new Promise(resolve=>setImmediate(resolve));}}};}
describe('pgstream known-activity scheduling',function(){
 it('has no healthy idle query timer after startup recovery, and no delivery bookkeeping surface',async()=>{const f=fixture();await f.value.recover();await f.flush();const before={...f.calls};await f.flush(100000);assert.equal(f.calls.work,before.work);assert.equal(f.timers.size,0);for(const retired of ['deliver','wakeDelivery'])assert.equal(f.value[retired],undefined,'EVALUATOR_DELIVERY_LOOP_RETIRED '+retired);await f.value.close();});
 it('coalesces committed useful events into one bounded metadata scan and preserves independent tenants',async()=>{const f=fixture();f.value.wake('A');f.value.wake('A','settings');f.value.wake('B');await f.flush();assert.deepEqual(f.calls.scan,[['A','B']]);assert.deepEqual(f.calls.run,[['A','settings'],['B','clock']]);assert.equal(f.value.stats().maxBatch,2);await f.value.close();});
 it('a transient cold membership refusal retries the addressed tenant without blocking another due tenant',async()=>{
  let refuse=true;
  const f=fixture({admitRecovered:async tenant=>{
   if(tenant==='A' && refuse) throw new Error('TENANT_REGISTRY_ADMISSION_STALE');
   return true;
  }});
  try {
   f.setWork([{tenant:'A',pendingAt:null},{tenant:'B',pendingAt:null}]);
   await f.value.recover();await f.flush();
   assert.deepEqual(f.calls.run,[['B','due']]);
   refuse=false;await f.flush(1000);
   assert.deepEqual(f.calls.run,[['B','due'],['A','due']]);
  } finally {await f.value.close();}
 });
 it('reconstructs only the earliest actual due timer from durable state',async()=>{const f=fixture();f.setDue(200);await f.value.recover();assert([...f.timers.values()].some(row=>row.at===200));await f.flush();const before=f.calls.work;await f.flush(99);assert.equal(f.calls.work,before);f.setWork([{tenant:'A',pendingAt:null}]);f.setDue(null);await f.flush(1);assert.deepEqual(f.calls.run,[['A','due']]);await f.value.close();});
 it('bounds retry of an overdue poison timer instead of creating an immediate recovery loop',async()=>{const f=fixture({poison:'A'});f.setWork([{tenant:'A',pendingAt:null}]);f.setDue(99);await f.value.recover();await f.flush();const before=f.calls.work;await f.flush(999);assert.equal(f.calls.work,before);assert([...f.timers.values()].every(row=>row.at>=1100));await f.value.close();});
 it('recovers later pages despite a poison tenant in the first full page',async()=>{const f=fixture({poison:'000'});f.setWork(Array.from({length:130},(_,i)=>({tenant:String(i).padStart(3,'0'),pendingAt:1})));await f.value.recover();await f.flush();assert(f.calls.run.some(([tenant])=>tenant==='129'),'later recover page must progress independently of poison retry timer');assert(f.calls.run.some(([tenant])=>tenant==='001'));assert(f.value.stats().maxBatch<=64);await f.value.close();});
 it('excludes removed durable due work without rewriting authority, continues a neighbor and re-admits locally',async()=>{const allowed=new Set(['B']),f=fixture({admits:tenant=>allowed.has(tenant)});f.setDueByTenant({A:99,B:200});f.setWork([{tenant:'A',pendingAt:null,dueAt:99},{tenant:'B',pendingAt:null,dueAt:200}]);await f.value.recover();await f.flush();assert.equal(f.calls.run.length,0);const before=f.calls.work;await f.flush(99);assert.equal(f.calls.work,before);await f.flush(1);assert.deepEqual(f.calls.run,[['B','due']]);await f.flush();assert.equal(f.timers.size,0);allowed.add('A');f.value.wake('A','registry');await f.flush();assert(f.calls.run.some(([tenant])=>tenant==='A'));allowed.delete('A');f.value.removeTenant('A');await f.flush();await f.value.close();});
});


describe('durable recovery paging with held clinical work',()=>{
 async function criterion(start=scheduler.start){
  let entered,release;const enteredA=new Promise(done=>{entered=done;}),held=new Promise(done=>{release=done;});
  const f=fixture({start,onRun:async tenant=>{if(tenant==='000'){entered();await held;}}});
  f.setWork(Array.from({length:129},(_,i)=>({tenant:String(i).padStart(3,'0'),pendingAt:1})));
  const recovering=f.value.recover();
  try{await enteredA;for(let turn=0;turn<50;turn++){await f.flush();await new Promise(done=>setImmediate(done));}assert(f.calls.run.some(([tenant])=>tenant==='128'),'RECOVERY_PAGE_STARVED_BY_HELD_EARLIER_TENANT');}
  finally{release();await recovering;await f.flush();await f.value.close();}
 }
 it('advances later durable pages before the first-page held tenant releases',()=>criterion());
 it('control: paging waits for dispatch, not all entered clinical work',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),file=require.resolve('../lib/pgstream/activity-scheduler'),source=fs.readFileSync(file,'utf8'),needle='await drain({wait:false})';assert(source.includes(needle));
  const broken={exports:{}};vm.runInThisContext('(function(require,module,exports){'+source.replace(needle,'await drain()')+'\n})',{filename:file})(require,broken,broken.exports);
  await assert.rejects(criterion(broken.exports.start),/RECOVERY_PAGE_STARVED_BY_HELD_EARLIER_TENANT/);await criterion();
 });
});

// Control: a tenant that is not admitted (removed, not yet registered) is set
// aside for one retry interval, never for the process lifetime, so the
// exclusion sent with every durable read does not grow with the roster.
describe('scheduler exclusion bounded by work in flight, not by the roster',()=>{
 async function sent(count){
  let now=0;const timers=new Map();let id=0;const excludes=[];
  const rows=Array.from({length:count},(_,i)=>({tenant:'t'+String(i).padStart(5,'0'),pendingAt:null}));
  const store={async work(limit,{after,exclude=[]}={}){excludes.push(exclude.length);return rows.filter(row=>(!after||row.tenant>after)&&!exclude.includes(row.tenant)).slice(0,limit);},
   async nextDue({exclude=[]}={}){excludes.push(exclude.length);return null;}};
  const s=scheduler.start({store,admitRecovered:async()=>false,scan:async()=>{},run:async()=>{},retryMs:1000,now:()=>now,
   setTimer(fn,delay){const key=++id;timers.set(key,{fn,at:now+delay});return key;},clearTimer:key=>timers.delete(key)});
  await s.recover();
  const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));};
  for(let turn=0;turn<count;turn++){await settle();const due=[...timers].filter(([,t])=>t.at<=now);if(!due.length)break;for(const [key,t]of due){timers.delete(key);await t.fn();}}
  const sweep=Math.max(...excludes);
  now+=1000;excludes.length=0;s.wake('t00000');await new Promise(resolve=>setImmediate(resolve));await s.drain();
  await s.close();return {sweep,steady:Math.max(0,...excludes)};
 }
 it('sends the same bounded exclusion after 10 and 1,000 refused tenants',async()=>{
  const small=await sent(10),large=await sent(1000);
  assert.equal(large.steady,small.steady,'EXCLUSION_GROWS_WITH_ROSTER '+small.steady+' vs '+large.steady);
  assert(large.steady<=1,'only work in flight is excluded after one retry interval');
 });
});
