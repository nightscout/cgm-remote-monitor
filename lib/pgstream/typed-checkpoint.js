'use strict';
const scope=require('../storage/tenant-scope');
const work=require('./work-state');
const {createHash}=require('node:crypto');
const {canonical}=require('../server/serve/evaluator-runtime');
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const KIND='evaluator-work-v2';
const contentOf=output=>hash({identity:output.identity,checkpoint:output.result.checkpoint,properties:output.result.properties,emitted:output.result.emitted,requested:output.result.requested,rows:output.rows,frame:{...output.frame,lastUpdated:0}});
const summaryOf=output=>{const body=bodyOf(output);delete body.rows;delete body.frame;return body;};
const bodyOf=output=>{const body={...output};for(const key of ['identity','contentDigest','outputRevision','restoreGeneration','runtimeId'])delete body[key];return body;};
function create({connection,namespace,consumer,maxBytes,timeIntervalMs,now=Date.now}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Explicit typed evaluator checkpoint required');
 const outputConsumer=consumer+'-completed',table='"'+namespace+'".tenant_consumer_checkpoint',digest=hash([KIND,namespace,consumer]),legacyDigest=hash(['evaluator-work-v1',namespace,consumer]);let owner;
 const check=row=>{if(!row||row.contract_digest!==digest||row.work_version!==2)throw new Error('EVALUATOR_OUTPUT_CONTRACT');return row;};
 const envelope=(row,body)=>body?{...body,identity:row.output_identity,contentDigest:row.output_digest,outputRevision:Number(row.output_revision),restoreGeneration:row.output_restore_generation===null?null:work.version(row.output_restore_generation)}:null;
 const retained=(row,value)=>{try{return value&&value.tenant===row.tenant&&value.identity===row.output_identity&&value.contentDigest===row.output_digest&&String(value.outputRevision)===row.output_revision&&(value.restoreGeneration===null?null:String(value.restoreGeneration))===row.output_restore_generation&&value.frame?.lastUpdated===row.frame_at&&canonical(summaryOf(value))===canonical(row.output_summary)&&contentOf(value)===row.output_digest;}catch{return false;}};
 const compact=",CASE WHEN jsonb_typeof(projection->0->'output')='object' THEN (projection->0->'output')-'rows'-'frame' ELSE NULL END AS output_summary,projection->0->'output'->'frame'->'lastUpdated' AS frame_at";
 const deliveryHints=new WeakMap();
 const deliveryCompact=",CASE WHEN jsonb_typeof(projection->0->'output')='object' THEN (projection->0->'output')-'rows'-'frame'-'result' ELSE NULL END AS output_summary,projection->0->'output'->'frame'->'lastUpdated' AS frame_at";
 const deliveryRetained=(row,value)=>{try{return value&&deliveryHints.has(value)&&value.tenant===row.tenant&&value.identity===row.output_identity&&value.contentDigest===row.output_digest&&String(value.outputRevision)===row.output_revision&&(value.restoreGeneration===null?null:String(value.restoreGeneration))===row.output_restore_generation&&value.frame?.lastUpdated===row.frame_at&&canonical(summaryOf(value))===canonical(row.output_summary)&&deliveryHints.get(value)===hash({rows:value.rows,frame:value.frame});}catch{return false;}};
 const read=async tenant=>check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+work.select+compact+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]);
 async function physical(tenant,row){const body=(await connection.query("SELECT projection->0->'output' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]?.output;return envelope(row,body);}
 return Object.freeze({consumer:outputConsumer,digest,
 async admit(tenants){return connection.admitEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,digest,legacyDigest,tenants:[...tenants]});},
 async own(onLoss){owner=await connection.holdAdvisoryLock(BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',namespace,consumer]).slice(0,16))).toString(),onLoss);},
 async observe(tenant,source,version,enabled){return (await connection.observeEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,observations:[{tenant,observed:{[source]:work.version(version)},...(enabled===undefined?{}:{eligibility:{[source]:enabled}})}]}))[0];},
 observeMany(observations){return connection.observeEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,observations});},
 async begin(tenant){return scope.withTenant(tenant,async()=>work.state(await read(tenant)).observed);},
 async complete(tenant,{observed,identity,result,restoreGeneration=null,retainedOutput}){
 if(!owner?.available)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');return owner.withTenant(tenant,async()=>{
 const row=check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+work.select+compact+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,outputConsumer])).rows[0]),state=work.state(row);
 for(const [key,value]of Object.entries(observed)){const exact=work.version(value);if(state.observed[key]===undefined||BigInt(exact)>BigInt(state.observed[key])||state.completed[key]!==undefined&&BigInt(exact)<BigInt(state.completed[key]))throw new Error('EVALUATOR_COMPLETION_VERSION_REFUSED');}
 const content=hash({identity,checkpoint:result.checkpoint,properties:result.properties,emitted:result.emitted,requested:result.requested,rows:result.encodedRows??result.rows,frame:{...result.frame,lastUpdated:0}}),changed=row.output_digest!==content;
 const restore=restoreGeneration===null?null:work.version(restoreGeneration),replace=changed||row.output_restore_generation!==restore;
 const revision=changed?Number(row.output_revision)+1:Number(row.output_revision);if(!Number.isSafeInteger(revision))throw new Error('EVALUATOR_OUTPUT_REVISION_EXHAUSTED');
 let output;if(replace){const saved={...result};delete saved.encodedRows;delete saved.frame;output={tenant,identity,restoreGeneration:restore,outputRevision:revision,contentDigest:content,inputCheckpoint:result.checkpoint,checkpoint:result.checkpoint,trigger:result.trigger,result:saved,rows:result.encodedRows??result.rows,frame:result.frame};}else output=retained(row,retainedOutput)?retainedOutput:await physical(tenant,row);
 const next=Math.min(result.due?.dueAt??Infinity,result.due?.slow?.length?now()+timeIntervalMs:Infinity),remaining=Object.entries(state.observed).filter(([key,value])=>observed[key]===undefined||BigInt(value)>BigInt(observed[key])),pendingAt=remaining.length?Math.min(...remaining.map(([key])=>Number(state.observedAt[key]??state.pendingAt??now()))):null;
 const projection=replace?JSON.stringify([{kind:KIND,output:bodyOf(output)}]):null;if(projection&&Buffer.byteLength(projection)>maxBytes)throw new Error('EVALUATOR_OUTPUT_BYTE_BOUND');
 await connection.query('UPDATE '+table+' SET checkpoint=$3,work_completed=$4,work_due_at=$5,work_pending_at=$6,work_completed_at=$7,output_identity=$8,output_digest=$9,output_revision=$10,output_restore_generation=$11,delivery_revision=delivery_revision+$12'+(replace?',projection=$13::jsonb':'')+' WHERE tenant_id=$1 AND consumer=$2 AND work_version=2',[tenant,outputConsumer,result.checkpoint,work.array(observed),work.instant(next),pendingAt,now(),identity,content,revision,restore,replace?1:0,...(replace?[projection]:[])]);
 return {output,changed};});},
 async output(tenant,identity,{retained:hint,delivery=false}={}){
   if(delivery)return scope.withTenant(tenant,()=>connection.snapshotTransaction(async()=>{
     // Metadata and a cold physical frame share one repeatable snapshot. A
     // concurrent evaluator completion cannot mix two output revisions.
     const row=check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+work.select+deliveryCompact+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]);
     const state=work.state(row);
     if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');
     if(row.output_identity!==identity||row.output_revision==='0')throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');
     if(deliveryRetained(row,hint))return hint;
     const body=(await connection.query("SELECT (projection->0->'output')-'result' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]?.output;
     const value=envelope(row,body);if(value)deliveryHints.set(value,hash({rows:value.rows,frame:value.frame}));
     return value;
   }));
   return scope.withTenant(tenant,async()=>{const row=await read(tenant),state=work.state(row);if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');if(row.output_identity!==identity||row.output_revision==='0')throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');return retained(row,hint)?hint:physical(tenant,row);});
 },
 async work(limit=64,{after=null}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new TypeError('Bounded pending work required');const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,'+work.select+' FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled AND (work_pending_at IS NOT NULL OR work_due_at<=$2) AND ($4::uuid IS NULL OR tenant_id>$4::uuid) ORDER BY tenant_id LIMIT $3',[outputConsumer,now(),limit,after])).rows;return rows.map(row=>({tenant:row.tenant,...work.state(row)}));},
 async nextDue(){const row=(await connection.readOnly('SELECT min(work_due_at)::text AS due FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled AND work_due_at IS NOT NULL',[outputConsumer])).rows[0];return row?.due===null||row?.due===undefined?null:Number(row.due);},
 async deliveries(limit=64){return (await connection.readOnly('SELECT tenant_id::text AS tenant,delivery_revision::text AS revision FROM '+table+' WHERE consumer=$1 AND work_version=2 AND delivery_revision>delivery_ack_revision ORDER BY tenant_id LIMIT $2',[outputConsumer,limit])).rows;},
 async acknowledge(tenant,revision){await connection.acknowledgeEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,tenant,revision:work.version(revision)});},
 async health(){const row=(await connection.readOnly('SELECT min(work_pending_at)::text AS oldest FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled AND work_pending_at IS NOT NULL',[outputConsumer])).rows[0];return {pending:row?.oldest!==null&&row?.oldest!==undefined,oldestPendingAt:row?.oldest===null?null:Number(row?.oldest)};},
 async close(){await owner?.close();},get available(){return owner?.available===true;}
 });
}
module.exports={create,KIND,WORK_COLUMNS:work.COLUMNS};
