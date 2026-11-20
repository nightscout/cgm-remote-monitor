'use strict';

// The slice function shared by every partitioned pool kind (decisions
// evaluator-static-partition and pool-primitive-shared): a tenant belongs to
// the member whose ordinal equals sha256(canonical tenant id) mod member count.
// Plain modulo; a change of rule is a new RULE name, never an edit of this one.
const { createHash } = require('node:crypto');

const RULE = 'sha256-modulo-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MEMBERS = 1024;

function shape (members, ordinal) {
  if (!Number.isSafeInteger(members) || members < 1 || members > MAX_MEMBERS ||
      !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= members) {
    throw new TypeError('Pool slice requires 1 <= members <= ' + MAX_MEMBERS + ' and 0 <= ordinal < members');
  }
}

// Canonical tenant ids are lower-case UUIDs; anything else is refused rather
// than hashed under a second spelling.
function bucket (tenant, members) {
  if (typeof tenant !== 'string' || !UUID.test(tenant)) throw new TypeError('Canonical tenant id required');
  shape(members, 0);
  const prefix = createHash('sha256').update(tenant, 'utf8').digest().readBigUInt64BE(0);
  return Number(prefix % BigInt(members));
}

// An ordinal at or above the member count owns nothing (decision
// statefulset-ordinal-scaling): no tenant hashes to it, and it is not refused.
function idle (members, ordinal) {
  shape(members, 0);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_MEMBERS) shape(members, ordinal);
  return ordinal >= members;
}

function predicate (members, ordinal) {
  if (idle(members, ordinal)) return Object.freeze(() => false);
  return Object.freeze(tenant => bucket(tenant, members) === ordinal);
}

// Apply the same unsigned 64-bit prefix in PostgreSQL. Toggling its sign bit
// before the signed bigint cast shifts the range by exactly 2^63.
function sqlPredicate (members, ordinal, column = 'tenant_id') {
  if (!['tenant_id', 'r.tenant_id'].includes(column)) throw new TypeError('Fixed tenant column required');
  if (idle(members, ordinal)) return 'FALSE';
  if (members === 1) return 'TRUE';
  const hex = `substr(encode(sha256(convert_to(${column}::text,'UTF8')),'hex'),1,16)`;
  const signed = "(('x'||" + hex + ")::bit(64) # x'8000000000000000')::bigint";
  return 'mod(' + signed + '::numeric + 9223372036854775808, ' + members + ') = ' + ordinal;
}

// A process's slice from its environment (decision statefulset-ordinal-scaling,
// the hashmod shard pattern): NS_SLICE_ORDINAL is the StatefulSet pod index or
// the Compose service index; NS_SLICE_COUNT is K, rendered from the one value
// that also sets the replica count. Neither set is {count: 1, ordinal: 0}. An
// ordinal at or above K is not refused: no tenant hashes to it, so it owns
// nothing. Keeping replicas equal to K is the platform's job.
const DECIMAL = /^(?:0|[1-9][0-9]{0,3})$/;
function fromEnvironment (source = process.env) {
  const ordinal = source.NS_SLICE_ORDINAL ?? '0', count = source.NS_SLICE_COUNT ?? '1';
  if (!DECIMAL.test(ordinal) || !DECIMAL.test(count)) throw new TypeError('NS_SLICE_ORDINAL and NS_SLICE_COUNT must be decimal integers');
  shape(Number(count), 0);
  return Object.freeze({ count: Number(count), ordinal: Number(ordinal) });
}

module.exports = { RULE, MAX_MEMBERS, bucket, idle, predicate, sqlPredicate, shape, fromEnvironment };
