'use strict';
// Known committed activity owns work. No healthy idle discovery interval.
function start({store,scan,run,send,bind=fn=>fn,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,concurrency=2,onPending=()=>{},admits=()=>true,maxTenants=10000}){
 const queued=new Map(),excluded=new Set(),active=new Map(),prepared=new Map(),retryAt=new Map();
 const enqueue=(tenant,kind)=>{if(kind==='due'&&(queued.has(tenant)||prepared.has(tenant)))return;prepared.delete(tenant);queued.set(tenant,kind);};
 const clinicalDelay=()=>{if(prepared.size)return 0;const waiting=[...queued.keys()].filter(tenant=>!active.has(tenant));return waiting.length?Math.max(0,Math.min(...waiting.map(tenant=>retryAt.get(tenant)??now()))-now()):null;};
 const armClinical=()=>{const delay=clinicalDelay();if(delay!==null)timer('clinical',drain,delay);};
 const remember=tenant=>{if(!excluded.has(tenant)&&excluded.size>=maxTenants)throw new Error('EVALUATOR_EXCLUSION_BOUND');excluded.add(tenant);};
 const exclusions=()=>[...excluded];let closed=false,clinical=null,delivery=null,clinicalTimer=null,clinicalTimerAt=null,deliveryTimer=null,dueTimer=null,recoveryTimer=null,recoveryCursor=null,deliveryCursor=null,deliveryFailed=false,deliveryAgain=false,dueVersion=0;
 const counters={batches:0,selected:0,maxBatch:0,retries:0,deliveryBatches:0};
 function timer(kind,fn,delay){if(closed)return;const key=kind==='clinical'?clinicalTimer:deliveryTimer;if(key){if(kind!=='clinical'||clinicalTimerAt<=now()+delay)return;clearTimer(key);}if(kind==='clinical')clinicalTimerAt=now()+delay;const value=setTimer(bind(()=>{if(kind==='clinical'){clinicalTimer=null;clinicalTimerAt=null;}else deliveryTimer=null;fn().catch(()=>{});}),delay);value?.unref?.();if(kind==='clinical')clinicalTimer=value;else deliveryTimer=value;}
 function wake(tenant,kind='clock'){if(closed||!admits(tenant))return;excluded.delete(tenant);retryAt.delete(tenant);enqueue(tenant,kind);timer('clinical',drain,0);}
 function wakeDelivery(){if(delivery){deliveryAgain=true;return;}timer('delivery',deliver,0);}
 async function due(){const version=++dueVersion;if(dueTimer)clearTimer(dueTimer);dueTimer=null;if(closed)return;const at=await store.nextDue({exclude:[...exclusions(),...active.keys(),...[...retryAt].filter(([,at])=>at>now()).map(([tenant])=>tenant)]});if(closed||version!==dueVersion)return;if(at!==null){dueTimer=setTimer(bind(()=>{dueTimer=null;recover().catch(()=>{});}),Math.min(2147483647,Math.max(at<=now()?1000:0,Math.ceil(at-now()))));dueTimer?.unref?.();}}
 async function drain({wait=true}={}){
  if(closed)return;if(clinical){await clinical;if(wait)await Promise.allSettled([...active.values()]);return;}
  const deferred=new Set();
  clinical=(async()=>{
   let pages=0;
   while(!closed){
    if(!prepared.size){
     const candidates=[...queued].filter(([tenant])=>!active.has(tenant)&&!deferred.has(tenant)&&(retryAt.get(tenant)??0)<=now());
     if(!candidates.length||pages===4)break;
     const page=candidates.slice(0,64);for(const [tenant]of page)queued.delete(tenant);
     const selected=page.filter(([tenant])=>{if(admits(tenant))return true;remember(tenant);return false;});
     if(!selected.length)continue;
     counters.batches++;counters.selected+=selected.length;counters.maxBatch=Math.max(counters.maxBatch,selected.length);pages++;
     try{await scan(selected.map(([tenant])=>tenant));}
     catch{for(const [tenant,kind]of selected){enqueue(tenant,kind);retryAt.set(tenant,now()+1000);deferred.add(tenant);}counters.retries++;break;}
     for(const [tenant,kind]of selected)if(!queued.has(tenant))prepared.set(tenant,kind);
    }
    const room=concurrency-active.size;
    if(room<=0){await Promise.race(active.values());continue;}
    for(const [tenant,kind]of [...prepared].slice(0,room)){
     prepared.delete(tenant);retryAt.delete(tenant);
     // A short dispatch pump fills free slots. Tenant ownership survives between
     // pumps; a held tenant does not block a newly addressed neighbor.
     const task=Promise.resolve().then(()=>run(tenant,kind)).catch(()=>{enqueue(tenant,kind);retryAt.set(tenant,now()+1000);deferred.add(tenant);counters.retries++;}).finally(()=>{
      active.delete(tenant);
      if(!closed)armClinical();
      due().catch(()=>{});
     });active.set(tenant,task);
    }
   }
   await due();
  })().finally(()=>{clinical=null;if(!closed)armClinical();});
  await clinical;
  // Explicit drains await entered work after releasing the dispatch pump.
  if(wait)await Promise.allSettled([...active.values()]);
 }
 async function recover(){if(closed)return;const rows=await store.work(64,{after:recoveryCursor,exclude:exclusions()});for(const row of rows){if(!admits(row.tenant)){remember(row.tenant);continue;}if(row.pendingAt!==null)onPending(row.tenant,row.pendingAt);enqueue(row.tenant,row.pendingAt!==null?'clock':'due');}recoveryCursor=rows.length===64?rows[rows.length-1].tenant:null;await drain({wait:false});if(recoveryCursor&&!recoveryTimer){recoveryTimer=setTimer(bind(()=>{recoveryTimer=null;recover().catch(()=>{});}),0);recoveryTimer?.unref?.();}}
 async function deliver(){if(closed)return;if(delivery)return delivery;delivery=(async()=>{let pages=0;while(!closed&&pages++<4){const rows=await store.deliveries(64,{after:deliveryCursor,exclude:exclusions()});if(!rows.length){deliveryCursor=null;if(deliveryFailed){deliveryFailed=false;timer('delivery',deliver,1000);}return;}deliveryCursor=rows.length===64?rows[rows.length-1].tenant:null;counters.deliveryBatches++;let failed=false;let cursor=0;await Promise.all(Array.from({length:Math.min(concurrency,rows.length)},async()=>{for(let i=cursor++;i<rows.length;i=cursor++){const row=rows[i];if(!admits(row.tenant)){remember(row.tenant);continue;}try{await send({tenant:row.tenant,revision:row.revision});await store.acknowledge(row.tenant,row.revision);}catch{failed=true;counters.retries++;}}}));deliveryFailed=deliveryFailed||failed;if(rows.length<64){if(deliveryFailed){deliveryFailed=false;timer('delivery',deliver,1000);}return;}}timer('delivery',deliver,0);})().catch(()=>{counters.retries++;timer('delivery',deliver,1000);}).finally(()=>{delivery=null;if(deliveryAgain){deliveryAgain=false;timer('delivery',deliver,0);}});return delivery;}
 return Object.freeze({async initialize(tenants){for(const tenant of tenants)wake(tenant,'startup');do{await drain();if(retryAt.size)throw new Error('EVALUATOR_STARTUP_INCOMPLETE');}while(!closed&&(queued.size||prepared.size||active.size));},removeTenant:tenant=>{remember(tenant);queued.delete(tenant);prepared.delete(tenant);retryAt.delete(tenant);if(dueTimer){clearTimer(dueTimer);dueTimer=null;}due().catch(()=>{});},wake,wakeDelivery,recover,drain,deliver,stats:()=>({...counters}),async close(){closed=true;dueVersion++;for(const value of [clinicalTimer,deliveryTimer,dueTimer,recoveryTimer])if(value)clearTimer(value);await Promise.allSettled([clinical,delivery,...active.values()]);}});
}
module.exports={start};
