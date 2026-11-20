'use strict';
const state=require('./clinical-stream-state');
const work=require('../pgstream/work-state');
const windowPolicy=require('./clinical-working-set-policy');
// A tenant born in this stream: the transaction that provisions it is the first
// one that can carry its data, so the input is complete and empty at its commit
// position. The window is the widest the contract admits from instant 0 (a
// superset of any evaluator's policy); the first evaluation narrows it.
function born(coverage,floor,limits){
 return state.bound({...state.empty(),ready:true,floor,policy:windowPolicy.validate({kind:windowPolicy.KIND,at:0,devicestatusMs:172800000}),windowRevision:1,rowCount:0,rowBytes:2,
  stream:{source_identity:coverage.source_identity,generation:coverage.generation,snapshot_position:coverage.position,accepted_position:coverage.position}},limits,2);
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recoveryKey=lockKey=>tenant=>{const key=lockKey(tenant);if(typeof key!=='string'||! /^-?[0-9]+$/.test(key))throw new TypeError('CLINICAL_STREAM_RECOVERY_LOCK');return key;};
function binding({table,consumer,snapshotDigest}){
 if(!/^[a-z][a-z0-9_]{0,62}\.tenant_consumer_checkpoint$/.test(table)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||! /^[a-f0-9]{64}$/.test(snapshotDigest))throw new TypeError('CLINICAL_STREAM_BINDING');
 return '"'+table.split('.')[0]+'".tenant_consumer_checkpoint';
}
async function acceptTransaction(options){
 const {pool,observeBackend,table,consumer,snapshotDigest,completedConsumer,completedDigest,envelope,routes,expectedSource,assertFence,lockKey,maxRows,maxBytes,maxTransactionRows,maxTransactionBytes}=options;
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<256)throw new TypeError('Explicit clinical input bounds required');
 const relation=binding(options),transaction=state.revalidateTransaction(options.transaction,envelope,{maxRows:maxTransactionRows,maxBytes:maxTransactionBytes,slice:options.slice});
 if(!state.sameSource(transaction.source_identity,state.sourceIdentity(expectedSource)))throw new Error('CLINICAL_STREAM_SOURCE_FENCE');
 if(!Array.isArray(routes)||routes.some(r=>typeof r.schema!=='string'||typeof r.table!=='string'||!state.DOMAINS.includes(r.domain))||typeof assertFence!=='function'||typeof lockKey!=='function')throw new TypeError('CLINICAL_STREAM_TRANSACTION_BINDING');
 const map=new Map(routes.map(r=>[r.schema+'.'+r.table,r.domain]));
 if(map.size!==routes.length)throw new TypeError('CLINICAL_STREAM_DUPLICATE_ROUTE');
 const admits=options.admits??(()=>true);
 const observations=(options.observations??[]).filter(row=>admits(row.tenant)),invalidated=new Set((options.invalidateTenants??[]).filter(admits)),bornTenants=new Set(options.bornTenants??[]);
 if(!Array.isArray(observations)||!Array.isArray(options.invalidateTenants??[])||[...invalidated].some(tenant=>!UUID.test(tenant)))throw new TypeError('CLINICAL_STREAM_CONTROL_BINDING');
 if(observations.length)work.validateReceipts({table,consumer:completedConsumer,observations});
 const controls=new Map(observations.map(row=>[row.tenant,row]));
 const groups=new Map();
 for(const data of transaction.changes){
  const domain=map.get(data.schema+'.'+data.table);if(!domain)continue;
  const columns=Object.fromEntries([...(data.identity||[]),...(data.columns||[])].map(c=>[c.name,c.value]));
  const tenant=columns.tenant_id;if(!UUID.test(tenant))throw new Error('CLINICAL_STREAM_TENANT');if(!admits(tenant))continue;
  const event=state.eventOf(domain,data);
  if(!groups.has(tenant))groups.set(tenant,[]);groups.get(tenant).push({domain,data,event});
 }
 // A source-database receiver must not turn filtered empty transactions into
 // further receipt writes. Native transport can checkpoint their complete C.
 const tenants=[...new Set([...groups.keys(),...controls.keys(),...invalidated])].sort();
 if(!tenants.length)return [];
 if(tenants.length>64)throw new Error('CLINICAL_STREAM_TRANSACTION_TENANT_BOUND');
 const inputTenants=tenants.filter(tenant=>groups.has(tenant)||invalidated.has(tenant));
 const client=await pool.connect();let failure,began=false;const staged=new Map();
 try{
  await observeBackend(client);await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;
  // Per-tenant recovery order (lib/pgstream/snapshot-recovery.js): this receipt
  // waits only for a recovery of a tenant it writes, never for another tenant's.
  await client.query('SELECT count(pg_advisory_xact_lock_shared(k)) FROM unnest($1::bigint[]) AS k',[tenants.map(recoveryKey(lockKey))]);
  const generations=new Map();for(const tenant of tenants){const generation=await assertFence(client,tenant,{source_identity:transaction.source_identity,position:transaction.position});if(typeof generation!=='string'||! /^[A-Za-z0-9:_-]{1,128}$/.test(generation))throw new Error('CLINICAL_STREAM_GENERATION');generations.set(tenant,generation);}
  const rows=inputTenants.length?(await client.query("SELECT c.tenant_id::text AS tenant,c.projection,c.contract_digest,c.checkpoint,(SELECT projection->0->'output'->'result'->'now' FROM "+relation+" o WHERE o.tenant_id=c.tenant_id AND o.consumer=$3) AS evaluated_at FROM "+relation+' c WHERE c.tenant_id=ANY($1::uuid[]) AND c.consumer=$2 ORDER BY c.tenant_id FOR UPDATE',[inputTenants,consumer,completedConsumer])).rows:[];
  if(rows.length!==inputTenants.length)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const pendingObservations=new Map(observations.map(row=>[row.tenant,{...row,observed:{...row.observed}}])),rawDeliveryTenants=new Set(),patches=[];
  // A retained cohort can precede the current lifetime (including a fresh
  // recommission checkpoint). Consume its stream position without applying
  // lifecycle eligibility from a different generation or phase.
  const native=options.operationWindow?.nativeLifecycle;
  if(native){
   require('../tenant-lifecycle/native-selection').validate(native);
   if(native.binding.namespace!==table.split('.')[0]||native.binding.consumer!==consumer||native.contractDigest!==completedDigest)throw new Error('PGSTREAM_NATIVE_RECEIPT_BINDING');
   for(const observation of pendingObservations.values()){
    if(observation.observed.lifecycle===undefined)continue;
    await client.query("SELECT set_config('app.current_tenant_id',$1,true)",[observation.tenant]);
    const {rows:[live]}=await client.query('SELECT generation::text AS generation,phase FROM "'+native.binding.lifecycleNamespace+'".tenant_lifecycle_windows WHERE tenant_id=$1',[observation.tenant]);
    if(!live)throw new Error('CLINICAL_STREAM_RESTORE_FENCE');
    if(observation.observed.lifecycle!==require('../pgstream/intake-profile').lifecycleStamp(live.generation,live.phase)||observation.eligibility?.lifecycle!==(live.phase==='active'))delete observation.observed.lifecycle;
   }
  }
  for(const row of rows){
   const tenant=row.tenant;
   // A paused tenant can receive raw mutations before its first clinical
   // snapshot. Only the exact freshly provisioned empty row may initialize
   // native coverage here; this never acquires or certifies clinical input.
   const fresh=row.projection===null&&String(row.checkpoint)==='0'&&
     /^[a-f0-9]{64}$/.test(options.initialDigest||'')&&row.contract_digest===options.initialDigest;
   if((!groups.has(tenant)&&!invalidated.has(tenant))||row.contract_digest!==snapshotDigest&&!fresh)throw new Error('CLINICAL_STREAM_CONTRACT');
   const durable=fresh?{...state.empty(),stream:{source_identity:transaction.source_identity,generation:generations.get(tenant),snapshot_position:'0/0',accepted_position:null}}:row.projection?.[0],cached=fresh?null:options.cache?.get(tenant);
   const saved=state.matches(cached,durable)?cached:durable,coverage={source_identity:transaction.source_identity,generation:generations.get(tenant),position:transaction.position};
   // Spike S2: no storage-event journal. `/storage` comes from the api's
   // post-commit hint; the input row keeps no raw tail (projection[1] null).
   const events=groups.get(tenant)||[];let next;
   // Provisioning delivered by this stream, before any clinical row: serve the
   // empty input now; no snapshot recovery (decision predictable-fixes-then-test).
   if(fresh&&bornTenants.has(tenant)&&invalidated.has(tenant)&&!groups.has(tenant)){next=born(coverage,1,{maxRows,maxBytes});}
   else if(invalidated.has(tenant)){
    if(!Number.isSafeInteger((saved?.floor??0)+1))throw new Error('CLINICAL_STREAM_FLOOR');
    next={...state.empty(),floor:(saved?.floor??0)+1,deleted:saved?.deleted??0,stream:{source_identity:coverage.source_identity,generation:coverage.generation,snapshot_position:'0/0',accepted_position:coverage.position}};
    // Exact replay of the lifecycle cohort has already reset continuity.
    if(saved?.kind===state.KIND&&state.sameSource(saved.stream?.source_identity,coverage.source_identity)&&saved.stream?.generation===coverage.generation&&saved.stream?.accepted_position!==null&&saved.stream?.accepted_position!==undefined&&state.position(coverage.position)<=state.position(saved.stream.accepted_position))next=saved;
   }else next=state.applyTransaction(saved,events.map(e=>e.event),coverage,{maxRows,maxBytes},row.evaluated_at);
   // Snapshot coverage only skips clinical replay. Raw mutations are owed until
   // this ordinary stream's complete cohort has itself been durably accepted.
   // Row WAL locations can precede the prior committed cohort when an old
   // transaction commits late. The native commit and row index define replay.
   if(next!==saved)patches.push({tenant,projection:[state.compact(next),null],checkpoint:next.floor});
   const observation=pendingObservations.get(tenant)||{tenant,observed:{}};
   observation.observed.bootstrap=String(next.floor);pendingObservations.set(tenant,observation);
   staged.set(tenant,next);
  }
  const versions=new Map();
  // The work-state rows are locked after the CPU work above, as before; the
  // input and work-state writes then share one statement (different rows).
  const cohort=[...pendingObservations.values()];
  const {results:receipts,patches:workPatches}=await work.observeInTransaction({client,table,consumer:completedConsumer,contractDigest:completedDigest,observations:cohort,rawDeliveryTenants,admit:true,defer:true});
  if(patches.length||workPatches.length){
   const {rows:[version]}=await client.query('WITH written AS (UPDATE '+relation+' c SET projection=p.projection,contract_digest=$2,checkpoint=p.checkpoint FROM jsonb_to_recordset($3::jsonb) AS p(tenant uuid,projection jsonb,checkpoint bigint) WHERE c.tenant_id=p.tenant AND c.consumer=$1 RETURNING c.xmin::text AS xid),worked AS ('+work.patchUpdate(relation,'$4','$5')+' RETURNING 1 AS one) SELECT (SELECT count(*)::integer FROM written) AS written,(SELECT CASE WHEN min(xid)=max(xid) THEN min(xid) END FROM written) AS xid,pg_current_xact_id()::text AS full_xid,(SELECT count(*)::integer FROM worked) AS worked',[consumer,snapshotDigest,JSON.stringify(patches),completedConsumer,JSON.stringify(workPatches)]);
   if(version?.written!==patches.length)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
   if(version?.worked!==workPatches.length)throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');
   for(const patch of patches)versions.set(patch.tenant,{written:version.written,xid:version.xid,full_xid:version.full_xid});
  }
  const results=receipts.map((receipt,i)=>({...receipt,tenant:cohort[i].tenant,rawDeliveryPending:rawDeliveryTenants.has(cohort[i].tenant)}));
  // Maintenance commits suspension before taking the exclusive lock.
  // Keep the final generation and receiver-ownership check before COMMIT.
  for(const tenant of tenants){const generation=await assertFence(client,tenant,{source_identity:transaction.source_identity,position:transaction.position,final:true});if(generation!==generations.get(tenant))throw new Error('CLINICAL_STREAM_SOURCE_FENCE');}
  const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');began=false;
  for(const [tenant,input]of staged)options.cache?.set(tenant,input,versions.get(tenant));
  return results;
 }catch(error){for(const tenant of inputTenants)options.cache?.delete(tenant);failure=error;if(began)try{await client.query('ROLLBACK');}catch{ /* Failed connection is evicted. */ }throw error;}
 finally{client.release(failure);}
}
// Explicit lifecycle invalidation keeps independent raw continuity visible.
// Ordinary input has no row-stage or application-clock sealing entry point.
async function accept(options){
 const {pool,observeBackend,table,consumer,tenant,snapshotDigest,completedConsumer,completedDigest,lockKey}=options;
 const relation=binding(options);if(!options.invalidate||!UUID.test(tenant))throw new Error('CLINICAL_STREAM_COMPLETE_TRANSACTION_REQUIRED');
 const client=await pool.connect();let failure;
 try{
  await observeBackend(client);await client.query('BEGIN');
  if(lockKey!==undefined){if(typeof lockKey!=='function')throw new TypeError('CLINICAL_STREAM_RECOVERY_LOCK');await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[recoveryKey(lockKey)(tenant)]);}
  const rows=(await client.query('SELECT projection,contract_digest,checkpoint FROM '+relation+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,consumer])).rows;
  if(rows.length!==1)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const saved=rows[0].projection?.[0];
  if(saved?.kind===state.KIND&&lockKey===undefined)throw new Error('CLINICAL_STREAM_RECOVERY_LOCK');
  const floor=Number(work.version(saved?.floor??rows[0].checkpoint??0));if(!Number.isSafeInteger(floor+1))throw new Error('CLINICAL_STREAM_FLOOR');
  const next={...state.empty(),floor:floor+1,deleted:saved?.deleted??0};
  await client.query('UPDATE '+relation+' SET projection=$3::jsonb,contract_digest=$4,checkpoint=$5 WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer,JSON.stringify([state.compact(next),null]),snapshotDigest,next.floor]);
  const receipt=completedConsumer?(await work.observeInTransaction({client,table,consumer:completedConsumer,contractDigest:completedDigest,observations:[{tenant,observed:{bootstrap:String(next.floor)}}],rawDeliveryTenants:new Set([tenant])}))[0]:{};
  const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');
  return {...receipt,rawDeliveryPending:true};
 }catch(error){failure=error;try{await client.query('ROLLBACK');}catch{ /* Failed connection is evicted. */ }throw error;}finally{client.release(failure);}
}
module.exports={accept,acceptTransaction};
