'use strict';
// Real ceremony component with recording transactions; native drain is separate.
const assert = require('node:assert/strict');
const create = require('../lib/tenant-lifecycle/ceremony');
const artifacts = require('../lib/tenant-lifecycle/artifact');
const retention = require('../lib/tenant-lifecycle/key-retention');
const { validateCatalogue } = require('../lib/migrations/catalogue');
const scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const artifact = artifacts.buildArtifact({ tenant: A, sourceCommit: 'a'.repeat(40), exportedAt: 100, catalogues: [{ kind: 'activity', namespace: 'synthetic_activity', ledger: [], tables: [{ table: 'activity', columns: [{ name: 'tenant_id', type: 'uuid' }], rows: [] }] }] });
function fixture (maintenanceExecution, implementation = create) {
  const trace = []; let phase = 'confirmed', claimId;
  const connection = { transaction: fn => fn(), query: async (sql, values) => {
    if (sql.includes('schema_migrations')) return { rows: validateCatalogue(require('../lib/tenant-lifecycle/postgres-candidate.json')).map(({ name, checksum }) => ({ name, checksum })) };
    if (sql.includes('reviewed-relation-inventory')) return { rows: ['schema_migrations', ...retention.LEDGER_TABLES].map(name => ({ name, kind: 'r', partition: false, inherited: false })) };
    if (sql.startsWith('SELECT request_id, tenant_id')) return { rows: [{ request_id: requestId, tenant_id: A, artifact_digest: artifact.digest, phase: 'requested', requested_at: '100' }] };
    if (sql.startsWith('SELECT phase, claim_id')) return { rows: [{ phase, claim_id: claimId, confirmed_at: '100' }] };
    if (sql.includes('SELECT version::text,paused')) return { rows: [{ version: '1', paused: true, suspended: false, deletion_request_id: requestId, paused_before_deletion: false }] };
    if (sql.startsWith('UPDATE "synthetic_control"."tenant_activity"')) return { rows: [{ version: '2', paused: true, suspended: true }] };
    if (sql.startsWith('INSERT INTO "synthetic_control"."tenant_activity_audit"')) return { rowCount: 1 };
    if (sql.startsWith('UPDATE "synthetic_control"."tenant_lifecycle_ceremony"')) { phase = values[3]; claimId = values[4]; trace.push('claimed'); return { rowCount: 1 }; }
    throw new Error('Unexpected SQL');
  } };
  const ceremony = implementation({ maintenanceExecution, beforeExecution: async () => { trace.push('actual-maintenance-required'); throw Object.assign(new Error('Real claim required'), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' }); },
    authorize: async () => ({ allowed: true, current: true, tenant: A, principal: 'operator', consumer: 'recovery', plane: 'operator' }),
    verifyDurableArtifact: async () => ({ verified: true, tenant: A, digest: artifact.digest }),
    executionWindow: async () => { trace.push('generic-window'); throw new Error('GENERIC_PROOF_MUST_NOT_RUN'); },
    namespaceOf: (map, kind) => map[kind], timestamp: now => now(), verifyRows: async (_connection, options) => { trace.push(options.deletionStage); },
    eraseRows: async () => { trace.push('erased'); throw new Error('ERASE_BEFORE_ACTUAL_CLAIM'); } });
  return { ceremony, connection, trace };
}
describe('selected deletion claim and drain phase separation', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  const options = { tenant: A, requestId, artifact, ledgerNamespace: 'synthetic_control', now: () => 200 };
  it('claims cancellation boundary without a fabricated quiescence proof, then refuses destructive execution without actual maintenance', async function () {
    const f = fixture(true), claim = await f.ceremony.claimDeletion(f.connection, options);
    assert.deepEqual(f.trace, ['claim', 'claimed']);
    await assert.rejects(f.ceremony.executeDeletion(f.connection, { ...options, claimId: claim.claimId }), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert(!f.trace.includes('erased')); assert(!f.trace.includes('generic-window'));
  });
  it('turns the selected claim success red when generic quiescence is wrongly restored, then uses the actual maintenance path', async function () {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const filename = require.resolve('../lib/tenant-lifecycle/ceremony'), source = fs.readFileSync(filename, 'utf8');
    const guard = 'if (!maintenanceExecution) await window(connection, options);'; assert.equal(source.split(guard).length, 3);
    const broken = new Module(filename, module); broken.filename = filename; broken.paths = Module._nodeModulePaths(path.dirname(filename)); broken._compile(source.replaceAll(guard, 'await window(connection, options);'), filename);
    const altered = fixture(true, broken.exports); let red = false;
    try { await assert.doesNotReject(altered.ceremony.claimDeletion(altered.connection, options)); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /GENERIC_PROOF_MUST_NOT_RUN/); red = true; }
    assert(red); const restored = fixture(true); await assert.doesNotReject(restored.ceremony.claimDeletion(restored.connection, options));
  });
  it('keeps the ordinary execution-window proof required and detects reuse of that proof in the selected claim', async function () {
    const ordinary = fixture(false);
    await assert.rejects(ordinary.ceremony.claimDeletion(ordinary.connection, options), /GENERIC_PROOF_MUST_NOT_RUN/);
    assert.deepEqual(ordinary.trace, ['generic-window']);
    const selected = fixture(true); await selected.ceremony.claimDeletion(selected.connection, options);
    assert(!selected.trace.includes('generic-window'));
  });
});
