'use strict';

// Opt-in Prometheus metrics (lib/metrics, NS_METRICS). The actual serve/index
// start() with stand-in role boots, the actual serve.internal listener and
// transport, the actual evaluator runtime with in-memory durable hooks, and a
// real Express app for the request middleware. No PostgreSQL: the statement
// wrapper is driven through a real pg.Pool's 'connect' event with a stand-in
// client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const express = require('express');
const request = require('supertest');
const metrics = require('../lib/metrics');
const startRuntime = require('../lib/server/serve/evaluator-runtime');

const A = '11111111-1111-4111-8111-111111111111';
const HEX = 'a'.repeat(32);
const TENANT_VALUES = [A, HEX];

function load (relative, overrides, mutate) {
  const file = path.resolve(__dirname, relative), output = { exports: {} };
  const source = fs.readFileSync(file, 'utf8'), changed = mutate ? mutate(source) : source;
  if (mutate && changed === source) throw new Error('Mutation marker must match actual source');
  const original = Module.createRequire(file);
  vm.runInThisContext('(function(require,module,exports){' + changed + '\n})', { filename: file })(
    name => Object.hasOwn(overrides, name) ? overrides[name] : original(name), output, output.exports);
  return output.exports;
}
function serve (roles) {
  return load('../lib/server/serve/index.js', {
    './listeners': { resolve: () => [], close: async () => {} },
    ...Object.fromEntries([['api', 'preview-api'], ['evaluator', 'evaluator-preview']]
      .map(([role, file]) => ['./' + file, { boot: config => roles[role](config) }]))
  });
}
async function freePort () {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
function get (port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}
const standIn = () => ({ health: () => ({ storageReady: true, ready: true }), ready: () => true, close: async () => {} });
async function startProcess (env) {
  const port = await freePort();
  const source = { NS_SERVE_INTERNAL_HOST: '127.0.0.1', NS_SERVE_INTERNAL_PORT: String(port), ...env };
  const started = await serve({ api: standIn, evaluator: standIn }).start(['api', 'evaluator'], {}, null, source,
    { preview: { writeClock: true }, evaluatorPreview: { namespaces: { checkpoint: 'e' } }, datastoreProbe: null });
  return { port, started };
}

// Every label value in a Prometheus text exposition.
function labelValues (text) {
  const values = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const open = line.indexOf('{'); if (open < 0) continue;
    const labels = line.slice(open + 1, line.lastIndexOf('}'));
    for (const match of labels.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) values.push({ name: match[1], value: match[2] });
  }
  return values;
}
// The value of one sample whose labels are exactly `labels` (any order).
function sample (text, name, labels) {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    const found = Object.fromEntries(labelValues(line).map(({ name, value }) => [name, value]));
    if (Object.keys(found).length === Object.keys(labels).length && Object.entries(labels).every(([k, v]) => found[k] === v)) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return undefined;
}
// The label-cardinality guard: no label value may look like, or be, a tenant id.
function tenantLabels (text) {
  return labelValues(text).filter(({ value }) => metrics.tenantLike(value) || TENANT_VALUES.some(id => value.includes(id)));
}

// Drive every role hook on an instance, the way the roles do, with tenant ids
// in every place a careless label would pick them up.
async function exercise (instance) {
  // api: a real Express app; the tenant id appears in paths and in a
  // router mounted at a parameter.
  const app = express();
  app.use(instance.middleware);
  app.get('/api/v3/:collection/:identifier', (req, res) => res.json({}));
  const scoped = express.Router({ mergeParams: true });
  scoped.get('/settings', (req, res) => res.status(403).json({}));
  app.use('/api/v1/tenant/:tenant', scoped);
  app.use('/api/v1/raw', express.Router().get('/' + A, (req, res) => res.json({})));
  await request(app).get('/api/v3/entries/' + A).expect(200);
  await request(app).get('/api/v1/tenant/' + A + '/settings').expect(403);
  await request(app).get('/api/v1/raw/' + A).expect(200);
  await request(app).get('/nowhere/' + HEX).expect(404);
  // SQL: a real pg.Pool's connect event, stand-in clients; one pool named with a tenant id.
  const { Pool } = require('pg');
  for (const name of ['nightscout-evaluator-preview', 'nightscout-' + A, 'tenant-' + HEX]) {
    const pool = instance.observePool(new Pool({ application_name: name }), name);
    const client = { query: async () => ({ rows: [] }) };
    pool.emit('connect', client);
    await client.query('SELECT 1');
    await client.query('SELECT 2');
  }
  // realtime: three namespaces read at scrape time.
  instance.realtime({ of: name => ({ sockets: new Map(name === '/' ? [[1, 1], [2, 2]] : []) }) });
}

describe('opt-in Prometheus metrics (NS_METRICS)', function () {
  this.timeout(20000);
  afterEach(() => metrics.reset());

  it('is off by default: no /metrics route, no client library load, no pool listener, shared no-op hooks', async function () {
    assert.deepEqual(metrics.settings({}), { enabled: false });
    assert.deepEqual(metrics.settings({ NS_METRICS: 'false' }), { enabled: false });
    assert.equal(metrics.settings({ NS_METRICS: 'true' }).enabled, true);
    assert.throws(() => metrics.settings({ NS_METRICS: 'yes' }), { code: 'METRICS_CONFIG_REFUSED' });
    const { port, started } = await startProcess({});
    try {
      assert.equal(metrics.current.enabled, false);
      assert.equal((await get(port, '/healthz/live')).status, 200);
      assert.equal((await get(port, '/metrics')).status, 404, 'METRICS_SERVED_WHILE_OFF');
      assert.equal(metrics.phase('acquisition'), metrics.phase('completion'), 'off hooks are one shared no-op');
      const pool = new (require('pg').Pool)();
      assert.equal(metrics.observePool(pool, 'nightscout-x'), pool);
      assert.equal(pool.listenerCount('connect'), 0, 'OFF_TOUCHED_POOL');
      assert.equal(metrics.current.middleware, null);
    } finally { await started.stop(); }
    // A fresh process: configuring with the default never loads @prometheus-io/client.
    const loaded = execFileSync(process.execPath, ['-e', `
      const m = require(${JSON.stringify(path.resolve(__dirname, '../lib/metrics'))});
      m.configure(['evaluator'], {}); m.phase('begin')();
      process.stdout.write(String(Object.keys(require.cache).some(k => k.includes('/node_modules/@prometheus-io/client/'))));`], { env: {} }).toString();
    assert.equal(loaded, 'false', 'METRICS_CLIENT_LOADED_WHILE_OFF');
  });

  it('when on, serves the named series with role and slice labels on serve.internal', async function () {
    const { port, started } = await startProcess({ NS_METRICS: 'true' });
    let runtime;
    try {
      const instance = metrics.current;
      assert.equal(instance.enabled, true);
      instance.setSlice(1);
      await exercise(instance);
      // The real evaluator runtime: phases and pending work.
      let now = 1000, version = 0;
      runtime = await startRuntime({ tenants: [A], externalRecovery: true, recoveryIntervalMs: 1000, timeIntervalMs: 60000,
        readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
        create: async () => ({ async evaluate () { return { checkpoint: version, properties: {}, emitted: [], requested: [] }; }, close () {} }),
        schedule: () => ({}), cancel () {}, now: () => now,
        durable: { pendingMs: 60000, async begin () { return { clock: String(version) }; },
          async complete (tenant, { result, identity }) { return { changed: true, pendingAt: null, output: { tenant, identity, outputRevision: ++version, contentDigest: 'b'.repeat(64), result } }; } } });
      instance.evaluator(() => runtime.pendingSummary());
      await runtime.acquire(A);
      runtime.markPending(A, now); now += 2500;

      const scrape = await get(port, '/metrics');
      assert.equal(scrape.status, 200);
      assert.match(scrape.type, /^text\/plain; version=0\.0\.4/);
      const text = scrape.body;
      for (const name of ['process_cpu_seconds_total', 'process_resident_memory_bytes', 'nodejs_eventloop_lag_seconds',
        'nodejs_heap_size_used_bytes',
        'nightscout_evaluator_phase_seconds_bucket',
        'nightscout_pg_statements_total', 'nightscout_pg_statement_seconds_total',
        'nightscout_evaluator_pending_oldest_age_seconds', 'nightscout_evaluator_pending_tenants',
        'nightscout_evaluator_queued_cycles', 'nightscout_http_request_seconds_bucket', 'nightscout_realtime_connected_sockets']) {
        assert.match(text, new RegExp('^' + name + '[{ ]', 'm'), 'MISSING_SERIES ' + name);
      }
      const role = 'api+evaluator';
      assert.equal(sample(text, 'process_cpu_seconds_total', { role }) !== undefined, true);
      // GC durations are declared at once and sampled at the first collection.
      assert.match(text, /^# TYPE nodejs_gc_duration_seconds histogram$/m);
      for (const phase of ['begin', 'settings', 'acquisition', 'completion']) {
        assert.equal(sample(text, 'nightscout_evaluator_phase_seconds_count', { role, slice: '1', phase }), 1, 'PHASE ' + phase);
      }
      assert.equal(sample(text, 'nightscout_evaluator_pending_oldest_age_seconds', { role, slice: '1' }), 2.5);
      assert.equal(sample(text, 'nightscout_evaluator_pending_tenants', { role, slice: '1' }), 1);
      assert.equal(sample(text, 'nightscout_pg_statements_total', { role, application_name: 'nightscout-evaluator-preview', outcome: 'ok' }), 2);
      assert.equal(sample(text, 'nightscout_http_request_seconds_count', { role, method: 'GET', route: '/api/v3/:collection/:identifier', status_class: '2xx' }), 1);
      assert.equal(sample(text, 'nightscout_http_request_seconds_count', { role, method: 'GET', route: 'unmatched', status_class: '4xx' }), 1);
      assert.equal(sample(text, 'nightscout_realtime_connected_sockets', { role, namespace: '/' }), 2);
      assert.equal((await get(port, '/healthz/live')).status, 200, 'health still answers beside /metrics');
    } finally { await runtime?.close(); await started.stop(); }
  });

  it('label-cardinality guard: no label value is or looks like a tenant id', async function () {
    const instance = metrics.create({ roles: ['api', 'evaluator', 'realtime'] });
    await exercise(instance);
    const text = await instance.text();
    assert.ok(labelValues(text).length > 50, 'the guard reads labels');
    assert.deepEqual(tenantLabels(text), [], 'TENANT_ID_IN_LABEL');
    instance.register.clear();
  });

  it('control: without the route sanitizer and the application_name allow-list, the guard fails', async function () {
    const broken = load('../lib/metrics/index.js', {}, source => source
      .replace("segment === '' || STATIC_SEGMENT.test(segment) ? segment : ':value'", 'segment')
      .replace("let label = typeof name === 'string' && APPLICATION.test(name) ? name : OTHER;", 'let label = String(name);'));
    const instance = broken.create({ roles: ['api'] });
    await exercise(instance);
    const found = tenantLabels(await instance.text()).map(({ name }) => name);
    instance.register.clear();
    assert.ok(found.includes('route') && found.includes('application_name'), 'GUARD_BLIND ' + JSON.stringify(found));
  });
});
