'use strict';
/* eslint-disable security/detect-non-literal-fs-filename -- Explicitly owned temporary configuration artifacts only. */
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { create } = require('../lib/tenant-lifecycle/lifetime-sessions');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture (max = 2, connectionTimeoutMillis = 30) {
  const clients = []; let connected = 0;
  return { clients, get connected () { return connected; }, options: { max, connectionTimeoutMillis },
    async connect () { connected++; const client = new EventEmitter(); client.released = 0; client.release = () => client.released++; clients.push(client); return client; } };
}
describe('bounded worker lifetime session ownership', function () {
  it('keeps physical allocation bounded by the existing explicit pool', async () => {
    const pool = fixture(); assert.throws(() => create({ pool, size: 3 }));
    const sessions = create({ pool, size: 2 });
    const first = await sessions.acquire(A), again = await sessions.acquire(A), second = await sessions.acquire(B);
    assert.equal(first.client, again.client); assert.notEqual(first.client, second.client); assert.equal(pool.connected, 2);
    await sessions.close(); assert(pool.clients.every(client => client.released === 1));
  });
  it('expires queued work before it can execute without poisoning a healthy owner', async () => {
    const pool = fixture(1), sessions = create({ pool, size: 1 }), one = await sessions.acquire(A), two = await sessions.acquire(B), gate = deferred();
    let entered = false;
    const holding = one.serial(() => gate.promise);
    await assert.rejects(two.serial(() => { entered = true; }), { code: 'LIFECYCLE_WINDOW_QUEUE_TIMEOUT' });
    gate.resolve(); await holding; await one.serial(() => {});
    assert.equal(entered, false); assert.equal(pool.connected, 1); await sessions.close();
  });
  it('revokes every active subscriber on owner loss and never silently adopts a replacement', async () => {
    const pool = fixture(1), sessions = create({ pool, size: 1 }), one = await sessions.acquire(A), two = await sessions.acquire(B);
    let invalidated = 0; const stop = one.subscribe(() => invalidated++); two.subscribe(() => invalidated++);
    one.client.emit('error', Object.assign(new Error('synthetic-owned-backend-lost'), { code: 'ECONNRESET' }));
    assert.equal(invalidated, 2); stop();
    await assert.rejects(two.serial(() => assert.fail('lost owner cannot run')));
    await assert.rejects(sessions.acquire(A)); assert.equal(pool.connected, 1);
    one.poison(); await sessions.close(); assert.equal(one.client.released, 1);
  });
});

describe('explicit operation lease-session selection', function () {
  it('keeps unselected behavior and bounds selected lanes by the existing physical pool', function () {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-lifetime-config-')), file = path.join(directory, 'operation.json');
    const input = { version: 1, namespace: 'synthetic_control', connectionEnv: 'NS_SYNTHETIC_PG', locks: [{ tenant: A, key: '1' }] };
    const env = { MULTITENANT_OPERATION_CONFIG: file, NS_SYNTHETIC_PG: 'postgres://synthetic:synthetic@127.0.0.1/synthetic', NS_POOL_OPERATION_MAX: '4' };
    const parse = value => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return require('../lib/server/serve/operation-cohort-config').load(env); };
    try {
      assert.equal(parse(input).leaseSessions, undefined);
      assert.equal(parse({ ...input, leaseSessions: 4 }).leaseSessions, 4);
      for (const bad of [0, -1, 1.5, '4', 5]) assert.throws(() => parse({ ...input, leaseSessions: bad }));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
