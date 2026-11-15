'use strict';
// Default-off control state. Remote freshness supplements local effect fences.
const {randomUUID}=require('node:crypto');
const {validate}=require('../server/internal-api/schema');
const contract=require('../server/internal-api/contracts/intake-state.json');
const operation=contract.operations.inspectIntake;
const fail=code=>Object.assign(new Error(code),{code});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const REV=/^[1-9][0-9]{0,18}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function identity(v){
 if(!exact(v,['participant','incarnation'])||typeof v.participant!=='string'||!/^[a-z][a-z0-9_-]{0,62}$/.test(v.participant)||!UUID.test(v.incarnation))throw fail('INTAKE_BINDING_REQUIRED');
 return Object.freeze({...v});
}
function selection(v){
 if(!exact(v,['assignmentRevision'])||typeof v.assignmentRevision!=='string'||!REV.test(v.assignmentRevision)||BigInt(v.assignmentRevision)>9223372036854775807n)throw fail('INTAKE_ASSIGNMENT_REQUIRED');
 return Object.freeze({...v});
}
function publisher({getBinding,assignmentRevision,health,stallMs}){
 selection({assignmentRevision});
 if(!Number.isSafeInteger(stallMs)||stallMs<1||stallMs>2147483647)throw fail('INTAKE_STALL_BOUND_REQUIRED');
 if(typeof getBinding!=='function'||typeof health!=='function')throw fail('INTAKE_BINDING_REQUIRED');
 const fresh=h=>h?.healthy&&!h.closed&&!h.terminal&&Number.isSafeInteger(h.sequence)&&Number.isSafeInteger(h.received)&&h.received>0&&h.received<=h.sequence&&Number.isFinite(h.heartbeatAgeMs)&&h.heartbeatAgeMs>=0&&h.heartbeatAgeMs<stallMs;
 let bound,revision=0,state='blocked',code='INTAKE_STARTING',closed=false;
 function bump(next,reason){if(revision===Number.MAX_SAFE_INTEGER){state='terminal';code='INTAKE_REVISION_EXHAUSTED';closed=true;throw fail('INTAKE_REVISION_EXHAUSTED');}revision++;state=next;code=reason;}
 function current(){
  let next;try{next=identity(getBinding());}catch(error){if(!closed&&state!=='terminal')bump('blocked','INTAKE_BINDING_UNAVAILABLE');throw error;}
  if(bound&&next.participant!==bound.participant){if(!closed&&state!=='terminal')bump('blocked','INTAKE_BINDING_MISMATCH');throw fail('INTAKE_BINDING_MISMATCH');}
  if(!bound||next.incarnation!==bound.incarnation){bound=next;revision=0;if(closed)bump('terminal',code);else bump('blocked','INTAKE_BINDING_CHANGED');}
  return bound;
 }
 current();
 function transition(next,reason){current();if(closed||state==='terminal')throw fail('INTAKE_CLOSED');bump(next,reason);return Object.freeze({...bound,revision});}
 function ticketMatches(ticket){current();return ticket&&ticket.participant===bound.participant&&ticket.incarnation===bound.incarnation&&ticket.revision===revision;}
 function ready(ticket){
  if(closed||!ticketMatches(ticket))throw fail('INTAKE_RECOVERY_SUPERSEDED');
  const h=health();if(!fresh(h))throw fail('INTAKE_FEED_NOT_READY');
  bump('ready',null);
 }
 async function prepareRecovery(fn){const ticket=transition('recovering','INTAKE_RECOVERING');try{await fn();if(!ticketMatches(ticket))throw fail('INTAKE_RECOVERY_SUPERSEDED');return ticket;}catch(error){if(ticketMatches(ticket))bump('blocked','INTAKE_RECOVERY_FAILED');throw error;}}
 async function recover(fn){ready(await prepareRecovery(fn));}
 function inspectIntake(request){
  current();validate(operation.request,request);
  if(request.participant!==bound.participant||request.incarnation!==bound.incarnation||request.assignmentRevision!==assignmentRevision)throw fail('INTAKE_BINDING_MISMATCH');
  const h=health();
  if((state==='ready')&&!fresh(h))bump(h?.terminal?'terminal':'blocked','INTAKE_FEED_UNAVAILABLE');
  const response={request:request.request,...bound,assignmentRevision,sourceStallMs:stallMs,controlRevision:revision,state,code,
   sequence:h?.sequence??0,received:h?.received??0,heartbeatAgeMs:h?.heartbeatAgeMs??null};
  validate(operation.response,response);return response;
 }
 return Object.freeze({inspectIntake,recover,prepareRecovery,ready,blocked:reason=>transition('blocked',reason),terminal:reason=>transition('terminal',reason),
  close(){try{current();}finally{if(!closed){bump('terminal','INTAKE_CLOSED');closed=true;}}},selection:Object.freeze({assignmentRevision})});
}
// The integration owner drives synchronize at its qualified explicit cadence.
// Expiry withdraws autonomously; neither a hint nor a remote reply grants DB authority.
function worker({peer,binding,bounds,invalidate,revalidate,reconcile,now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout,client,lifecycleClient}){
 if(!require('../server/serve/operation-cohort-manifest').isParticipant(peer)||!peer.roles.includes('evaluator'))throw fail('INTAKE_MANIFEST_PEER_REQUIRED');
 const endpoint=require('../server/internal-api/transport').options(peer.endpoint);
 bounds=require('./supervisor').validate(bounds);const selected=selection(binding);
 if([invalidate,revalidate,reconcile,now,schedule,cancel].some(fn=>typeof fn!=='function'))throw fail('INTAKE_WORKER_CALLBACKS_REQUIRED');
 const clients=require('../server/internal-api/clients');
 const remote=client||clients.intakeState(endpoint),lifecycle=lifecycleClient||clients.lifecycleParticipant(endpoint);
 const statusContract=require('../server/internal-api/contracts/lifecycle-participant.json').operations.getStatus;
 const {isDeepStrictEqual:same}=require('node:util');
 let bound,pin,available=false,closed=false,terminal=false,expires=0,timer,serial=0,highest=0,received=0,sequence=0,sourceBound=null,remoteTerminal=false,adopted=null,pending=Promise.resolve(),invalidated=false;
 let lastClock=null;
 function tick(){const value=now();if(!Number.isFinite(value)||value<0||lastClock!==null&&value<lastClock)throw fail('INTAKE_CLOCK_REFUSED');lastClock=value;return value;}
 function withdraw(reason){
  available=false;adopted=null;cancel(timer);timer=undefined;
  if(!invalidated){invalidated=true;pending=pending.then(()=>invalidate(reason)).catch(error=>{terminal=true;throw error;});pending.catch(()=>{});}
 }
 function assertAvailable(){let time;try{time=tick();}catch(error){withdraw('INTAKE_CLOCK_REFUSED');throw error;}if(available&&time>=expires)withdraw('INTAKE_FRESHNESS_EXPIRED');if(!available||closed||terminal)throw fail('INTAKE_WORKER_UNAVAILABLE');}
 async function call(method,request,run){
  const start=tick();let deadline;const abort=new AbortController();
  try{
   const response=await Promise.race([method(request,abort.signal),new Promise((resolve,reject)=>{deadline=schedule(()=>{abort.abort();reject(fail('INTAKE_RPC_TIMEOUT'));},Math.min(endpoint.timeoutMs,bounds.stallMs));})]);
   const finished=tick();
   if(run!==serial||closed||terminal)throw fail('INTAKE_REPLY_REORDERED');
   if(!Number.isFinite(finished)||!Number.isFinite(start)||finished<start)throw fail('INTAKE_CLOCK_REFUSED');
   return {response,start,finished};
  }finally{cancel(deadline);}
 }
 async function status(run){
  const request={request:randomUUID()},value=await call(lifecycle.getStatus.bind(lifecycle),request,run),s=value.response;
  validate(statusContract.response,s);
  if(s.request!==request.request||s.participant!==peer.id||!same(s.roles,peer.roles)||!same(s.namespaces,peer.namespaces))throw fail('INTAKE_COHORT_BINDING_MISMATCH');
  identity({participant:s.participant,incarnation:s.incarnation});
  return Object.freeze(structuredClone({participant:s.participant,incarnation:s.incarnation,namespace:s.namespace,identity:s.identity,datastore:s.datastore,tenants:s.tenants}));
 }
 async function inspect(run){
  const request={request:randomUUID(),...bound,assignmentRevision:selected.assignmentRevision};
  const {response,start,finished}=await call(remote.inspectIntake.bind(remote),request,run);
  validate(operation.response,response);
  if(response.request!==request.request||response.participant!==bound.participant||response.incarnation!==bound.incarnation||response.assignmentRevision!==selected.assignmentRevision)throw fail('INTAKE_BINDING_MISMATCH');
  if(response.controlRevision<highest||response.received<received||response.sequence<sequence||response.received>response.sequence)throw fail('INTAKE_STATE_REGRESSED');
  if(sourceBound!==null&&response.sourceStallMs!==sourceBound)throw fail('INTAKE_SOURCE_PROFILE_CHANGED');
  sourceBound=response.sourceStallMs;highest=response.controlRevision;received=response.received;sequence=response.sequence;
  if(response.state==='ready'&&(response.code!==null||response.received<1)||response.state!=='ready'&&response.code===null)throw fail('INTAKE_STATE_MALFORMED');
  if(response.state==='terminal'){remoteTerminal=true;withdraw('INTAKE_TERMINAL_INCARNATION');}
  if(response.state!=='ready')return {response,until:null};
  const age=response.heartbeatAgeMs,allowance=Math.min(sourceBound,bounds.stallMs);
  if(age===null||age+(finished-start)>=allowance)throw fail('INTAKE_FRESHNESS_EXPIRED');
  return {response,until:start+allowance-age};
 }
 async function synchronize(){
  if(closed||terminal)throw fail('INTAKE_WORKER_UNAVAILABLE');
  const run=++serial;
  try{
   const observed=await status(run);
   if(!pin||!same(observed,pin)){
    withdraw('INTAKE_COHORT_CHANGED');await pending;
    // Re-pin only after withdrawal/drain; no comparison across incarnations.
    if(!bound||bound.incarnation!==observed.incarnation||bound.participant!==observed.participant){highest=0;received=0;sequence=0;sourceBound=null;remoteTerminal=false;}
    pin=observed;bound=identity({participant:pin.participant,incarnation:pin.incarnation});
   }
   let value=await inspect(run);
   if(remoteTerminal&&value.response.state!=='terminal')throw fail('INTAKE_TERMINAL_INCARNATION');
   if(value.response.state!=='ready'){withdraw('INTAKE_NOT_READY');await pending;return false;}
   if(adopted!==value.response.controlRevision||!available){
    withdraw('INTAKE_REVALIDATION_REQUIRED');await pending;if(closed||terminal||run!==serial)throw fail('INTAKE_REPLY_REORDERED');
    const expected=value.response.controlRevision;
    await revalidate();await reconcile();
    if(!same(await status(run),pin))throw fail('INTAKE_COHORT_CHANGED');
    // A revalidation started under old schema/identity cannot admit its result.
    value=await inspect(run);
    if(value.response.state!=='ready'||value.response.controlRevision!==expected)throw fail('INTAKE_RECOVERY_SUPERSEDED');
   }
   if(tick()>=value.until)throw fail('INTAKE_FRESHNESS_EXPIRED');
   cancel(timer);expires=value.until;adopted=value.response.controlRevision;available=true;invalidated=false;
   timer=schedule(()=>withdraw('INTAKE_FRESHNESS_EXPIRED'),expires-tick());timer?.unref?.();return true;
  }catch(error){withdraw(error.code||'INTAKE_SYNCHRONIZATION_FAILED');await pending;throw error;}
 }
 return Object.freeze({synchronize,assertAvailable,get available(){try{assertAvailable();return true;}catch{return false;}},
  async close(){if(closed)return;closed=true;++serial;withdraw('INTAKE_WORKER_CLOSED');await pending;}});
}
module.exports={selection,identity,publisher,worker};
