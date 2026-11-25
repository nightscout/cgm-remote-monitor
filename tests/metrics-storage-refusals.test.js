'use strict';

// nightscout_storage_refusals_total (lib/metrics): one count per 503 the api
// answers with a storage refusal code, by the code in the body, a bounded
// route class and the phase the refusal was produced in. Always on with
// NS_METRICS. The real tenant app and the real sendUnavailable answer the
// requests; the refusal errors are the shapes postgres-connection produces.
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const metrics = require('../lib/metrics');
const sendUnavailable = require('../lib/server/tenant-app/storage-unavailable');
const { createTenantApp } = require('../lib/server/tenant-app');

const A = '11111111-1111-4111-8111-111111111111';
const NAME = 'nightscout_storage_refusals_total';

function sample (text, labels) {
  for (const line of text.split('\n')) {
    if (!line.startsWith(NAME + '{')) continue;
    const found = Object.fromEntries([...line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'))
      .matchAll(/([a-zA-Z_]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (Object.keys(found).length === Object.keys(labels).length && Object.entries(labels).every(([k, v]) => found[k] === v)) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  return undefined;
}
function series (text) { return text.split('\n').filter(line => line.startsWith(NAME + '{')); }
const refusal = (code, phase) => Object.assign(new Error('synthetic ' + code), { code, retryAfter: 1, ...(phase ? { phase } : {}) });
const wrapped = (code, phase) => Object.assign(new Error('operation failed', { cause: refusal(code, phase) }), { code: 'WRAPPED' });

// The v3 and owner storage error answer (sendUnavailable) inside a plain Express app.
function storageApp (error) {
  const app = express();
  const answer = (req, res) => { if (!sendUnavailable(error(), res)) res.status(500).end(); };
  app.all('/api/v3/:collection', answer);
  app.all('/api/v3/:collection/:identifier', answer);
  app.all('/api/v1/:collection', answer);
  app.all('/elsewhere/:value', answer);
  return app;
}

// The tenant app's own failure handler (SERVICE_STATUS), reached from a data router.
function tenantApp (error) {
  const data = express.Router();
  data.all('/:collection', (req, res, next) => next(error()));
  return createTenantApp({
    resolver: { resolve: async () => 'A' },
    verifyCredential: async () => ({ tenant: 'A', principal: 'data', consumer: 'client' }),
    authorizeRequest: async () => true,
    tenantSettings: { read () {}, replace () {}, rollback () {} },
    subjectPolicy: { read () {}, replace () {} },
    dataRouter: data
  });
}

describe('storage refusal counter (nightscout_storage_refusals_total)', function () {
  afterEach(() => metrics.reset());

  it('off: the hook is a shared no-op and the 503 answer is unchanged', async function () {
    assert.equal(metrics.current.enabled, false);
    await request(storageApp(() => refusal('STORAGE_BUSY', 'checkout'))).post('/api/v3/entries').expect(503, { error: 'STORAGE_BUSY' });
    assert.equal(typeof metrics.storageRefusal, 'function', 'HOOK_MISSING');
    assert.equal(metrics.storageRefusal('STORAGE_BUSY', 'checkout', {}), undefined);
  });

  it('api: every code and phase is present at zero from boot', async function () {
    const instance = metrics.configure(['api'], { NS_METRICS: 'true' });
    const text = await instance.text();
    for (const [code, phase] of [['STORAGE_BUSY', 'checkout'], ['STORAGE_TIMEOUT', 'open'], ['STORAGE_TIMEOUT', 'clock'],
      ['STORAGE_TIMEOUT', 'statement'], ['STORAGE_UNAVAILABLE', 'suspended'], ['STORAGE_UNAVAILABLE', 'none']]) {
      assert.equal(sample(text, { role: 'api', code, route_class: 'other_write', phase }), 0, 'NOT_PRESENT_AT_ZERO ' + code + ' ' + phase);
    }
  });

  it('STORAGE_BUSY: counted once per 503, by route class, with the checkout phase', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    const app = storageApp(() => wrapped('STORAGE_BUSY', 'checkout'));
    await request(app).post('/api/v3/entries').expect(503, { error: 'STORAGE_BUSY' });
    await request(app).post('/api/v3/entries').expect(503);
    await request(app).get('/api/v3/treatments/' + A).expect(503);
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_BUSY', route_class: 'entries_write', phase: 'checkout' }), 2);
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_BUSY', route_class: 'treatments_read', phase: 'checkout' }), 1);
  });

  it('STORAGE_TIMEOUT: the clock, open and statement phases are separate series', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    let phase = 'clock';
    const app = storageApp(() => wrapped('STORAGE_TIMEOUT', phase));
    await request(app).post('/api/v1/entries.json').expect(503, { error: 'STORAGE_TIMEOUT' });
    phase = 'statement';
    await request(app).post('/api/v1/entries.json').expect(503);
    phase = 'open';
    await request(app).put('/api/v3/devicestatus/' + A).expect(503);
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'entries_write', phase: 'clock' }), 1);
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'entries_write', phase: 'statement' }), 1);
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'devicestatus_write', phase: 'open' }), 1);
  });

  it('STORAGE_UNAVAILABLE: an outage and a suspended window are counted under the code the body carries', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    const app = storageApp(() => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await request(app).get('/api/v3/profile').expect(503, { error: 'STORAGE_UNAVAILABLE' });
    // A suspended operation window is answered STORAGE_UNAVAILABLE too; its
    // phase says so (sendUnavailable passes it for a recognised suspension).
    metrics.storageRefusal('STORAGE_UNAVAILABLE', 'suspended', { method: 'GET', originalUrl: '/api/v3/profile' });
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_UNAVAILABLE', route_class: 'profile_read', phase: 'none' }), 1);
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_UNAVAILABLE', route_class: 'profile_read', phase: 'suspended' }), 1);
  });

  it('the tenant app failure handler counts the refusal codes it answers with 503', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    let error = () => refusal('STORAGE_BUSY', 'checkout');
    const app = tenantApp(() => error());
    await request(app).post('/api/v3/entries').set('Authorization', 'Bearer x').expect(503, { error: 'STORAGE_BUSY' });
    error = () => refusal('STORAGE_TIMEOUT', 'clock');
    await request(app).post('/api/v3/treatments').set('Authorization', 'Bearer x').expect(503, { error: 'STORAGE_TIMEOUT' });
    error = () => Object.assign(new Error('x'), { code: 'TENANT_WARMING' });
    await request(app).get('/api/v3/entries').set('Authorization', 'Bearer x').expect(503, { error: 'TENANT_WARMING' });
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_BUSY', route_class: 'entries_write', phase: 'checkout' }), 1);
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'treatments_write', phase: 'clock' }), 1);
    assert.equal(series(text).some(line => line.includes('TENANT_WARMING')), false, 'NOT_A_STORAGE_CODE');
  });

  it('the tenant app failure handler answers and counts a wrapped storage refusal by its own code', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    const app = tenantApp(() => wrapped('STORAGE_TIMEOUT', 'statement'));
    const res = await request(app).post('/api/v3/entries').set('Authorization', 'Bearer x').expect(503, { error: 'STORAGE_TIMEOUT' });
    assert.equal(res.headers['retry-after'], '1');
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'entries_write', phase: 'statement' }), 1);
  });

  it('labels stay in closed sets: unknown phases, routes and tenant ids never become label values', async function () {
    metrics.configure(['api'], { NS_METRICS: 'true' });
    const app = storageApp(() => wrapped('STORAGE_TIMEOUT', A));
    await request(app).post('/elsewhere/' + A).expect(503);
    await request(app).delete('/api/v3/' + A + '/' + A).expect(503);
    metrics.storageRefusal('NOT_A_CODE', 'clock', { method: 'GET', originalUrl: '/api/v3/entries' });
    const text = await metrics.current.text();
    assert.equal(sample(text, { role: 'api', code: 'STORAGE_TIMEOUT', route_class: 'other_write', phase: 'none' }), 2);
    assert.deepEqual(series(text).filter(line => metrics.tenantLike(line) || line.includes(A) || line.includes('NOT_A_CODE')), []);
    const codes = new Set(), classes = new Set(), phases = new Set();
    for (const line of series(text)) {
      codes.add(/code="([^"]*)"/.exec(line)[1]); classes.add(/route_class="([^"]*)"/.exec(line)[1]); phases.add(/phase="([^"]*)"/.exec(line)[1]);
    }
    for (const code of codes) assert.ok(metrics.REFUSAL_CODES.includes(code), code);
    for (const value of classes) assert.ok(metrics.REFUSAL_ROUTE_CLASSES.includes(value), value);
    for (const value of phases) assert.ok(metrics.REFUSAL_PHASES.includes(value), value);
    assert.ok(metrics.REFUSAL_ROUTE_CLASSES.length <= 16 && metrics.REFUSAL_PHASES.length <= 6, 'BOUND');
  });
});
