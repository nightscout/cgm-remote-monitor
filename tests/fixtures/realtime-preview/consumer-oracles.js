'use strict';
// Native driver oracles, also exercised with synthetic source vectors. A missing
// causal boundary is setup/deadline failure, never an expected semantic red.
const assert = require('node:assert/strict'), {isDeepStrictEqual: same} = require('node:util');
function bounded (rows, limits) {
  if (!Array.isArray(rows) || rows.length > limits.maxRows || Buffer.byteLength(JSON.stringify(rows)) > limits.maxBytes) throw new Error('CONSUMER_ORACLE_SNAPSHOT_BOUND');
  return rows;
}
function bindAttempt (attempt, rows, first) {
  const matching = rows.filter(row => row.tenant_id === attempt.tenant && row.state === 'attempting' && row.attempt === attempt.attempt && same(row.payload, attempt.notification) &&
    (!first || row.origin === first.durable.origin && row.config_identity === first.durable.config_identity && row.dedup_key === first.durable.dedup_key));
  // Unrelated new-cycle sends are retained as raw observations, not retry proof.
  if (first && matching.length === 0) return null;
  if (matching.length !== 1) throw new Error('CONSUMER_RELAY_EFFECT_NOT_UNIQUE');
  return matching[0];
}
function retryBoundary (attempts, tenant) {
  const first = attempts.find(row => row.tenant === tenant && row.responseLost === true);
  const retry = first && attempts.find(row => row !== first && row.tenant === tenant && row.attempt >= 2 && row.durable &&
    row.durable.origin === first.durable.origin && row.durable.config_identity === first.durable.config_identity &&
    row.durable.dedup_key === first.durable.dedup_key && same(row.notification, first.notification));
  return retry ? {first, retry} : null;
}
function disposition (label, record, verify) {
  assert.match(label, /^[A-Z][A-Z0-9_]{0,95}$/);
  try { return verify(); } catch (error) {
    if (error instanceof assert.AssertionError) record({semanticFailure:{name:'AssertionError',code:'ERR_ASSERTION',message:label}});
    throw error;
  }
}
function retry (physical, record) {
  record({retryPhysical:physical});
  return disposition('CONSUMER_UNCERTAIN_SAME_ID',record,()=>{
    const {first,retry,rows}=physical;
    assert.equal(first.durable.tenant_id,first.tenant,'CONSUMER_RETRY_TENANT');
    assert.equal(retry.durable.tenant_id,first.tenant,'CONSUMER_RETRY_TENANT');
    assert.equal(first.id,first.durable.request_id,'CONSUMER_UNCERTAIN_SAME_ID');
    assert.equal(retry.id,first.id,'CONSUMER_UNCERTAIN_SAME_ID');
    assert.equal(retry.durable.request_id,first.durable.request_id,'CONSUMER_UNCERTAIN_SAME_ID');
    assert.deepEqual(retry.notification,first.notification,'CONSUMER_RETRY_UNCHANGED_PAYLOAD');
    const stored=rows.find(row=>row.request_id===first.durable.request_id);
    assert(stored,'CONSUMER_RETRY_ORIGINAL_PHYSICAL_REQUEST');
    assert.deepEqual(stored.payload,first.notification,'CONSUMER_PERSISTED_PAYLOAD');
    return stored;
  });
}
function ackKeys (rows) {
  if (!Array.isArray(rows) || rows.length !== 2 || ![1,2].every(level=>rows.some(row=>row.alarm_level===level))) throw new Error('CONSUMER_ACK_COMMIT_PRECONDITION');
  return rows.map(row=>{
    const at=Number(row.acked_at),expiry=Number(row.expires_at);
    if (!Number.isSafeInteger(at)||!Number.isSafeInteger(expiry)||expiry<=at) throw new Error('CONSUMER_ACK_COMMIT_PRECONDITION');
    return JSON.stringify([row.alarm_group,row.alarm_level,at,expiry]);
  });
}
function consumed (producer, keys, beforeRevision) {
  return producer && Number.isSafeInteger(Number(producer.revision)) && Number(producer.revision)>Number(beforeRevision) &&
    Array.isArray(producer.producer?.acks) && keys.every(key=>producer.producer.acks.includes(key));
}
function clear (physical, record) {
  record({coldAckPhysical:physical});
  return disposition('CONSUMER_COLD_ACK_CLEAR_INTENT_MISSING',record,()=>{
    assert(consumed(physical.producer,physical.ackKeys,physical.beforeRevision),'CONSUMER_COLD_ACK_CONSUMPTION_REQUIRED');
    const effects=physical.producer.producer.effects.filter(row=>row.payload.clear===true);
    assert(effects.length>0,'CONSUMER_COLD_ACK_CLEAR_INTENT_MISSING');
    const request=physical.rows.find(row=>!physical.beforeAckRequestIds.includes(row.request_id)&&row.payload.clear===true&&
      effects.some(effect=>effect.origin===row.origin&&same(effect.payload,row.payload)));
    assert(request,'CONSUMER_COLD_ACK_CLEAR_INTENT_MISSING');
    return request;
  });
}
module.exports={bounded,bindAttempt,retryBoundary,retry,ackKeys,consumed,clear};
