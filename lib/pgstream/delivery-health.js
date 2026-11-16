'use strict';
// Application progress only. Platform services own pgstream process lifecycle.
const {validateBounds}=require('./config');
const fail=code=>Object.assign(new Error(code),{code});
const RECEIVER_COUNTERS=Object.freeze(['httpArrivals','routeRefusals','bodyRefusals','parseRefusals','parsed','receiverInFlight','receiverCompleted','receiverRefusals','schemaStarted','schemaInFlight','schemaCompleted','schemaRefusals','heartbeatCallbacks','heartbeatCompleted','heartbeatRefusals']);
async function start({bounds,pulse,inspect,pending,onUnavailable,onRecovered=async()=>{},onTerminal=()=>{},initialSequence=0,now=Date.now,monotonicNow,onHealthy,receiverDiagnostics}){
 bounds=validateBounds(bounds);
 if([pulse,inspect,pending,onUnavailable,now].some(fn=>typeof fn!=='function')||!Number.isSafeInteger(initialSequence)||initialSequence<0||
   [monotonicNow,onHealthy,receiverDiagnostics].some(fn=>fn!==undefined&&typeof fn!=='function'))throw new TypeError('Explicit durable delivery health ports required');
 let closed=false,terminal=null,reported=false,healthy=false,withdrawn=false,reason='PGSTREAM_STARTING',sequence=initialSequence,received=initialSequence;
 let lastReceipt=null,lastMonotonicReceipt=null,lastMonotonicReading=null,running,timer,closing,pendingSince=null,clinicalStalled=false,lastFailure=null,lastStepFailure=null;
 const bornAt=now(),stats={receipts:0,pulses:0,probes:0};
 function monotonic(){const value=monotonicNow();if(!Number.isFinite(value)||value<0||lastMonotonicReading!==null&&value<lastMonotonicReading)throw fail('PGSTREAM_MONOTONIC_CLOCK_REFUSED');lastMonotonicReading=value;return value;}
 function snapshot(){if(!receiverDiagnostics)return null;try{const value=receiverDiagnostics(),out={};for(const key of RECEIVER_COUNTERS){const field=value&&Object.getOwnPropertyDescriptor(value,key);if(!field||!Object.hasOwn(field,'value')||!Number.isSafeInteger(field.value)||field.value<0)return null;out[key]=field.value;}return out;}catch{return null;}}
 function diagnostics(){return {code:terminal||reason,lastFailure,lastStepFailure,heartbeatAgeMs:lastReceipt===null?null:now()-lastReceipt,sequence,received,pendingSince,clinicalStalled,...stats,receiver:snapshot()};}
 function receipt(value){if(!Number.isSafeInteger(value)||value<1||value>sequence)throw fail('PGSTREAM_HEARTBEAT_INVALID');if(closed||terminal||value<=received)return;if(monotonicNow)lastMonotonicReceipt=monotonic();received=value;lastReceipt=now();stats.receipts++;}
 async function step(fn,phase){const abort=new AbortController();let timeout;try{return await Promise.race([Promise.resolve().then(()=>fn(abort.signal)),new Promise((resolve,reject)=>{timeout=setTimeout(()=>{abort.abort();reject(fail('PGSTREAM_STEP_TIMEOUT'));},bounds.stepMs);})]);}catch(error){lastStepFailure={phase,code:abort.signal.aborted?'PGSTREAM_STEP_TIMEOUT':/^[A-Z0-9_]{1,100}$/.test(error?.code||'')?error.code:null,at:now()};if(abort.signal.aborted)terminal='PGSTREAM_STEP_TIMEOUT';throw error;}finally{clearTimeout(timeout);}}
 async function unavailable(code){healthy=false;reason=code;lastFailure={code,at:now()};if(withdrawn)return;withdrawn=true;try{await step(signal=>onUnavailable(code,signal,diagnostics()),'withdrawal');}catch{terminal=terminal||'PGSTREAM_WITHDRAWAL_FAILED';}}
 async function check(){if(closed||terminal)return;try{
  stats.probes++;const source=await step(inspect,'inspect');
  if(!source||source.identity!==true||source.grants!==true||source.slot!=='valid'){terminal=source?.slot==='lost'?'PGSTREAM_REBOOTSTRAP_REQUIRED':'PGSTREAM_SOURCE_REFUSED';throw fail(terminal);}
  const work=await step(pending,'pending');
  if(!work||typeof work.pending!=='boolean'||work.pending&&(!Number.isSafeInteger(work.oldestPendingAt)||work.oldestPendingAt<0||work.oldestPendingAt>now()))throw fail('PGSTREAM_PENDING_HEALTH_INVALID');
  pendingSince=work.pending?work.oldestPendingAt:null;
  clinicalStalled=pendingSince!==null&&now()-Math.max(pendingSince,bornAt)>=bounds.pendingMs;
  // Stale delivery withdraws application readiness; it does not manage or kill
  // an external process. Keep fixed heartbeat work so delivery can resume.
  if(now()-(lastReceipt??bornAt)>=bounds.stallMs)await unavailable('PGSTREAM_HEARTBEAT_STALLED');
  if(terminal)return;
  if(sequence===Number.MAX_SAFE_INTEGER){terminal='PGSTREAM_HEARTBEAT_EXHAUSTED';throw fail(terminal);}
  const next=++sequence;await step(signal=>pulse(next,signal),'pulse');stats.pulses++;
  if(lastReceipt!==null&&now()-lastReceipt<bounds.stallMs){
   const recovering=!healthy;if(recovering)await step(onRecovered,'reconciliation');
   healthy=true;reason=null;withdrawn=false;
   if(recovering&&onHealthy)await step(onHealthy,'ready-publication');
  }
 }catch(error){await unavailable(terminal||error.code||'PGSTREAM_HEALTH_FAILED');}}
 function tick(){if(running||closed||terminal)return running||Promise.resolve();running=check().finally(()=>{running=null;if(terminal&&!reported){reported=true;onTerminal(terminal,diagnostics());}});return running;}
 await tick();timer=setInterval(()=>{tick().catch(()=>{});},bounds.heartbeatMs);timer.unref?.();
 return Object.freeze({receipt,check:tick,diagnostics,health:()=>({healthy:healthy&&!closed&&!terminal&&lastReceipt!==null&&now()-lastReceipt<bounds.stallMs,code:terminal||reason,terminal:!!terminal,closed,heartbeatAgeMs:lastReceipt===null?null:now()-lastReceipt,
  ...(monotonicNow?{monotonicHeartbeatAgeMs:lastMonotonicReceipt===null?null:monotonic()-lastMonotonicReceipt}:{}),sequence,received,clinicalStalled,clinicalCode:clinicalStalled?'PGSTREAM_CLINICAL_PROGRESS_STALLED':null,...stats}),
  close(){if(!closing){closed=true;healthy=false;clearInterval(timer);closing=Promise.resolve(running);}return closing;}});
}
module.exports={start,RECEIVER_COUNTERS};
