'use strict';
const scope=require('../storage/tenant-scope');
const { createHash } = require('node:crypto');
const { canonical } = require('../server/serve/evaluator-runtime');
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const KIND = 'evaluator-work-v1';
const quote = name => '"' + name + '"';
const clone = value => JSON.parse(JSON.stringify(value));
const pending = state => Object.entries(state.observed).some(([key,value]) => state.completed[key] === undefined || BigInt(value) > BigInt(state.completed[key]));
function shape (projection) {
  const state=projection?.[0];
  if (!state || state.kind!==KIND || !state.observed || !state.completed) throw new Error('EVALUATOR_OUTPUT_NOT_READY');
  return state;
}
function create ({ connection, namespace, consumer, maxBytes, timeIntervalMs, now = Date.now }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || !/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer) ||
      !Number.isSafeInteger(maxBytes) || maxBytes<1 || !Number.isSafeInteger(timeIntervalMs) || timeIntervalMs<1) throw new TypeError('Explicit completed evaluator checkpoint required');
  const outputConsumer=consumer+'-completed', table=quote(namespace)+'.tenant_consumer_checkpoint', digest=hash([KIND,namespace,consumer]);
  let owner;
  const read=async tenant => {
    const rows=(await connection.query('SELECT projection,contract_digest FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows;
    if(rows.length!==1)throw new Error('EVALUATOR_OUTPUT_NOT_PROVISIONED');if(rows[0].contract_digest!==digest)throw new Error('EVALUATOR_OUTPUT_CONTRACT');return shape(rows[0].projection);
  };
  return Object.freeze({consumer:outputConsumer,digest,
    async own(onLoss) { owner=await connection.holdAdvisoryLock(BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',namespace,consumer]).slice(0,16))).toString(),onLoss); },
    observe(tenant,source,version,enabled) { return connection.observeEvaluator({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,tenant,source,version:String(version),...(enabled===undefined?{}:{enabled})}); },
    async begin(tenant) { return scope.withTenant(tenant,async()=>clone((await read(tenant)).observed)); },
    async complete(tenant,{observed,identity,result,restoreGeneration=null}) {
      if(!owner?.available)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');
      return owner.withTenant(tenant,async()=>{
        const rows=(await connection.query('SELECT projection,contract_digest FROM '+table+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,outputConsumer])).rows;
        if(rows[0]?.contract_digest!==digest)throw new Error('EVALUATOR_OUTPUT_CONTRACT');
        const state=shape(rows[0]?.projection);
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
        await connection.query('UPDATE '+table+' SET checkpoint=$3,projection=$4::jsonb WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer,result.checkpoint,encoded]);
        return {output,changed};
      });
    },
    async output(tenant,identity) { return scope.withTenant(tenant,async()=>{const state=await read(tenant),output=state.output;if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');if(!output || output.tenant!==tenant || output.identity!==identity)throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');return output;}); },
    async work(limit=64) {
      if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new TypeError('Bounded pending work required');
      // A partial expression index is provisioned with the selected deployment.
      const rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,projection FROM '+table+" WHERE consumer=$1 AND (projection->0->>'enabled')::boolean IS TRUE AND (((projection->0->>'pendingAt')::bigint IS NOT NULL) OR (projection->0->>'nextDueAt')::bigint<=$2) ORDER BY (projection->0->>'pendingAt')::bigint NULLS LAST,(projection->0->>'nextDueAt')::bigint NULLS LAST LIMIT $3",[outputConsumer,now(),limit])).rows;
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
module.exports={create,KIND,pending,shape};
