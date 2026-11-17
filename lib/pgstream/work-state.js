'use strict';
const SOURCES=Object.freeze(['clock','settings','policy','activity','lifecycle','bootstrap']);
const COLUMNS=Object.freeze(['work_version','work_observed','work_completed','work_observed_at','work_pending_at','work_due_at','work_completed_at','work_enabled','work_activity_enabled','work_lifecycle_enabled','delivery_revision','delivery_ack_revision','output_identity','output_digest','output_revision','output_restore_generation']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function version(value){if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('EVALUATOR_VERSION_REFUSED');const text=String(value);if(!/^(0|[1-9][0-9]{0,18})$/.test(text)||BigInt(text)>9223372036854775807n)throw new Error('EVALUATOR_VERSION_REFUSED');return text;}
function instant(value){if(value===null||value===undefined||value===Infinity)return null;if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.ceil(value))||value>=8640000000000000)throw new Error('EVALUATOR_DUE_RANGE');return Math.ceil(value);}
const array=map=>SOURCES.map(key=>map?.[key]===undefined?null:version(map[key]));
const map=values=>Object.fromEntries(SOURCES.flatMap((key,i)=>values?.[i]===null||values?.[i]===undefined?[]:[[key,String(values[i])]]));
function state(row){if(row.work_version!==2)throw new Error('EVALUATOR_TYPED_ADMISSION_REQUIRED');return {kind:'evaluator-work-v2',observed:map(row.work_observed),completed:map(row.work_completed),observedAt:map(row.work_observed_at),pendingAt:row.work_pending_at===null?null:Number(row.work_pending_at),nextDueAt:row.work_due_at===null?null:Number(row.work_due_at),enabled:row.work_enabled,eligibility:{activity:row.work_activity_enabled,lifecycle:row.work_lifecycle_enabled}};}
const select=COLUMNS.map(key=>['work_version','work_enabled','work_activity_enabled','work_lifecycle_enabled','work_observed','work_completed','work_observed_at','output_identity','output_digest'].includes(key)?key:key+'::text AS '+key).join(',');
function validateReceipts({table,consumer,observations}){
 if(!/^[a-z][a-z0-9_]{0,62}\.tenant_consumer_checkpoint$/.test(table)||!/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(consumer)||!Array.isArray(observations)||!observations.length||observations.length>64||Buffer.byteLength(JSON.stringify(observations))>262144||new Set(observations.map(r=>r.tenant)).size!==observations.length)throw new TypeError('EVALUATOR_RECEIPT_BATCH_BOUND');
 for(const row of observations){if(!UUID.test(row.tenant)||!row.observed||!Object.keys(row.observed).length||Object.keys(row.observed).some(k=>!SOURCES.includes(k)))throw new TypeError('EVALUATOR_RECEIPT_SHAPE');Object.values(row.observed).forEach(version);if(row.eligibility&&Object.entries(row.eligibility).some(([k,v])=>!['activity','lifecycle'].includes(k)||typeof v!=='boolean'))throw new TypeError('EVALUATOR_RECEIPT_ELIGIBILITY');}
}
async function observeInTransaction({client,table,consumer,contractDigest,observations,at}){
 validateReceipts({table,consumer,observations});
 const relation='"'+table.split('.')[0]+'".tenant_consumer_checkpoint';
 const rows=(await client.query('SELECT tenant_id::text AS tenant,contract_digest,'+select+' FROM '+relation+' WHERE consumer=$1 AND tenant_id=ANY($2::uuid[]) ORDER BY tenant_id FOR UPDATE',[consumer,observations.map(r=>r.tenant)])).rows;
 if(rows.length!==observations.length)throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');at=at===undefined?Date.now():instant(at);const saved=new Map(rows.map(row=>[row.tenant,row])),patches=[],results=[];
 for(const observation of observations){const row=saved.get(observation.tenant);if(row.contract_digest!==contractDigest)throw new Error('EVALUATOR_RECEIPT_CONTRACT');const current=state(row);let changed=false,control=false;
 for(const [source,value]of Object.entries(observation.observed)){const exact=version(value),old=current.observed[source];if(old!==undefined&&BigInt(exact)<=BigInt(old))continue;changed=true;current.observed[source]=exact;current.observedAt[source]=at;if(current.pendingAt===null)current.pendingAt=at;if(['activity','policy','lifecycle'].includes(source))control=true;if(observation.eligibility?.[source]!==undefined)current.eligibility[source]=observation.eligibility[source];}
 current.enabled=Object.values(current.eligibility).every(Boolean);
 if(changed)patches.push({tenant:observation.tenant,observed:array(current.observed),observed_at:array(current.observedAt),pending_at:current.pendingAt,enabled:current.enabled,activity:current.eligibility.activity,lifecycle:current.eligibility.lifecycle,control});// The committed revision is the delivery obligation; realtime owns its progress.
 current.deliveryPending=changed&&control;results.push(current);}
 if(patches.length){const result=await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS p(tenant uuid,observed bigint[],observed_at bigint[],pending_at bigint,enabled boolean,activity boolean,lifecycle boolean,control boolean)) UPDATE ${relation} c SET work_observed=p.observed,work_observed_at=p.observed_at,work_pending_at=p.pending_at,work_enabled=p.enabled,work_activity_enabled=p.activity,work_lifecycle_enabled=p.lifecycle,delivery_revision=c.delivery_revision+CASE WHEN p.control THEN 1 ELSE 0 END FROM input p WHERE c.consumer=$1 AND c.tenant_id=p.tenant AND c.work_version=2`,[consumer,JSON.stringify(patches)]);if(result.rowCount!==patches.length)throw new Error('EVALUATOR_RECEIPT_NOT_PROVISIONED');}
 return results;
}
async function observe({pool,observeBackend,...options}){
 validateReceipts(options);
 const client=await pool.connect();let failure;
 try{await observeBackend(client);await client.query('BEGIN');const results=await observeInTransaction({client,...options});
 const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('EVALUATOR_RECEIPT_COMMIT_UNCONFIRMED');return results;
 }catch(error){failure=error;try{await client.query('ROLLBACK');}catch{ /* Failed connection is evicted below. */ }throw error;}finally{client.release(failure);}
}
async function admit({pool,observeBackend,table,consumer,digest,tenants}){
 if(!/^[a-z][a-z0-9_]{0,62}\.tenant_consumer_checkpoint$/.test(table)||!/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(consumer)||!Array.isArray(tenants)||tenants.some(id=>!UUID.test(id))||new Set(tenants).size!==tenants.length)throw new TypeError('Bounded evaluator admission roster required');
 const relation='"'+table.split('.')[0]+'".tenant_consumer_checkpoint';
 for(let offset=0;offset<tenants.length;offset+=64){const client=await pool.connect();let failure;try{await observeBackend(client);await client.query('BEGIN');
 const rows=(await client.query(`SELECT tenant_id::text AS tenant,contract_digest,work_version,projection IS NULL AS empty FROM ${relation} WHERE consumer=$1 AND tenant_id=ANY($2::uuid[]) ORDER BY tenant_id FOR UPDATE`,[consumer,tenants.slice(offset,offset+64)])).rows;
 if(rows.length!==tenants.slice(offset,offset+64).length)throw new Error('EVALUATOR_OUTPUT_NOT_PROVISIONED');
 for(const row of rows){
  if(row.contract_digest!==digest)throw new Error('EVALUATOR_OUTPUT_CONTRACT');
  if(row.work_version===2)continue;
  // Only a freshly provisioned empty row may initialize the current format.
  // Experimental v1 output and progress are never promoted or reset silently.
  if(row.work_version!==0||!row.empty)throw new Error('EVALUATOR_OUTPUT_CONTRACT');
  const changed=await client.query(`UPDATE ${relation} SET work_version=2,work_observed=$3,work_completed=$3,work_observed_at=$3,projection=jsonb_build_array(jsonb_build_object('kind','evaluator-work-v2','output',NULL)) WHERE tenant_id=$1 AND consumer=$2 AND work_version=0 AND projection IS NULL`,[row.tenant,consumer,array({})]);
  if(changed.rowCount!==1)throw new Error('EVALUATOR_OUTPUT_NOT_PROVISIONED');
 }const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('EVALUATOR_ADMISSION_COMMIT_UNCONFIRMED');
 }catch(error){failure=error;try{await client.query('ROLLBACK');}catch{ /* Failed connection is evicted below. */ }throw error;}finally{client.release(failure);}}
}
module.exports={SOURCES,COLUMNS,select,state,version,instant,array,map,observe,validateReceipts,observeInTransaction,admit};
