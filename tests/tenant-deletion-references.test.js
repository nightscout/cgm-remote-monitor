'use strict';
// Source reference classification only; exclusion and physical SQL are native criteria.
const assert = require('node:assert/strict');
const references = require('../lib/tenant-lifecycle/deletion-references');
const profiles = require('../lib/pgstream/pool-intake-profile');
const slice = require('../lib/pool-membership/slice');
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_operator', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: slice.RULE });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const input = () => ({ step: { kind: 'evaluator_checkpoint', table: 'tenant_consumer_checkpoint', namespace: profile.binding.namespace }, tenant: A,
  descriptor: { profile, rows: [{ namespace: profile.binding.namespace, consumer: profile.binding.consumer, digest: 'a'.repeat(64) }] },
  desired: { members: 3, revision: '8', rule: slice.RULE }, notificationBindings: [{ namespace: 'synthetic_outbox', consumer: 'route_a' }],
  rows: [{ tenant_id: A, consumer: profile.binding.consumer, contract_digest: 'a'.repeat(64), checkpoint: '2000', projection: [] },
    { tenant_id: A, consumer: profile.binding.consumer + '-completed', contract_digest: profile.contractDigest, work_version: 2,
      work_assignment_revision: '8', work_owner_ordinal: slice.bucket(A, 3), projection: [{ output: 'changed after export' }] }] });
describe('selected deletion mutable reference inventory', function () {
  it('admits changed checkpoint contents only with complete current descriptors and assignment', function () {
    assert.equal(references.currentCount(input()), 2);
    const clinical = input(); clinical.step = { kind: 'entries', table: 'entries', namespace: 'synthetic_entries' };
    assert.equal(references.currentCount(clinical), null, 'authoritative clinical rows retain exact artifact comparison');
  });
  it('refuses absent, unknown, stale, duplicate and foreign current checkpoints', function () {
    for (const change of [value => { value.rows.pop(); }, value => { value.rows[0].consumer = 'unknown'; }, value => { value.rows[0].contract_digest = 'b'.repeat(64); },
      value => { value.rows[1].work_assignment_revision = '7'; }, value => { value.rows[1].work_owner_ordinal = (value.rows[1].work_owner_ordinal + 1) % 3; },
      value => { value.rows[1].work_version = 1; }, value => { value.rows[0].tenant_id = B; }, value => { value.rows.push(value.rows[0]); }]) {
      const value = input(); change(value); assert.throws(() => references.currentCount(value));
    }
  });
  it('uses current outbox counts but refuses every undeclared namespace/consumer and leaves authoritative credential tables exact', function () {
    const value = input(); value.step = { kind: 'notification_outbox', table: 'tenant_notification_requests', namespace: 'synthetic_outbox' };
    value.rows = [{ tenant_id: A, consumer: 'route_a', state: 'uncertain' }]; assert.equal(references.currentCount(value), 1);
    value.rows[0].consumer = 'route_b'; assert.throws(() => references.currentCount(value), { code: 'LIFECYCLE_DELETION_NOTIFICATION_INVALID' });
    value.rows = []; value.step.namespace = 'foreign_outbox'; assert.throws(() => references.currentCount(value), { code: 'LIFECYCLE_DELETION_NOTIFICATION_INVALID' });
    value.step = { kind: 'legacy', table: 'legacy_credential_config', namespace: 'synthetic_legacy' }; assert.equal(references.currentCount(value), null);
  });
  it('makes a missing current checkpoint green only after its completeness guard is broken, then restores the refusal', function () {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const filename = require.resolve('../lib/tenant-lifecycle/deletion-references'), source = fs.readFileSync(filename, 'utf8');
    const guard = "if (!expected.size || rows.length !== expected.size) throw refuse('LIFECYCLE_DELETION_CHECKPOINT_REQUIRED');"; assert.equal(source.split(guard).length, 2);
    const broken = new Module(filename, module); broken.filename = filename; broken.paths = Module._nodeModulePaths(path.dirname(filename)); broken._compile(source.replace(guard, ''), filename);
    const value = input(); value.rows.pop(); let red = false;
    try { assert.throws(() => broken.exports.currentCount(value)); } catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected exception/); red = true; }
    assert(red); assert.throws(() => references.currentCount(value), { code: 'LIFECYCLE_DELETION_CHECKPOINT_REQUIRED' });
  });
});
