'use strict';

// covers: lib/server/serve/pool-config.js, lib/server/serve/tenant-startup.js, lib/server/serve/operation-cohort-config.js

// Pool sizes, connect timeouts and startup concurrency from the role
// environment (decision cost-proportional-to-activity), and the bounded startup
// warm. Synthetic values only.
const assert = require('node:assert/strict');
const config = require('../lib/server/serve/pool-config');
const startup = require('../lib/server/serve/tenant-startup');
const { PreviewConfigError } = require('../lib/server/serve/preview-config');

describe('multitenant pool configuration', function () {
  it('keeps the previous built-in values when nothing is set', function () {
    assert.deepEqual({ ...config.pool('api', {}) }, { max: 4, connectionTimeoutMillis: 5000 });
    assert.deepEqual({ ...config.pool('evaluator', {}) }, { max: 4, connectionTimeoutMillis: 5000 });
    assert.deepEqual({ ...config.pool('operation', {}) }, { max: 8, connectionTimeoutMillis: 5000 });
    assert.deepEqual({ ...config.pool('realtime', {}, { connectionTimeoutMillis: 7000 }) }, { max: 4, connectionTimeoutMillis: 7000 });
    assert.equal(config.startupConcurrency({}), 4);
  });
  it('reads each role from its own names', function () {
    const env = { NS_POOL_API_MAX: '16', NS_POOL_API_CONNECT_TIMEOUT_MS: '15000', NS_POOL_REALTIME_MAX: '6', NS_POOL_OPERATION_MAX: '24', NS_TENANT_STARTUP_CONCURRENCY: '12' };
    assert.deepEqual({ ...config.pool('api', env) }, { max: 16, connectionTimeoutMillis: 15000 });
    assert.deepEqual({ ...config.pool('realtime', env, { connectionTimeoutMillis: 5000 }) }, { max: 6, connectionTimeoutMillis: 5000 });
    assert.deepEqual({ ...config.pool('evaluator', env) }, { max: 4, connectionTimeoutMillis: 5000 });
    assert.equal(config.pool('operation', env).max, 24);
    assert.equal(config.startupConcurrency(env), 12);
  });
  for (const value of ['0', '-1', '1.5', 'x', ' 4', '04', '1001', '1e3'])
    it('refuses NS_POOL_API_MAX=' + JSON.stringify(value), function () {
      assert.throws(() => config.pool('api', { NS_POOL_API_MAX: value }), error => error instanceof PreviewConfigError && /NS_POOL_API_MAX/.test(error.message));
    });
  it('refuses an out-of-range timeout and startup concurrency', function () {
    assert.throws(() => config.pool('operation', { NS_POOL_OPERATION_CONNECT_TIMEOUT_MS: '600001' }), PreviewConfigError);
    assert.throws(() => config.pool('evaluator', { NS_POOL_EVALUATOR_CONNECT_TIMEOUT_MS: '0' }), PreviewConfigError);
    assert.throws(() => config.startupConcurrency({ NS_TENANT_STARTUP_CONCURRENCY: '0' }), PreviewConfigError);
  });
  it('sizes the operation lifetime pool from the environment', function () {
    const cohort = require('../lib/server/serve/operation-cohort-config');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-pool-config-')), file = path.join(dir, 'operation.json');
    this.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, namespace: 'synthetic_control', connectionEnv: 'NS_SYNTHETIC_PG',
      locks: [{ tenant: '11111111-1111-4111-8111-111111111111', key: '1' }] }), { mode: 0o600 });
    const env = { MULTITENANT_OPERATION_CONFIG: file, NS_SYNTHETIC_PG: 'postgres://synthetic:synthetic@127.0.0.1/synthetic' };
    assert.equal(cohort.load(env).poolOptions.max, 8);
    assert.equal(cohort.load({ ...env, NS_POOL_OPERATION_MAX: '20', NS_POOL_OPERATION_CONNECT_TIMEOUT_MS: '9000' }).poolOptions.max, 20);
    assert.equal(cohort.load({ ...env, NS_POOL_OPERATION_CONNECT_TIMEOUT_MS: '9000' }).poolOptions.connectionTimeoutMillis, 9000);
    assert.throws(() => cohort.load({ ...env, NS_POOL_OPERATION_MAX: '0' }), /NS_POOL_OPERATION_MAX/);
    this.cleanup();
  });
});

describe('bounded tenant startup warm', function () {
  const tenants = Array.from({ length: 50 }, (_, i) => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'));
  async function peak (concurrency) {
    let inFlight = 0, most = 0;
    const s = startup.create(tenants, undefined, async () => {
      inFlight++; most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 2)); inFlight--;
    }, { concurrency });
    await s.warm();
    return most;
  }
  it('initializes every tenant with at most the configured number at once', async function () {
    assert.equal(await peak(4), 4);
    assert.equal(await peak(1), 1);
  });
  it('control: concurrency at the tenant count reproduces the unbounded warm', async function () {
    assert.equal(await peak(tenants.length), tenants.length);
  });
  it('still reports the first failure after every tenant settles', async function () {
    const seen = [];
    const s = startup.create(tenants.slice(0, 6), undefined, async tenant => { seen.push(tenant); if (tenant.endsWith('2')) throw new Error('synthetic refusal'); }, { concurrency: 2 });
    await assert.rejects(s.warm(), /synthetic refusal/);
    assert.equal(seen.length, 6);
  });
  it('preserves item order and allSettled shape', async function () {
    const results = await startup.settleLimited([3, 1, 2], 2, async n => { await new Promise(r => setTimeout(r, n)); if (n === 1) throw new Error('one'); return n; });
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.deepEqual([results[0].value, results[2].value], [3, 2]);
    await assert.rejects(startup.settleLimited([1], 0, async () => {}), TypeError);
  });
});
