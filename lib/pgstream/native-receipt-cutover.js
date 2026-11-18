'use strict';

const {createHash}=require('node:crypto');
const {canonical}=require('../server/serve/evaluator-runtime');
const native=require('../tenant-lifecycle/native-selection');
const {lifecycleStamp}=require('./intake-profile');
const work=require('./work-state');
const check=require('../migrations/postgres-check');
const typedCatalogue=require('../../migrations/candidates/postgres-evaluator-work-v2.json');

// Direct, offline migration on a single admin connection. Readers keep their
// clinical output and completed frontier until the evaluator covers new work.
function checkLegacyReceipt(row){
 if(row.observed===null){
  if(row.completed!==null)throw new Error('PGSTREAM_NATIVE_RECEIPT_RETAINED_STATE');
  return;
 }
 const observed=BigInt(row.observed);
 const knownGeneration=observed>=2n&&observed<=2n*BigInt(row.generation)+1n;
 const phaseMatches=(observed%2n===0n)===row.work_lifecycle_enabled;
 if(!knownGeneration||!phaseMatches||row.completed!==null&&BigInt(row.completed)>observed)throw new Error('PGSTREAM_NATIVE_RECEIPT_RETAINED_STATE');
}
async function upgrade(client,selection){
 const {binding:b,contractDigest}=native.validate(selection);
 const table=b.namespace+'.tenant_consumer_checkpoint',relation='"'+b.namespace+'".tenant_consumer_checkpoint';
 const windows='"'+b.lifecycleNamespace+'".tenant_lifecycle_windows',consumer=b.consumer+'-completed';
 const previous=require('./checkpoint').create({typed:true,connection:{},namespace:b.namespace,consumer:b.consumer,maxBytes:1}).digest;
 const ownerKey=createHash('sha256').update(canonical(['pgstream-evaluator-owner-v1',b.namespace,b.consumer])).digest().readBigInt64BE().toString();
 const query=client.query.bind(client);
 await query('BEGIN');
 try{
  await query('SET LOCAL row_security=off');
  if(!(await query('SELECT pg_try_advisory_xact_lock($1::bigint) AS held',[ownerKey])).rows[0].held)throw new Error('PGSTREAM_NATIVE_RECEIPT_OWNER_LIVE');
  await query('LOCK TABLE '+windows+', '+relation+' IN SHARE ROW EXCLUSIVE MODE NOWAIT');
  for(const [ns,catalogue] of [[b.namespace,typedCatalogue],[b.lifecycleNamespace,native.catalogue(selection)]]){
   if(!(await check.inspect(query,{table:'"'+ns+'".schema_migrations',files:catalogue.migrations})).current)throw new Error('PGSTREAM_NATIVE_RECEIPT_CATALOGUE');
  }
  const digests=(await query('SELECT DISTINCT contract_digest FROM '+relation+' WHERE consumer=$1',[consumer])).rows;
  if(digests.length>1||digests.some(r=>![previous,contractDigest].includes(r.contract_digest)))throw new Error('PGSTREAM_NATIVE_RECEIPT_MIXED_CONTRACT');
  let changed=0,after=null;
  if(digests[0]?.contract_digest===previous){
   await native.assertCurrent(client,selection,{nativeSource:{source:b.source,generation:b.generation}});
   for(;;){
    const {rows}=await query('SELECT c.tenant_id::text AS tenant,c.contract_digest,c.work_version,c.projection IS NULL AS empty,c.work_observed[5]::text AS observed,c.work_completed[5]::text AS completed,c.work_lifecycle_enabled,w.generation::text AS generation,w.phase,'+require('../tenant-lifecycle/pool-authority').executedDeletionSQL(b.lifecycleNamespace)+' AS deleted FROM '+relation+' c LEFT JOIN '+windows+' w ON w.tenant_id=c.tenant_id WHERE c.consumer=$1 AND ($2::uuid IS NULL OR c.tenant_id>$2) ORDER BY c.tenant_id LIMIT 64',[consumer,after]);
    if(!rows.length)break;
    const observations=[];
    for(const row of rows){
     if(!row.generation||row.deleted)throw new Error('PGSTREAM_NATIVE_RECEIPT_LIFETIME');
     const stamp=lifecycleStamp(row.generation,row.phase);
     checkLegacyReceipt(row);
     await work.initialize(client,relation,consumer,previous,row);
     observations.push({tenant:row.tenant,observed:{lifecycle:stamp},eligibility:{lifecycle:row.phase==='active'}});
    }
    await work.observeInTransaction({client,table,consumer,contractDigest:previous,observations});
    const updated=await query('UPDATE '+relation+' SET contract_digest=$1 WHERE consumer=$2 AND contract_digest=$3 AND tenant_id=ANY($4::uuid[])',[contractDigest,consumer,previous,rows.map(r=>r.tenant)]);
    if(updated.rowCount!==rows.length)throw new Error('PGSTREAM_NATIVE_RECEIPT_CUTOVER_CHANGED');
    changed+=updated.rowCount;after=rows.at(-1).tenant;
   }
  }
  if((await query('COMMIT')).command!=='COMMIT')throw new Error('PGSTREAM_NATIVE_RECEIPT_COMMIT_UNCONFIRMED');
  return changed;
 }catch(error){await query('ROLLBACK');throw error;}
}
module.exports={upgrade};
