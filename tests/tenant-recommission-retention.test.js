'use strict';
// Recording retention admission only; database row locks/provider key usability are native criteria.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const retention = require('../lib/tenant-lifecycle/key-retention');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const candidate = require('../lib/tenant-lifecycle/postgres-candidate.json');
const A = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const keys = [{ mount: 'transit', name: 'synthetic-data' }, { mount: 'transit', name: 'synthetic-signing' }];
const artifact = artifacts.buildArtifact({ tenant: A, sourceCommit: 'a'.repeat(40), exportedAt: 100,
  keyNames: keys, catalogues: [{ kind: 'secrets', namespace: 'synthetic_secrets', ledger: [], tables: [{ table: 'secret_records', columns: [{ name: 'tenant_id', type: 'uuid' }], rows: [] }] }] });
const options = { tenant: A, requestId, artifact, ledgerNamespace: 'synthetic_control', now: () => 200 };
function fixture (change = {}) {
  const calls = [];
  const query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('schema_migrations')) return { rows: validateCatalogue(candidate).map(({ name, checksum }) => ({ name, checksum })) };
    if (sql.includes('reviewed-relation-inventory')) return { rows: ['schema_migrations', ...retention.LEDGER_TABLES].map(name => ({ name, kind: 'r', partition: false, inherited: false })) };
    if (sql.includes('recommission-retention')) {
      assert.deepEqual(values, [A, requestId]);
      for (const term of ["c.phase='executed'", 'a.deletion_request_id=r.request_id AND a.suspended', 'r.artifact_digest=k.artifact_digest', 'FOR UPDATE OF k,r,c,a']) assert(sql.includes(term));
      return { rows: change.absent ? [] : [{ request_id: requestId, artifact_digest: artifact.digest, key_names: keys,
        phase: 'retained', retained_at: '100', retain_until: String(100 + retention.RETENTION_MS), deletion_phase: 'executed', ...change }] };
    }
    throw new Error('Unexpected SQL');
  };
  return { connection: { query }, calls };
}
function create (implementation = retention, inventory = keys) {
  return implementation.createKeyRetention({ keyInventory: async () => inventory, namespaceOf: (map, kind) => map[kind], timestamp: now => now(), catalogue: [] });
}
describe('exact deletion artifact retained-key admission', function () {
  it('requires the current suspended deletion request and exact retained artifact/key references', async function () {
    const f = fixture(); const admitted = await create().admitRecommission(f.connection, options);
    assert.deepEqual(admitted, { ledger: 'synthetic_control', at: 200, requestIds: [requestId], artifactDigest: artifact.digest });
    assert(Object.isFrozen(admitted)); assert(Object.isFrozen(admitted.requestIds)); assert.equal(f.calls.length, 3);
    assert(f.calls.every(({ sql }) => !/^(INSERT|UPDATE|DELETE)/.test(sql)));
  });
  it('refuses absent, incomplete, expired, destroyed, changed and already staged authority', async function () {
    for (const [change, code] of [
      [{ absent: true }, 'LIFECYCLE_RECOMMISSION_DELETION_REQUIRED'], [{ deletion_phase: 'requested' }, 'LIFECYCLE_RECOMMISSION_DELETION_REQUIRED'],
      [{ artifact_digest: 'b'.repeat(64) }, 'LIFECYCLE_RECOMMISSION_EXACT_ARTIFACT_REQUIRED'],
      [{ phase: 'destroying' }, 'LIFECYCLE_KEYS_DESTROYED'], [{ phase: 'destroyed' }, 'LIFECYCLE_KEYS_DESTROYED'],
      [{ phase: 'restored' }, 'LIFECYCLE_RECOMMISSION_ALREADY_STAGED'], [{ retained_at: '300', retain_until: String(300 + retention.RETENTION_MS) }, 'LIFECYCLE_CLOCK_REWOUND'],
      [{ retained_at: '0', retain_until: '200' }, 'LIFECYCLE_RETENTION_INVALID'], [{ key_names: keys.slice(0, 1) }, 'LIFECYCLE_KEY_REFERENCE_MISSING']
    ]) await assert.rejects(create().admitRecommission(fixture(change).connection, options), { code });
    await assert.rejects(create().admitRecommission(fixture().connection, { ...options, now: () => 100 + retention.RETENTION_MS }), { code: 'LIFECYCLE_RETENTION_EXPIRED' });
    await assert.rejects(create(retention, keys.slice(0, 1)).admitRecommission(fixture().connection, options), { code: 'LIFECYCLE_KEY_REFERENCE_MISSING' });
  });
  it('makes acceptance of a different self-consistent artifact red, then restores the exact-digest refusal', async function () {
    const filename = require.resolve('../lib/tenant-lifecycle/key-retention'), source = fs.readFileSync(filename, 'utf8');
    const guard = "if (row.artifact_digest !== artifact.digest) throw refuse('LIFECYCLE_RECOMMISSION_EXACT_ARTIFACT_REQUIRED');";
    assert.equal(source.split(guard).length, 2);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename)); altered._compile(source.replace(guard, ''), filename);
    let red = false;
    try { await assert.rejects(create(altered.exports).admitRecommission(fixture({ artifact_digest: 'b'.repeat(64) }).connection, options)); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(create().admitRecommission(fixture({ artifact_digest: 'b'.repeat(64) }).connection, options), { code: 'LIFECYCLE_RECOMMISSION_EXACT_ARTIFACT_REQUIRED' });
  });
});
