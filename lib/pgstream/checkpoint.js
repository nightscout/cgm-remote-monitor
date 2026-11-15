'use strict';
const scope=require('../storage/tenant-scope');
const { createHash } = require('node:crypto');
const { canonical } = require('../server/serve/evaluator-runtime');
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const KIND = 'evaluator-work-v1';
const quote = name => '"' + name + '"';
const clone = value => JSON.parse(JSON.stringify(value));
const contentOf = output => hash({identity:output.identity,checkpoint:output.result.checkpoint,properties:output.result.properties,emitted:output.result.emitted,requested:output.result.requested,rows:output.rows,frame:{...output.frame,lastUpdated:0}});
const summaryOf = output => { const summary={...output};delete summary.rows;delete summary.frame;delete summary.runtimeId;return summary; };
const pending = state => Object.entries(state.observed).some(([key,value]) => state.completed[key] === undefined || BigInt(value) > BigInt(state.completed[key]));
function shape (projection) {
  const state=projection?.[0];
  if (!state || state.kind!==KIND || !state.observed || !state.completed) throw new Error('EVALUATOR_OUTPUT_NOT_READY');
  return state;
}
function create ({ connection, namespace, consumer, maxBytes, timeIntervalMs, now = Date.now, typed = false, onCommit, partition }) {
  if (partition !== undefined && !typed) throw new TypeError('EVALUATOR_PARTITION_TYPED_REQUIRED');
  if (typed) return require('./typed-checkpoint').create({connection,namespace,consumer,maxBytes,timeIntervalMs,now,onCommit,partition});
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer) ||
      !Number.isSafeInteger(maxBytes) || maxBytes<1 || !Number.isSafeInteger(timeIntervalMs) || timeIntervalMs<1) throw new TypeError('Explicit completed evaluator checkpoint required');
  const outputConsumer=consumer+'-completed', table=quote(namespace)+'.tenant_consumer_checkpoint', digest=hash([KIND,namespace,consumer]);
  let owner;
  // Realtime consumes only the completed frame/rows and their control envelope;
  // the retained clinical result belongs to evaluator completion, not delivery.
  const selectedState = fields => "jsonb_build_array(jsonb_build_object(" + fields.map(field => "'"+field+"',"+(field==='output'?"(projection->0->'output')-'result'":"projection->0->'"+field+"'")).join(',') + ")) AS projection";
  const read=async (tenant, fields) => {
    const rows=(await connection.query('SELECT '+(fields ? selectedState(fields) : 'projection')+',contract_digest FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows;
    if(rows.length!==1)throw new Error('EVALUATOR_OUTPUT_NOT_PROVISIONED');if(rows[0].contract_digest!==digest)throw new Error('EVALUATOR_OUTPUT_CONTRACT');return shape(rows[0].projection);
  };
  return Object.freeze({consumer:outputConsumer,digest,
    async own(onLoss) { owner=await connection.holdAdvisoryLock(BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',namespace,consumer]).slice(0,16))).toString(),onLoss); },
    observe(tenant,source,version,enabled) { return connection.observeEvaluator({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,tenant,source,version:String(version),...(enabled===undefined?{}:{enabled})}); },
    observeMany(observations) { return connection.observeEvaluatorMany({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,
      observations:observations.map(row=>({...row,observed:Object.fromEntries(Object.entries(row.observed).map(([key,value])=>[key,String(value)]))}))}); },
    async begin(tenant) { return scope.withTenant(tenant,async()=>(await read(tenant,['kind','observed','completed'])).observed); },
    async complete(tenant,{observed,identity,result,restoreGeneration=null,retainedOutput}) {
      if(!owner?.available)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');
      return owner.withTenant(tenant,async()=>{
        const rows=(await connection.query('SELECT jsonb_build_array((projection->0)-\'output\') AS projection,CASE WHEN jsonb_typeof(projection->0->\'output\')=\'object\' THEN (projection->0->\'output\')-\'rows\'-\'frame\' ELSE NULL END AS output_summary,projection->0->\'output\'->\'frame\'->\'lastUpdated\' AS frame_at,contract_digest FROM '+table+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,outputConsumer])).rows;
        if(rows[0]?.contract_digest!==digest)throw new Error('EVALUATOR_OUTPUT_CONTRACT');
        const state=shape(rows[0]?.projection), summary=rows[0].output_summary;
        // The existing runtime output is a hint, never authority. Match the
        // locked persisted envelope and rehash its clinical content before
        // avoiding the large frame/rows transfer. Cold/replaced/mutated hints
        // fall back to the same owner transaction's physical output.
        let previous=null;
        if(summary){
          try {
            if(retainedOutput?.tenant===tenant && retainedOutput.frame?.lastUpdated===rows[0].frame_at &&
                canonical(summaryOf(retainedOutput))===canonical(summary) && contentOf(retainedOutput)===summary.contentDigest) previous={...summary,rows:retainedOutput.rows,frame:retainedOutput.frame};
          } catch { /* An unusable hint must not prevent physical recovery. */ }
          if(!previous)previous=(await connection.query('SELECT projection->0->\'output\' AS output FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0].output;
        }
        state.output=previous;
        for(const [key,value]of Object.entries(observed)){
          if(state.observed[key]===undefined || BigInt(value)>BigInt(state.observed[key]) || state.completed[key]!==undefined && BigInt(value)<BigInt(state.completed[key]))throw new Error('EVALUATOR_COMPLETION_VERSION_REFUSED');
        }
        const content=hash({identity,checkpoint:result.checkpoint,properties:result.properties,emitted:result.emitted,requested:result.requested,rows:result.encodedRows??result.rows,frame:{...result.frame,lastUpdated:0}});
        const changed=!state.output || state.output.contentDigest!==content;
        const outputRevision=changed?(state.output?.outputRevision||0)+1:state.output.outputRevision;
        const at=now(), next=Math.min(result.due?.dueAt??Infinity,result.due?.slow?.length?at+timeIntervalMs:Infinity);
        const persistedResult={...result};delete persistedResult.encodedRows;delete persistedResult.frame;
        const output=changed||state.output?.restoreGeneration!==restoreGeneration?{tenant,identity,restoreGeneration,outputRevision,contentDigest:content,inputCheckpoint:result.checkpoint,
          checkpoint:result.checkpoint,trigger:result.trigger,result:persistedResult,rows:result.encodedRows??result.rows,frame:result.frame}:state.output;
        state.completed=clone(observed);state.nextDueAt=Number.isFinite(next)?next:null;state.output=output;
        const remaining=Object.entries(state.observed).filter(([key,value])=>state.completed[key]===undefined||BigInt(value)>BigInt(state.completed[key]));
        state.pendingAt=remaining.length?Math.min(...remaining.map(([key])=>state.observedAt?.[key]??state.pendingAt??at)):null;state.completedAt=at;
        const encoded=JSON.stringify([state]);if(Buffer.byteLength(encoded)>maxBytes)throw new Error('EVALUATOR_OUTPUT_BYTE_BOUND');
        const patch={...state};
        if(output===previous)delete patch.output;
        await connection.query('UPDATE '+table+' SET checkpoint=$3,projection=jsonb_build_array((projection->0)||$4::jsonb) WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer,result.checkpoint,JSON.stringify(patch)]);
        return {output,changed};
      });
    },
    async output(tenant,identity) { return scope.withTenant(tenant,async()=>{const state=await read(tenant,['kind','enabled','observed','completed','output']),output=state.output;if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');if(!output || output.tenant!==tenant || output.identity!==identity)throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');return output;}); },
    async work(limit=64) {
      if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new TypeError('Bounded pending work required');
      // A partial expression index is provisioned with the selected deployment.
      const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,'+selectedState(['kind','observed','completed','pendingAt'])+' FROM '+table+" WHERE consumer=$1 AND (projection->0->>'enabled')::boolean IS TRUE AND (((projection->0->>'pendingAt')::bigint IS NOT NULL) OR (projection->0->>'nextDueAt')::bigint<=$2) ORDER BY (projection->0->>'pendingAt')::bigint NULLS LAST,(projection->0->>'nextDueAt')::bigint NULLS LAST LIMIT $3",[outputConsumer,now(),limit])).rows;
      return rows.map(row=>({tenant:row.tenant,...shape(row.projection)}));
    },
    async health() {
      const rows=(await connection.readOnly('SELECT min((projection->0->>\'pendingAt\')::bigint)::text AS oldest FROM '+table+" WHERE consumer=$1 AND (projection->0->>'enabled')::boolean IS TRUE AND (projection->0->>'pendingAt') IS NOT NULL",[outputConsumer])).rows;
      return {pending:rows[0]?.oldest!==null && rows[0]?.oldest!==undefined,oldestPendingAt:rows[0]?.oldest===null?null:Number(rows[0]?.oldest)};
    },
    async close() { await owner?.close(); },
    get available() { return owner?.available===true; }
  });
}
module.exports={create,KIND,pending,shape,WORK_COLUMNS:require('./work-state').COLUMNS};
