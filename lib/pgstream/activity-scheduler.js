'use strict';
// Known committed activity owns work. No healthy idle discovery interval.
// Completed-output delivery is realtime's obligation (lib/pgstream/output-wake.js
// sends the disposable hint); this scheduler owns clinical work only.
//
// One timing setting, NS_EVALUATOR_RETRY_MS (default 1000 ms): how long a
// refused, failed or not-admitted tenant waits before it is considered again,
// how long an overdue due instant waits before recovery re-reads it, and the
// longest a completion's due refresh is deferred while other work runs.
// A tenant that is not admitted (removed, not yet registered, another
// member's) is set aside only until then and re-checked on the next due or
// recovery read: nothing excluded outlives one retry interval. Recovery
// pages by cursor and sends no exclusion; the earliest-due read excludes only
// work in flight and refusals of the last interval, never the roster. A batch is one store page
// (PAGE, the store's work() bound).
const PAGE=64;
function retryDelay(source=process.env){const raw=source.NS_EVALUATOR_RETRY_MS;if(raw===undefined||raw==='')return 1000;if(!/^[1-9][0-9]{0,5}$/.test(raw)||Number(raw)>600000)throw new TypeError('invalid NS_EVALUATOR_RETRY_MS: a whole number from 1 to 600000 is required');return Number(raw);}
function start({store,scan,run,bind=fn=>fn,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,concurrency=2,onPending=()=>{},admits=()=>true,admitRecovered,retryMs=retryDelay()}){
 if(!Number.isSafeInteger(retryMs)||retryMs<1||retryMs>600000)throw new TypeError('Bounded evaluator retry interval required');
 const queued=new Map(),active=new Map(),prepared=new Map(),retryAt=new Map();
 const enqueue=(tenant,kind)=>{if(kind==='due'&&(queued.has(tenant)||prepared.has(tenant)))return;prepared.delete(tenant);queued.set(tenant,kind);};
 const clinicalDelay=()=>{if(prepared.size)return 0;const waiting=[...queued.keys()].filter(tenant=>!active.has(tenant));return waiting.length?Math.max(0,Math.min(...waiting.map(tenant=>retryAt.get(tenant)??now()))-now()):null;};
 const armClinical=()=>{const delay=clinicalDelay();if(delay!==null)timer('clinical',drain,delay);};
 const later=tenant=>retryAt.set(tenant,now()+retryMs);
 const waiting=()=>{const at=now(),out=[];for(const [tenant,until]of retryAt){if(until>at)out.push(tenant);else if(!queued.has(tenant))retryAt.delete(tenant);}return out;};
 let closed=false,clinical=null,clinicalTimer=null,clinicalTimerAt=null,dueTimer=null,recoveryTimer=null,recoveryCursor=null,dueVersion=0,dueFlight=null,dueAgain=false,dueRefresh=null;
 const counters={batches:0,selected:0,maxBatch:0,retries:0};
 function timer(kind,fn,delay){if(closed)return;if(clinicalTimer){if(clinicalTimerAt<=now()+delay)return;clearTimer(clinicalTimer);}clinicalTimerAt=now()+delay;const value=setTimer(bind(()=>{clinicalTimer=null;clinicalTimerAt=null;fn().catch(()=>{});}),delay);value?.unref?.();clinicalTimer=value;}
 function wake(tenant,kind='clock'){if(closed||!admits(tenant))return;retryAt.delete(tenant);enqueue(tenant,kind);timer('clinical',drain,0);}
 // Completions change at most their own tenant's due instant. While other
 // tasks are still running, one bounded trailing earliest-due lookup covers
 // every completion in the window; the last completion of a burst looks up
 // at once. The lookup still reads durable state; no due instant is inferred.
 function refreshDue(){if(closed)return;if(!active.size){if(dueRefresh){clearTimer(dueRefresh);dueRefresh=null;}due().catch(()=>{});return;}if(dueRefresh)return;dueRefresh=setTimer(bind(()=>{dueRefresh=null;due().catch(()=>{});}),retryMs);dueRefresh?.unref?.();}
 function due(){
  if(closed)return Promise.resolve();
  // Completions share an indexed earliest-due lookup. If work changes while
  // it is in flight, one fresh lookup retains the new earliest deadline.
  if(dueFlight){dueAgain=true;return dueFlight;}
  dueFlight=Promise.resolve().then(async()=>{
   try{do{
    dueAgain=false;const version=++dueVersion;
    if(dueTimer)clearTimer(dueTimer);dueTimer=null;
    const at=await store.nextDue({exclude:[...active.keys(),...waiting()]});
    if(closed||version!==dueVersion)return;
    if(at!==null){dueTimer=setTimer(bind(()=>{dueTimer=null;recover().catch(()=>{});}),Math.min(2147483647,Math.max(at<=now()?retryMs:0,Math.ceil(at-now()))));dueTimer?.unref?.();}
   }while(dueAgain&&!closed);
   }finally{dueFlight=null;}
  });
  return dueFlight;
 }
 async function drain({wait=true}={}){
  if(closed)return;if(clinical){await clinical;if(wait)await Promise.allSettled([...active.values()]);return;}
  const deferred=new Set();
  clinical=(async()=>{
   // Scans go one store page at a time. A long pass still refreshes the
   // earliest due instant (at most once per retry interval while work runs).
   while(!closed){
    if(!prepared.size){
     const candidates=[...queued].filter(([tenant])=>!active.has(tenant)&&!deferred.has(tenant)&&(retryAt.get(tenant)??0)<=now());
     if(!candidates.length)break;
     const page=candidates.slice(0,PAGE);for(const [tenant]of page)queued.delete(tenant);
     const selected=page.filter(([tenant])=>{if(admits(tenant))return true;later(tenant);return false;});
     if(!selected.length)continue;
     counters.batches++;counters.selected+=selected.length;counters.maxBatch=Math.max(counters.maxBatch,selected.length);refreshDue();
     try{await scan(selected.map(([tenant])=>tenant));}
     catch{for(const [tenant,kind]of selected){enqueue(tenant,kind);later(tenant);deferred.add(tenant);}counters.retries++;break;}
     for(const [tenant,kind]of selected)if(!queued.has(tenant))prepared.set(tenant,kind);
    }
    const room=concurrency-active.size;
    if(room<=0){await Promise.race(active.values());continue;}
    for(const [tenant,kind]of [...prepared].slice(0,room)){
     prepared.delete(tenant);retryAt.delete(tenant);
     // A short dispatch pump fills free slots. Tenant ownership survives between
     // pumps; a held tenant does not block a newly addressed neighbor.
     const task=Promise.resolve().then(()=>run(tenant,kind)).catch(()=>{enqueue(tenant,kind);later(tenant);deferred.add(tenant);counters.retries++;}).finally(()=>{
      active.delete(tenant);
      if(!closed)armClinical();
      refreshDue();
     });active.set(tenant,task);
    }
   }
   await due();
  })().finally(()=>{clinical=null;if(!closed)armClinical();});
  await clinical;
  // Explicit drains await entered work after releasing the dispatch pump.
  if(wait)await Promise.allSettled([...active.values()]);
 }
 let retryRecovery = false;
 function scheduleRecovery(delay) {
  if (closed || recoveryTimer) return;
  recoveryTimer = setTimer(bind(() => { recoveryTimer = null; recover().catch(() => {}); }), delay);
  recoveryTimer?.unref?.();
 }
 async function recover() {
  if (closed) return;
  try {
   // The cursor already moves past this sweep's refusals; a tenant still
   // set aside is skipped here, not excluded in SQL.
   const rows = await store.work(PAGE, {after: recoveryCursor});
   for (const row of rows) {
    if ((retryAt.get(row.tenant) ?? 0) > now() && !queued.has(row.tenant)) continue;
    if (!admits(row.tenant)) { later(row.tenant); continue; }
    if (admitRecovered) {
     try {
      if (!await admitRecovered(row.tenant)) { later(row.tenant); continue; }
     } catch { retryRecovery = true; continue; }
    }
    if (row.pendingAt !== null) onPending(row.tenant, row.pendingAt);
    enqueue(row.tenant, row.pendingAt !== null ? 'clock' : 'due');
   }
   recoveryCursor = rows.length === PAGE ? rows[rows.length - 1].tenant : null;
   await drain({wait:false});
   if (recoveryCursor) scheduleRecovery(0);
   else if (retryRecovery) { retryRecovery = false; scheduleRecovery(retryMs); }
  } catch (error) {
   scheduleRecovery(retryMs);
   throw error;
  }
 }
 return Object.freeze({removeTenant:tenant=>{queued.delete(tenant);prepared.delete(tenant);later(tenant);if(dueTimer){clearTimer(dueTimer);dueTimer=null;}due().catch(()=>{});},wake,recover,drain,stats:()=>({...counters}),async close(){closed=true;dueVersion++;for(const value of [clinicalTimer,dueTimer,recoveryTimer,dueRefresh])if(value)clearTimer(value);await Promise.allSettled([clinical,dueFlight,...active.values()]);}});
}
module.exports={start,retryDelay,PAGE};
