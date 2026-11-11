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

function predicate (members, ordinal) {
  shape(members, ordinal);
  return Object.freeze(tenant => bucket(tenant, members) === ordinal);
}

module.exports = { RULE, MAX_MEMBERS, bucket, predicate, shape };
