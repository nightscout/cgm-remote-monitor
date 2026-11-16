'use strict';
// Controller composition/recording SQL. Actual held claims and PostgreSQL locks
// remain native criteria; a forged real claim is independently refused here.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const source = require('../lib/tenant-lifecycle/deletion-maintenance');
const profiles = require('../lib/pgstream/pool-intake-profile');
const profile = profiles.create({ namespace: 'synthetic_checkpoint', membershipNamespace: 'synthetic_membership', lifecycleNamespace: 'synthetic_control', role: 'synthetic_intake', operatorRole: 'synthetic_operator', consumer: 'evaluator-synthetic', codec: profiles.CODEC, generationDomain: profiles.GENERATION_DOMAIN, sliceRule: require('../lib/pool-membership/slice').RULE });
const A = '11111111-1111-4111-8111-111111111111';
const options = { tenant: A, ledgerNamespace: 'synthetic_control', artifact: { digest: 'a'.repeat(64) }, maintenanceClaim: 'recording-claim' };
function recording () {
  const trace = [], filename = require.resolve('../lib/tenant-lifecycle/deletion-maintenance'), compiled = new Module(filename, module);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename)); const original = compiled.require.bind(compiled);
  compiled.require = name => name === './maintenance-window' ? { assertHeld: async (claim, expected) => {
    assert.equal(claim, options.maintenanceClaim); assert.equal(expected.tenant, A); trace.push('held');
  } } : name === '../tenant-notifications/pool-notification-maintenance' ? { prepareDelete: async (_query, input) => { trace.push(['batch', input]); } } : original(name);
  compiled._compile(fs.readFileSync(filename, 'utf8'), filename);
  const connection = { query: async (sql, values) => {
    if (sql.includes('pg_advisory_xact_lock(')) { trace.push('cohort'); return { rows: [{ backend_pid: 123, transaction_id: '77' }] }; }
    if (sql.includes('deletion-maintenance-generation')) { assert.deepEqual(values, [A]); trace.push('generation'); return { rows: [{ generation: '8' }] }; }
    throw new Error('Unexpected SQL');
  } };
  return { trace, connection, module: compiled.exports };
}
describe('selected deletion real maintenance composition', function () {
  it('refuses a forged real maintenance claim before any cohort or data query', async function () {
    let queried = false;
    await assert.rejects(source.create({ intakeProfile: profile }).beforeExecution({ query: async () => { queried = true; } }, options), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
    assert.equal(queried, false);
  });
  it('checks held lifetime before cohort and prepares all declared notification routes in one batch', async function () {
    const f = recording(), notificationBindings = ['synthetic_outbox_a', 'synthetic_outbox_b'].map(namespace => ({ namespace,
      checkpointNamespace: profile.binding.namespace, lifecycleNamespace: profile.binding.lifecycleNamespace, membershipNamespace: profile.binding.membershipNamespace,
      consumer: 'same_route', evaluatorConsumer: profile.binding.consumer + '-completed' }));
    await f.module.create({ intakeProfile: profile, notificationBindings }).beforeExecution(f.connection, options);
    assert.deepEqual(f.trace.slice(0, 3), ['held', 'cohort', 'generation']); assert.equal(f.trace.at(-1), 'held');
    const batches = f.trace.filter(value => Array.isArray(value)); assert.equal(batches.length, 1);
    assert.deepEqual(batches[0][1].bindings, notificationBindings); assert.equal(batches[0][1].generation, '8');
  });
  it('makes omission of real claim checks red, then restores refusal before SQL', async function () {
    const filename = require.resolve('../lib/tenant-lifecycle/deletion-maintenance'), text = fs.readFileSync(filename, 'utf8');
    const guard = 'await maintenance.assertHeld(options.maintenanceClaim, claim);'; assert.equal(text.split(guard).length, 3);
    const altered = new Module(filename, module); altered.filename = filename; altered.paths = Module._nodeModulePaths(path.dirname(filename));
    altered._compile(text.replaceAll(guard, ''), filename);
    const connection = { query: async sql => ({ rows: sql.includes('pg_advisory_xact_lock(') ? [{ backend_pid: 123, transaction_id: '77' }] : [{ generation: '8' }] }) };
    let red = false;
    try { await assert.rejects(altered.exports.create({ intakeProfile: profile }).beforeExecution(connection, options)); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(source.create({ intakeProfile: profile }).beforeExecution(connection, options), { code: 'LIFECYCLE_RESTORE_CLAIM_INVALID' });
  });
  it('commits the separate deletion claim before entering the controller and passes only its actual writer claim', async function () {
    const calls = [], connection = { query () {} }, writer = { query () {} };
    const ceremony = { claimDeletion: async conn => { assert.equal(conn, connection); calls.push('claim'); return { claimId: 'prior-deletion-claim' }; },
      executeDeletion: async (conn, input) => { assert.equal(conn, writer); assert.equal(input.claimId, 'prior-deletion-claim'); assert.equal(input.maintenanceClaim, 'actual-controller-claim'); calls.push('erase'); return 'erased'; } };
    const controller = { withRestore: async (tenant, current, body) => { assert.equal(tenant, A); assert.equal(current.artifactDigest, options.artifact.digest); calls.push('controller'); return body({ connection: writer, maintenanceClaim: 'actual-controller-claim' }); } };
    assert.equal(await source.create({ intakeProfile: profile }).run(connection, { ...options, controller }, ceremony), 'erased');
    assert.deepEqual(calls, ['claim', 'controller', 'erase']);
  });
});
