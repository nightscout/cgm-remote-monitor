'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { create } = require('../lib/tenant-lifecycle/operation-window');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function fixture (options = {}) {
  const log = [], pending = new Map();
  const client = new EventEmitter();
  client.release = error => log.push(['release', !!error]);
  client.query = async (text, values) => {
    log.push([text, values]);
    if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: !!options.superuser, rolbypassrls: false }] };
    if (text.includes('pg_try_advisory_lock_shared')) return { rows: [{ held: options.held !== false }] };
    if (text.includes('pg_advisory_unlock_shared')) return { rows: [{ released: options.unlock !== false }] };
    if (text.startsWith('SELECT lock_key')) return { rows: [{ lock_key: options.key || (values[0] === B ? '19' : '17'), phase: options.phase || 'active', generation: '1' }] };
    if (text.startsWith('INSERT INTO')) { pending.set(values[1], false); return { rows: [], rowCount: 1 }; }
    if (text.startsWith('UPDATE')) { pending.set(values[1], true); return { rows: [], rowCount: 1 }; }
    return { rows: [] };
  };
  const pool = { connect: async () => client };
  return { client, log, pending, window: create({ namespace: 'synthetic_window', locks: [{ tenant: A, key: '17' }, { tenant: B, key: '19' }], pool }) };
}

describe('Tenant operation window source protocol (not PostgreSQL evidence)', function () {
  it('registers durably before the actual callback and finishes only after it settles', async function () {
    const f = fixture(); let end;
    const barrier = new Promise(resolve => { end = resolve; });
    const running = f.window.run(A, async () => {
      assert.deepEqual([...f.pending.values()], [false]);
      assert.equal(f.log.filter(row => row[0] === 'COMMIT').length, 1);
      f.window.assertCurrent(A); await barrier; return 7;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...f.pending.values()], [false]); end();
    assert.equal(await running, 7);
    assert.deepEqual([...f.pending.values()], [true]);
    assert.equal(f.log.at(-1)[0], 'release');
  });
  for (const [label, options, code] of [
    ['held exclusive lock', { held: false }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['suspended state', { phase: 'suspended' }, 'LIFECYCLE_WINDOW_SUSPENDED'],
    ['changed lock binding', { key: '23' }, 'LIFECYCLE_WINDOW_BINDING_CHANGED'],
    ['privileged role', { superuser: true }, 'LIFECYCLE_WINDOW_ROLE_UNSAFE']
  ]) it('refuses ' + label + ' before registration or callback', async function () {
    const f = fixture(options); let called = false;
    await assert.rejects(f.window.run(A, () => { called = true; }), { code });
    assert.equal(called, false); assert.equal(f.pending.size, 0);
  });
  it('finishes a failed callback whose lease connection remains healthy', async function () {
    const f = fixture(); const original = new Error('synthetic body refusal');
    await assert.rejects(f.window.run(A, () => { throw original; }), error => error === original);
    assert.deepEqual([...f.pending.values()], [true]);
  });
  it('keeps a durable pending record after lease connection loss and invalidates current scope', async function () {
    const f = fixture(); const original = new Error('synthetic lost lease connection'); let invalidated = 0;
    await assert.rejects(f.window.run(A, async () => {
      f.client.emit('error', original);
      assert.throws(() => f.window.assertCurrent(A), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
    }, { onInvalidated: () => { invalidated++; } }), error => error === original);
    assert.equal(invalidated, 1);
    assert.deepEqual([...f.pending.values()], [false]);
    assert.equal(f.log.some(row => typeof row[0] === 'string' && row[0].startsWith('UPDATE')), false);
  });
  it('reuses same-tenant outer lifetime and refuses cross-tenant nesting', async function () {
    const f = fixture();
    await f.window.run(A, async () => {
      await f.window.run(A, async () => f.window.assertCurrent(A));
      await assert.rejects(f.window.run(B, () => {}), { code: 'LIFECYCLE_WINDOW_SCOPE_INVALID' });
    });
    assert.equal(f.pending.size, 1);
  });
  it('reports unlock loss instead of returning an ordinary success', async function () {
    const f = fixture({ unlock: false });
    await assert.rejects(f.window.run(A, () => 1), { code: 'LIFECYCLE_WINDOW_RELEASE_FAILED' });
    assert.equal(f.log.at(-1)[1], true, 'failed connection must be evicted');
  });
  it('refuses unknown tenants and closed windows before pool access', async function () {
    const f = fixture();
    await assert.rejects(f.window.run('33333333-3333-4333-8333-333333333333', () => {}), { code: 'LIFECYCLE_WINDOW_TENANT_UNKNOWN' });
    await f.window.close();
    await assert.rejects(f.window.run(A, () => {}), { code: 'LIFECYCLE_WINDOW_CLOSED' });
    assert.deepEqual(f.log, []);
  });
});


describe('Actual consumers use operation-window lifetimes (source protocol)', function () {
  const request = require('supertest');
  function app (window, handler) {
    const express = require('express');
    const router = express.Router(); router.get('/entries', handler);
    const unavailable = async () => { throw new Error('not selected'); };
    return require('../lib/server/tenant-app').createTenantApp({
      operationWindow: window, resolver: { resolve: () => A }, dataRouter: router,
      dataAccess: async () => ({ tenant: A, principal: 'synthetic', consumer: 'synthetic' }),
      verifyCredential: unavailable, authorizeRequest: unavailable,
      tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }
    });
  }
  it('covers actual tenant HTTP response finish and refuses suspension before the data handler', async function () {
    const f = fixture(); let served = 0;
    await request(app(f.window, (req, res) => {
      f.window.assertCurrent(A); assert.deepEqual([...f.pending.values()], [false]);
      served++; res.json({ synthetic: true });
    })).get('/api/v3/entries').expect(200);
    await f.window.close(); assert.equal(served, 1); assert.deepEqual([...f.pending.values()], [true]);
    const suspended = fixture({ phase: 'suspended' });
    await request(app(suspended.window, (req, res) => { served++; res.json({}); })).get('/api/v3/entries').expect(503);
    assert.equal(served, 1); assert.equal(suspended.pending.size, 0);
  });
  it('covers actual evaluator cycles and excludes retained output outside an admitted lifetime', async function () {
    const f = fixture(); let evaluations = 0;
    const runtime = await require('../lib/server/serve/evaluator-runtime')({ tenants: [A],
      operationWindow: f.window, readCurrent: async tenant => ({ tenant, identity: '1'.repeat(64) }),
      create: async () => ({ evaluate: async () => { f.window.assertCurrent(A); evaluations++; return { checkpoint: 0 }; },
        evaluateTime: async () => ({ checkpoint: 0 }), close () {} }),
      recoveryIntervalMs: 10, timeIntervalMs: 20, schedule: () => 1, cancel: () => {} });
    try {
      assert.equal(evaluations, 1); assert.equal(runtime.last(A), null);
      await f.window.run(A, async () => assert.equal(runtime.last(A).eligible, true));
    } finally { await runtime.close(); await f.window.close(); }
  });
  it('covers realtime acquisition/fanout and recovers after a refused window', async function () {
    const options = {}; const f = fixture(options); let delivered = 0;
    const runtime = await require('../lib/server/realtime/runtime')({ tenants: [A], operationWindow: f.window,
      readCurrent: async tenant => ({ tenant, identity: '1'.repeat(64) }),
      create: () => ({ acquire: async () => ({ frame: {} }) }),
      fanout: async () => { f.window.assertCurrent(A); delivered++; },
      recoveryIntervalMs: 10, schedule: () => 1, cancel: () => {} });
    try {
      assert.equal(delivered, 1); assert.equal(runtime.last(A), null);
      options.phase = 'suspended'; await assert.rejects(runtime.refresh(A), { code: 'LIFECYCLE_WINDOW_SUSPENDED' });
      assert.equal(delivered, 1);
      options.phase = 'active'; await runtime.refresh(A); assert.equal(delivered, 2);
    } finally { await runtime.close(); await f.window.close(); }
  });
  it('covers the actual notification producer/retry/adapter handoff and refuses suspended work', async function () {
    const options = {}, f = fixture(options); let sends = 0;
    const mode = require('../lib/storage/tenant-scope'); const prior = mode.getTenancyMode(); mode.setTenancyMode('multi');
    let composed;
    try {
      composed = await require('./fixtures/evaluator-consumers-protocol')((request, callback) => {
        f.window.assertCurrent(request.tenant); sends++; callback(null, { accepted: true, receipt: null, clearedRequestIds: [] });
      }, { operationWindow: f.window });
      await composed.start(); assert.equal(sends, 2);
      options.phase = 'suspended'; await composed.consumers.retry(A); await composed.consumers.flush(A);
      assert.equal(sends, 2); assert.equal(composed.consumers.health().tenants.find(row => row.tenant === A).state, 'refused');
    } finally {
      if (composed) await composed.close(); await f.window.close(); mode.setTenancyMode(prior);
    }
  });
  it('covers the actual socket forwarding acknowledgement and refuses without acknowledgement', async function () {
    const options = {}; const f = fixture(options); let replies = 0;
    const forward = require('../lib/server/tenant-socket-forwarding').createForwarder({
      contextForSocket: async () => ({ tenant: A, credential: {} }),
      withOperation: f.window.run,
      transport: async () => { f.window.assertCurrent(A); return { replyArgs: ['synthetic'] }; }
    });
    const input = { namespace: '/', event: 'dbAdd', args: [], acknowledge: () => { f.window.assertCurrent(A); replies++; } };
    assert.equal((await forward.forward(input)).delivered, true); assert.equal(replies, 1);
    options.phase = 'suspended'; assert.equal((await forward.forward(input)).delivered, false); assert.equal(replies, 1);
    await f.window.close();
  });
});
