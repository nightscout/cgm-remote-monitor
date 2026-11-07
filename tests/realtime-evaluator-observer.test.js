'use strict';
// Instrument correctness only; fake frozen capability is not a native result.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const observer = require('./fixtures/realtime-preview/observe-evaluator');
describe('disclosed evaluator getter observer fixture', function () {
  let directory, config;
  beforeEach(function () { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-observer-')); fs.chmodSync(directory, 0o700);
    config = { file: path.join(directory, 'actual.json'), intervalMs: 10000, maxBytes: 10000, phaseId: 'source-instrument-test', sourceHead: '1'.repeat(40) }; });
  afterEach(function () { fs.rmSync(directory, { recursive: true }); });
  it('calls original boot with identical options and observes only actual getters without mutating a frozen role', async function () {
    const selected = { tenants: new Map([['synthetic-tenant', {}]]) }; let closed = 0, received;
    const actual = Object.freeze({ health: () => ({ closed: !!closed, tenants: [{ tenant: 'synthetic-tenant', ready: false, code: 'EVALUATOR_ACQUISITION_REFUSED' }] }),
      last: () => null, acquire: () => 'original-acquire', close: async () => { closed++; } });
    const wrapped = await observer.wrapBoot(async value => { received = value; return actual; }, config)(selected);
    assert.equal(received, selected); assert.equal(wrapped.acquire, actual.acquire); assert(Object.isFrozen(actual));
    const snapshot = JSON.parse(fs.readFileSync(config.file));
    assert.equal(snapshot.health.tenants[0].code, 'EVALUATOR_ACQUISITION_REFUSED'); assert.equal(snapshot.last[0].value, null);
    assert.equal(snapshot.pid, process.pid); assert.match(snapshot.preload.sha256, /^[a-f0-9]{64}$/);
    await wrapped.close(); await wrapped.close(); assert.equal(closed, 1);
    assert.equal(JSON.parse(fs.readFileSync(config.file)).health.closed, true);
  });
  it('records last tags without capturing clinical result or invoking evaluation', async function () {
    const selected = { tenants: new Map([['synthetic-tenant', {}]]) }; let acquires = 0;
    const actual = Object.freeze({ health: () => ({ closed: false, tenants: [] }),
      last: () => ({ identity: 'actual-identity', runtimeId: 'actual-runtime', outputRevision: 3, inputCheckpoint: 7, eligible: true, result: { forbiddenCapture: 'synthetic-clinical-content' } }),
      acquire: () => { acquires++; }, close: async () => {} });
    const wrapped = await observer.wrapBoot(async () => actual, config)(selected);
    const text = fs.readFileSync(config.file, 'utf8'), snapshot = JSON.parse(text);
    assert.equal(snapshot.last[0].value.outputRevision, 3); assert(!text.includes('forbiddenCapture')); assert.equal(acquires, 0); await wrapped.close();
  });
  it('refuses foreign lineage and symlink output without changing their bytes', function () {
    const content = JSON.stringify({ sourceHead: '2'.repeat(40), phaseId: 'other' }); fs.writeFileSync(config.file, content, { mode: 0o600 });
    const write = observer.writer(config);
    assert.throws(() => write({ sourceHead: config.sourceHead, phaseId: config.phaseId }), /FOREIGN_LINEAGE/);
    assert.equal(fs.readFileSync(config.file, 'utf8'), content);
    fs.unlinkSync(config.file); const target = path.join(directory, 'sentinel'); fs.writeFileSync(target, 'synthetic'); fs.symlinkSync(target, config.file);
    assert.throws(() => write({}), error => error.code === 'ELOOP'); assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic');
  });
});
