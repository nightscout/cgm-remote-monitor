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
// NS_EVALUATOR_ORDER=oldest-first: when the executor is saturated, queued work
// is dispatched by when it became owed, oldest first: a write's pending instant
// and a due alarm's due instant on one clock, so an overdue alarm is not
// starved behind newer writes and a repeated write does not lose its place.
// Unset (or 'arrival') keeps arrival order.
const PAGE=64;
function orderMode(source=process.env){const raw=source.NS_EVALUATOR_ORDER;if(raw===undefined||raw===''||raw==='arrival')return false;if(raw==='oldest-first')return true;throw new TypeError('invalid NS_EVALUATOR_ORDER: oldest-first or arrival is required');}
function retryDelay(source=process.env){const raw=source.NS_EVALUATOR_RETRY_MS;if(raw===undefined||raw==='')return 1000;if(!/^[1-9][0-9]{0,5}$/.test(raw)||Number(raw)>600000)throw new TypeError('invalid NS_EVALUATOR_RETRY_MS: a whole number from 1 to 600000 is required');return Number(raw);}
// Spike S1: sweepMs (optional) adds a periodic sweep over pending rows only
// (store.pending, the partial pending index). Hints are never the guarantee:
// a write whose hint was lost is found within one sweep interval.
function start({store,scan,run,bind=fn=>fn,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,concurrency=2,onPending=()=>{},admits=()=>true,admitRecovered,retryMs=retryDelay(),sweepMs,oldestFirst=orderMode()}){
 if(sweepMs!==undefined&&(!Number.isSafeInteger(sweepMs)||sweepMs<1||sweepMs>600000||typeof store.pending!=='function'))throw new TypeError('Bounded evaluator sweep interval required');
 if(!Number.isSafeInteger(retryMs)||retryMs<1||retryMs>600000)throw new TypeError('Bounded evaluator retry interval required');
 const queued=new Map(),active=new Map(),prepared=new Map(),retryAt=new Map(),since=new Map();
 const byAge=entries=>oldestFirst?entries.slice().sort((a,b)=>(since.get(a[0])??Infinity)-(since.get(b[0])??Infinity)):entries;
 const enqueue=(tenant,kind,at=now())=>{if(oldestFirst){const prior=since.get(tenant);if(prior===undefined||at<prior)since.set(tenant,at);}if(kind==='due'&&(queued.has(tenant)||prepared.has(tenant)))return;prepared.delete(tenant);queued.set(tenant,kind);};
 const clinicalDelay=()=>{if(prepared.size)return 0;const waiting=[...queued.keys()].filter(tenant=>!active.has(tenant));return waiting.length?Math.max(0,Math.min(...waiting.map(tenant=>retryAt.get(tenant)??now()))-now()):null;};
 const armClinical=()=>{const delay=clinicalDelay();if(delay!==null)timer('clinical',drain,delay);};
 const olderQueued=()=>{const floor=Math.min(...[...prepared.keys()].map(tenant=>since.get(tenant)??Infinity));return [...queued].some(([tenant])=>!active.has(tenant)&&(deferredNow.get(tenant)??0)<=now()&&(retryAt.get(tenant)??0)<=now()&&(since.get(tenant)??Infinity)<floor);};
 let deferredNow=new Map();
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
  // A tenant set aside by this pass (its scan or run failed) is not taken again
  // by it, whatever wakes it, until one retry interval has passed. The bound is
  // the interval, never the pass: a saturated pass does not end.
  const deferred=new Map(),setAside=tenant=>deferred.set(tenant,now()+retryMs);deferredNow=deferred;let dispatched=false;
  clinical=(async()=>{
   // Scans go one store page at a time. A long pass still refreshes the
   // earliest due instant (at most once per retry interval while work runs).
   while(!closed){
    if(!prepared.size||(oldestFirst&&olderQueued())){
     const candidates=byAge([...queued]).filter(([tenant])=>!active.has(tenant)&&(deferred.get(tenant)??0)<=now()&&(retryAt.get(tenant)??0)<=now());
     if(!candidates.length)break;
     const page=candidates.slice(0,PAGE);for(const [tenant]of page)queued.delete(tenant);
     const selected=page.filter(([tenant])=>{if(admits(tenant))return true;later(tenant);return false;});
     if(!selected.length)continue;
     counters.batches++;counters.selected+=selected.length;counters.maxBatch=Math.max(counters.maxBatch,selected.length);
     // Every dispatched task refreshes the due instant when it settles. With no
     // task running the first of those follows at once, so only a pass that is
     // already running work needs this (deferred) refresh.
     if(active.size)refreshDue();
     try{await scan(selected.map(([tenant])=>tenant));}
     catch{for(const [tenant,kind]of selected){enqueue(tenant,kind);later(tenant);setAside(tenant);}counters.retries++;break;}
     for(const [tenant,kind]of selected)if(!queued.has(tenant))prepared.set(tenant,kind);
    }
    const room=concurrency-active.size;
    if(room<=0){await Promise.race(active.values());continue;}
    for(const [tenant,kind]of byAge([...prepared]).slice(0,room)){
     const owed=since.get(tenant);prepared.delete(tenant);since.delete(tenant);retryAt.delete(tenant);dispatched=true;
     // A short dispatch pump fills free slots. Tenant ownership survives between
     // pumps; a held tenant does not block a newly addressed neighbor.
     // A failed run keeps the instant its work became owed (oldest-first).
     const task=Promise.resolve().then(()=>run(tenant,kind)).catch(()=>{enqueue(tenant,kind,owed);later(tenant);setAside(tenant);counters.retries++;}).finally(()=>{
      active.delete(tenant);
      if(!closed)armClinical();
      refreshDue();
     });active.set(tenant,task);
    }
   }
   // A pass that dispatched work leaves the lookup to its settling tasks.
   if(!dispatched)await due();
  })().finally(()=>{clinical=null;if(!closed)armClinical();});
  await clinical;
  // Explicit drains await entered work after releasing the dispatch pump.
  if(wait)await Promise.allSettled([...active.values()]);
 }
 let sweepTimer=null;const sweeps={runs:0,found:0,statements:0};
 async function sweep(){
  if(closed)return;let after=null;
  try{do{const rows=await store.pending(PAGE,{after});sweeps.statements++;
   for(const row of rows){if(!admits(row.tenant))continue;if(active.has(row.tenant)||queued.has(row.tenant)||prepared.has(row.tenant))continue;sweeps.found++;onPending(row.tenant,row.pendingAt);enqueue(row.tenant,'clock',row.pendingAt??undefined);}
   after=rows.length===PAGE?rows[rows.length-1].tenant:null;}while(after&&!closed);
   sweeps.runs++;await drain({ wait: false }); // spaced: the recovery control patches the first unspaced call
  }finally{if(!closed&&sweepMs!==undefined){sweepTimer=setTimer(bind(()=>{sweepTimer=null;sweep().catch(()=>{});}),sweepMs);sweepTimer?.unref?.();}}
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
   // A row read while its tenant's cycle is in flight may carry the mark that
   // cycle's commit covers. Marking it pending in memory would outlive the
   // completion (the runtime keeps marks made during a cycle) and report a
   // completed tenant as stalled. The work is still queued; the completion
   // reports what the durable row still owes.
   const flying = new Set(active.keys());
   const rows = await store.work(PAGE, {after: recoveryCursor});
   for (const row of rows) {
    if ((retryAt.get(row.tenant) ?? 0) > now() && !queued.has(row.tenant)) continue;
    if (!admits(row.tenant)) { later(row.tenant); continue; }
    if (admitRecovered) {
     try {
      if (!await admitRecovered(row.tenant)) { later(row.tenant); continue; }
     } catch { retryRecovery = true; continue; }
    }
    if (row.pendingAt !== null && !flying.has(row.tenant) && !active.has(row.tenant)) onPending(row.tenant, row.pendingAt);
    enqueue(row.tenant, row.pendingAt !== null ? 'clock' : 'due', row.pendingAt !== null ? Math.min(row.pendingAt, row.nextDueAt ?? row.pendingAt) : (row.nextDueAt ?? undefined));
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
 // Recomputes owed and not yet dispatched (NS_EVAL_PRIORITY reads this).
 const backlog=()=>{let n=prepared.size;for(const tenant of queued.keys())if(!active.has(tenant)&&!prepared.has(tenant))n++;return n;};
 return Object.freeze({sweep,backlog,sweepStats:()=>({...sweeps}),removeTenant:tenant=>{queued.delete(tenant);prepared.delete(tenant);since.delete(tenant);later(tenant);if(dueTimer){clearTimer(dueTimer);dueTimer=null;}due().catch(()=>{});},wake,recover,drain,stats:()=>({...counters}),async close(){closed=true;dueVersion++;for(const value of [clinicalTimer,dueTimer,recoveryTimer,dueRefresh,sweepTimer])if(value)clearTimer(value);await Promise.allSettled([clinical,dueFlight,...active.values()]);}});
}
module.exports={start,retryDelay,orderMode,PAGE};
