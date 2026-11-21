'use strict';
// Recording transaction port only; database RLS and activation COMMIT are native criteria.
const assert = require('node:assert/strict');
const control = require('../lib/tenant-lifecycle/recommission-control');
const A = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const options = { namespace: 'synthetic_control', tenant: A, claimId: '33333333-3333-4333-8333-333333333333', generation: '10', artifactDigest: 'a'.repeat(64), required: true };
function recording (mutate = () => {}) {
  const calls = [];
  const query = async (sql, values) => {
    calls.push({ sql, values }); let result;
    if (sql.includes('recommission-activate')) {
      assert.deepEqual(values, [A, options.claimId, options.generation, options.artifactDigest]);
      result = { rowCount: 1, rows: [{ request_id: requestId }] };
    } else if (sql.includes('recommission-current-activity')) result = { rows: [{ version: '8', paused: true, suspended: true, deletion_request_id: requestId, paused_before_deletion: false }] };
    else if (sql.includes('recommission-restore-activity')) { assert.deepEqual(values, [A, '8', false, requestId]); result = { rowCount: 1, rows: [{ version: '9', paused: false }] }; }
    else if (sql.includes('recommission-activity-audit')) { assert.deepEqual(values, [A, '9', false]); result = { rowCount: 1, rows: [] }; }
    else throw new Error('Unexpected SQL');
    mutate(sql, result); return result;
  };
  return { query, calls };
}
describe('exact-artifact recommission final activation', function () {
  it('binds the activation link to the actual claim/generation/digest and restores current saved activity with an audit', async function () {
    const f = recording(); assert.equal(await control.activate(f.query, options), true);
    assert.equal(f.calls.length, 4);
    assert(f.calls[0].sql.includes('AND NOT activated'));
    assert(f.calls.at(-1).sql.includes("'unsuspend','operator',CURRENT_USER::text,'recommission'"));
  });
  it('allows an ordinary v2 clinical restore without a recommission link but refuses a missing required link before activity writes', async function () {
    const empty = () => recording((sql, result) => { if (sql.includes('recommission-activate')) Object.assign(result, { rowCount: 0, rows: [] }); });
    const plain = empty(); assert.equal(await control.activate(plain.query, { ...options, required: false }), false); assert.equal(plain.calls.length, 1);
    const required = empty(); await assert.rejects(control.activate(required.query, options), { code: 'LIFECYCLE_RECOMMISSION_ACTIVATION_CHANGED' }); assert.equal(required.calls.length, 1);
  });
  it('refuses stale activity identity and failed activity/audit writes', async function () {
    for (const change of [
      (sql, result) => { if (sql.includes('recommission-current-activity')) result.rows[0].deletion_request_id = A; },
      (sql, result) => { if (sql.includes('recommission-current-activity')) result.rows[0].suspended = false; },
      (sql, result) => { if (sql.includes('recommission-restore-activity')) result.rowCount = 0; },
      (sql, result) => { if (sql.includes('recommission-activity-audit')) result.rowCount = 0; }
    ]) await assert.rejects(control.activate(recording(change).query, options), { code: 'LIFECYCLE_RECOMMISSION_ACTIVITY_CHANGED' });
  });
  it('makes a missing-required-link omission red and restores the same refusal', async function () {
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const filename = require.resolve('../lib/tenant-lifecycle/recommission-control'), source = fs.readFileSync(filename, 'utf8');
    const guard = 'if (result.rowCount === 0 && !required) return false;'; assert.equal(source.split(guard).length, 2);
    const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
    compiled._compile(source.replace(guard, 'if (result.rowCount === 0) return false;'), filename);
    const query = async () => ({ rowCount: 0, rows: [] }); let red = false;
    try { await assert.rejects(compiled.exports.activate(query, options)); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION'); assert.match(error.message, /Missing expected rejection/); red = true; }
    assert(red); await assert.rejects(control.activate(query, options), { code: 'LIFECYCLE_RECOMMISSION_ACTIVATION_CHANGED' });
  });
});
