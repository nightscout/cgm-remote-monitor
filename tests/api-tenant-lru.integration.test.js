'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { optInSuite } = require('./support/opt-in');
const createLab = require('./fixtures/tenant-commit-clock-port');
const tenant = number => '11111111-1111-4111-8111-' + String(number).padStart(12, '0');
const A = tenant(1), B = tenant(2);
const strip = value => {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['_id', 'srvModified', 'srvCreated', 'lastModified', 'lastUpdated', 'lastUpdatedTime', 'now', 'serverTime', 'serverTimeEpoch'].includes(key))
    .map(([key, item]) => [key, strip(item)]));
};
function worker (lab, capacity, control) {
  const child = fork(path.join(__dirname, 'fixtures/api-tenant-lru-worker.js'), [], {
    env: { ...process.env, NS_TEST_POSTGRES_ADMIN_URI: undefined, NS_LRU_APP_URI: lab.appURI, NODE_ENV: 'test' }, execArgv: [], silent: true
  });
  let sequence = 0, port;
  const waiting = new Map();
  child.stdout.resume(); child.stderr.on('data', data => { process.stderr.write(data); });
  child.on('message', message => { const item = waiting.get(message.id); if (!item) return; waiting.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else item.resolve(message.value); });
  child.on('exit', () => { for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(new Error('LRU_WORKER_EXITED')); } waiting.clear(); });
  function command (action, input = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('LRU_WORKER_DEADLINE')); }, 15000);
      waiting.set(id, { resolve, reject, timer }); child.send({ id, action, ...input });
    });
  }
  return { command, async start () { const result = await command('start', { input: { domains: lab.domains, namespaces: lab.namespaces, capacity, control } }); port = result.port; return result; },
    async request (selected, method, url, body) {
      const response = await fetch('http://127.0.0.1:' + port + url, { method, headers: { 'x-synthetic-tenant': selected,
        accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const text = await response.text(); let result; try { result = JSON.parse(text); } catch { result = text; }
      return { status: response.status, body: result };
    }, async close () { if (!child.connected) return; try { await command('close'); } finally { if (child.connected) child.disconnect(); } },
    kill () { child.kill('SIGTERM'); }
  };
}
optInSuite(process.env.NS_API_TENANT_LRU_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_API_TENANT_LRU_TEST=1 with disposable PostgreSQL')('native two-process API router tenant LRU', function () {
  this.timeout(90000);
  const lab = createLab({ replicas: 1 });
  let workers = [];
  const now = Date.now();
  const doc = (identifier, sgv) => ({ identifier, type: 'sgv', sgv, date: now, created_at: new Date(now).toISOString(), device: 'synthetic-lru', app: 'synthetic-lru', utcOffset: 0 });
  before(async () => { await lab.open(); console.log('LRU_POSTGRES_VERSION ' + lab.version); });
  after(async () => { await Promise.allSettled(workers.map(w => w.close())); workers.forEach(w => w.kill()); await lab.close(); });
  async function scenario (capacity, control) {
    await lab.reset();
    // The lab's two native tenants are different from this API-routing set.
    await lab.admin.query('INSERT INTO "' + lab.namespaces.clock + '".tenant_write_clock(tenant_id,last_stamp) VALUES($1,$3),($2,$3)', [A, B, lab.initial]);
    const pair = [worker(lab, capacity, control), worker(lab, capacity, control)]; workers.push(...pair);
    try {
      const starts = await Promise.all(pair.map(w => w.start()));
      assert(starts.every(s => s.stats.entries === 0), 'API_START_MUST_NOT_BUILD_ROSTER');
      const responses = [];
      async function call (w, t, method, url, body, expected = 200) {
        const response = await pair[w].request(t, method, url, body);
        assert.equal(response.status, expected, JSON.stringify(response)); responses.push(strip(response)); return response.body;
      }
      await call(0, A, 'POST', '/api/v3/entries', doc('lru-a', 123), 201);
      await call(0, B, 'POST', '/api/v1/entries', [{ ...doc('lru-b', 234), _id: '111111111111111111111102' }]);
      await call(0, A, 'GET', '/api/v1/entries?count=10');
      const readB = await call(1, B, 'GET', '/api/v3/entries');
      assert(readB.result.every(d => d.sgv === 234), 'TENANT_B_MUST_NOT_SEE_A');
      const before = (await lab.rows(A))[0].srvModified;
      assert(before > lab.initial, 'HISTORY_MUST_START_ABOVE_DURABLE_FLOOR');
      await call(1, A, 'PUT', '/api/v3/entries/lru-a', doc('lru-a', 124));
      const after = (await lab.rows(A))[0].srvModified;
      assert(after > before, 'HISTORY_MUST_ADVANCE_ACROSS_API_PROCESSES');
      await call(0, B, 'GET', '/api/v3/entries');
      await call(0, A, 'GET', '/api/v2/entries?count=10');
      await pair[0].command('settings', { tenant: A, units: 'mmol' });
      const status = await call(0, A, 'GET', '/api/v1/status.json');
      assert.equal(status.settings.units, 'mmol', 'SETTINGS_INVALIDATION_MUST_REBUILD_ENVIRONMENT');
      const reply = await pair[0].command('socket', { tenant: A, document: { ...doc('lru-socket', 125), _id: '111111111111111111111103' } });
      responses.push(strip(reply));
      await call(1, A, 'GET', '/api/v3/entries/history/' + (lab.initial - 1));
      for (let n = 3; n <= 10; n++) await pair[0].request(tenant(n), 'GET', '/api/v3/entries');
      const stats = await pair[0].command('stats');
      assert(stats.entries <= capacity, 'API_SERVICE_CACHE_MUST_BE_BOUNDED');
      assert(stats.evictions > 0, 'EVICTION_SCENARIO_MUST_EXERCISE_EVICTION');
      const rows = (await lab.admin.query('SELECT tenant_id,doc FROM "' + lab.namespaces.entries + '".entries WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id,doc->>\'identifier\'', [[A, B]])).rows;
      assert.equal(rows.filter(r => r.tenant_id === A).length, 2);
      assert.equal(rows.filter(r => r.tenant_id === B).length, 1);
      return { responses, rows: strip(rows), before, after };
    } finally { await Promise.allSettled(pair.map(w => w.close())); pair.forEach(w => w.kill()); workers = workers.filter(w => !pair.includes(w)); }
  }
  it('preserves v1/v2/v3 reads/writes, settings and socket writes at capacity one versus a resident working set', async () => {
    const evicting = await scenario(1), resident = await scenario(8);
    assert.deepEqual(evicting.responses, resident.responses, 'EVICTION_MUST_PRESERVE_RESPONSES');
    assert.deepEqual(evicting.rows, resident.rows, 'EVICTION_MUST_PRESERVE_STORED_DOCUMENTS');
  });
  it('control: an eviction-local memory clock loses the durable cursor; the database allocator restores it', async () => {
    await assert.rejects(scenario(1, 'memory-clock'), /HISTORY_MUST_START_ABOVE_DURABLE_FLOOR/);
    await scenario(1);
  });
  it('control: skipping eviction retains stale settings; restored invalidation rebuilds the environment', async () => {
    await assert.rejects(scenario(1, 'skip-invalidation'), /SETTINGS_INVALIDATION_MUST_REBUILD_ENVIRONMENT/);
    await scenario(1);
  });
});
