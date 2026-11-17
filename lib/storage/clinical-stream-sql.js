'use strict';
const state=require('./clinical-stream-state');
const work=require('../pgstream/work-state');
const journal=require('./storage-event-journal');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function binding({table,consumer,snapshotDigest}){
 if(!/^[a-z][a-z0-9_]{0,62}\.tenant_consumer_checkpoint$/.test(table)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||! /^[a-f0-9]{64}$/.test(snapshotDigest))throw new TypeError('CLINICAL_STREAM_BINDING');
 return '"'+table.split('.')[0]+'".tenant_consumer_checkpoint';
}
async function acceptTransaction(options){
 const {pool,observeBackend,table,consumer,snapshotDigest,completedConsumer,completedDigest,envelope,routes,expectedSource,assertFence,lockKey,maxRows,maxBytes,maxTransactionRows,maxTransactionBytes}=options;
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<256)throw new TypeError('Explicit clinical input bounds required');
 const relation=binding(options),transaction=state.validateTransaction(envelope,{maxRows:maxTransactionRows,maxBytes:maxTransactionBytes});
 if(!state.sameSource(transaction.source_identity,state.sourceIdentity(expectedSource)))throw new Error('CLINICAL_STREAM_SOURCE_FENCE');
 if(!Array.isArray(routes)||routes.some(r=>typeof r.schema!=='string'||typeof r.table!=='string'||!state.DOMAINS.includes(r.domain))||typeof assertFence!=='function'||typeof lockKey!=='string'||! /^-?[0-9]+$/.test(lockKey))throw new TypeError('CLINICAL_STREAM_TRANSACTION_BINDING');
 const map=new Map(routes.map(r=>[r.schema+'.'+r.table,r.domain]));
 if(map.size!==routes.length)throw new TypeError('CLINICAL_STREAM_DUPLICATE_ROUTE');
 const observations=options.observations??[],invalidated=new Set(options.invalidateTenants??[]);
 if(!Array.isArray(observations)||!Array.isArray(options.invalidateTenants??[])||[...invalidated].some(tenant=>!UUID.test(tenant)))throw new TypeError('CLINICAL_STREAM_CONTROL_BINDING');
 if(observations.length)work.validateReceipts({table,consumer:completedConsumer,observations});
 const controls=new Map(observations.map(row=>[row.tenant,row]));
 const groups=new Map();
 for(const data of transaction.changes){
  const domain=map.get(data.schema+'.'+data.table);if(!domain)continue;
  const columns=Object.fromEntries([...(data.identity||[]),...(data.columns||[])].map(c=>[c.name,c.value]));
  const tenant=columns.tenant_id;if(!UUID.test(tenant))throw new Error('CLINICAL_STREAM_TENANT');
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
  await observeBackend(client);await client.query('BEGIN');began=true;
  await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[lockKey]);
  const generations=new Map();for(const tenant of tenants){const generation=await assertFence(client,tenant,{source_identity:transaction.source_identity,position:transaction.position});if(typeof generation!=='string'||! /^[A-Za-z0-9:_-]{1,128}$/.test(generation))throw new Error('CLINICAL_STREAM_GENERATION');generations.set(tenant,generation);}
  const rows=(await client.query("SELECT c.tenant_id::text AS tenant,c.projection,c.contract_digest,c.checkpoint,(SELECT projection->0->'output'->'result'->'now' FROM "+relation+" o WHERE o.tenant_id=c.tenant_id AND o.consumer=$3) AS evaluated_at FROM "+relation+' c WHERE c.tenant_id=ANY($1::uuid[]) AND c.consumer=$2 ORDER BY c.tenant_id FOR UPDATE',[inputTenants,consumer,completedConsumer])).rows;
  if(rows.length!==inputTenants.length)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const pendingObservations=new Map(observations.map(row=>[row.tenant,{...row,observed:{...row.observed}}])),rawPending=new Map();
  for(const row of rows){
   const tenant=row.tenant;if((!groups.has(tenant)&&!invalidated.has(tenant))||row.contract_digest!==snapshotDigest)throw new Error('CLINICAL_STREAM_CONTRACT');
   const durable=row.projection?.[0],cached=options.cache?.get(tenant);
   const saved=state.matches(cached,durable)?cached:durable,coverage={source_identity:transaction.source_identity,generation:generations.get(tenant),position:transaction.position};
   const events=groups.get(tenant)||[],previous=journal.validate(row.projection?.[1]);let tail=previous,next;
   if(invalidated.has(tenant)){
    if(!Number.isSafeInteger((saved?.floor??0)+1))throw new Error('CLINICAL_STREAM_FLOOR');
    next={...state.empty(),floor:(saved?.floor??0)+1,deleted:saved?.deleted??0,stream:{source_identity:coverage.source_identity,generation:coverage.generation,snapshot_position:'0/0',accepted_position:coverage.position}};
    // Exact replay of the lifecycle cohort has already reset continuity.
    if(saved?.kind===state.KIND&&state.sameSource(saved.stream?.source_identity,coverage.source_identity)&&saved.stream?.generation===coverage.generation&&saved.stream?.accepted_position!==null&&saved.stream?.accepted_position!==undefined&&state.position(coverage.position)<=state.position(saved.stream.accepted_position))next=saved;
    else tail=journal.reset(previous);
   }else next=state.applyTransaction(saved,events.map(e=>e.event),coverage,{maxRows,maxBytes},row.evaluated_at);
   // Snapshot coverage only skips clinical replay. Raw mutations are owed until
   // this ordinary stream's complete cohort has itself been durably accepted.
   // Row WAL locations can precede the prior committed cohort when an old
   // transaction commits late. The native commit and row index define replay.
   if(next!==saved)for(const event of events)tail=journal.append(tail,event.domain,{...event.data,lsn:transaction.position},{maxRows,maxBytes});
   if(tail.head!==previous.head){
    const changed=await client.query('UPDATE '+relation+' SET delivery_revision=delivery_revision+1 WHERE tenant_id=$1 AND consumer=$2 AND contract_digest=$3',[tenant,completedConsumer,completedDigest]);
    if(changed.rowCount!==1)throw new Error('STORAGE_EVENT_OUTPUT_CONTRACT');
   }
   if(next!==saved){
    const update=await client.query('UPDATE '+relation+' SET projection=$3::jsonb,contract_digest=$4,checkpoint=$5 WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer,JSON.stringify([state.compact(next),tail]),snapshotDigest,next.floor]);
    if(update.rowCount!==1)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
   }
   const observation=pendingObservations.get(tenant)||{tenant,observed:{}};
   observation.observed.bootstrap=String(next.floor);pendingObservations.set(tenant,observation);
   rawPending.set(tenant,tail.head!==previous.head);staged.set(tenant,next);
  }
  const receipts=await work.observeInTransaction({client,table,consumer:completedConsumer,contractDigest:completedDigest,observations:[...pendingObservations.values()]});
  const results=receipts.map((receipt,i)=>({...receipt,tenant:[...pendingObservations.keys()][i],rawDeliveryPending:rawPending.get([...pendingObservations.keys()][i])??false}));
  for(const tenant of tenants){const generation=await assertFence(client,tenant,{source_identity:transaction.source_identity,position:transaction.position});if(generation!==generations.get(tenant))throw new Error('CLINICAL_STREAM_SOURCE_FENCE');}
  const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');began=false;
  for(const [tenant,input]of staged)options.cache?.set(tenant,input);
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
  if(lockKey!==undefined){if(typeof lockKey!=='string'||! /^-?[0-9]+$/.test(lockKey))throw new TypeError('CLINICAL_STREAM_RECOVERY_LOCK');await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[lockKey]);}
  const rows=(await client.query('SELECT projection,contract_digest,checkpoint FROM '+relation+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,consumer])).rows;
  if(rows.length!==1)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const saved=rows[0].projection?.[0];
  if(saved?.kind===state.KIND&&lockKey===undefined)throw new Error('CLINICAL_STREAM_RECOVERY_LOCK');
  const floor=Number(work.version(saved?.floor??rows[0].checkpoint??0));if(!Number.isSafeInteger(floor+1))throw new Error('CLINICAL_STREAM_FLOOR');
  const previous=journal.validate(rows[0].projection?.[1]),tail=journal.reset(previous),next={...state.empty(),floor:floor+1,deleted:saved?.deleted??0};
  await client.query('UPDATE '+relation+' SET projection=$3::jsonb,contract_digest=$4,checkpoint=$5 WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer,JSON.stringify([state.compact(next),tail]),snapshotDigest,next.floor]);
  if(completedConsumer){const changed=await client.query('UPDATE '+relation+' SET delivery_revision=delivery_revision+1 WHERE tenant_id=$1 AND consumer=$2 AND contract_digest=$3',[tenant,completedConsumer,completedDigest]);if(changed.rowCount!==1)throw new Error('STORAGE_EVENT_OUTPUT_CONTRACT');}
  const receipt=completedConsumer?(await work.observeInTransaction({client,table,consumer:completedConsumer,contractDigest:completedDigest,observations:[{tenant,observed:{bootstrap:String(next.floor)}}]}))[0]:{};
  const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');
  return {...receipt,rawDeliveryPending:true};
 }catch(error){failure=error;try{await client.query('ROLLBACK');}catch{ /* Failed connection is evicted. */ }throw error;}finally{client.release(failure);}
}
module.exports={accept,acceptTransaction};
