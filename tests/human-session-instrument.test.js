'use strict';

const assert = require('node:assert/strict');
const { run, closeOwned, closeBrowser, assertPort, admitOwnerExtension, closeOwnerAndNative, fixtureOrigins } = require('./human-session-http-native');

describe('bounded human HTTPS instrument (no listeners)', function () {
  it('uses a real owner hostname accepted by the unchanged resolver while keeping provider cookies on a different host', async function () {
    const tenant = '11111111-1111-4111-8111-111111111111';
    const resolver = require('../lib/tenant-resolution')({ aliases: [{ host: 'localhost', tenant }] });
    const first = 'https://127.0.0.1:23456', second = 'https://127.0.0.1:23457';
    for (const browser of [false, true]) {
      const { site, issuer } = fixtureOrigins(first, second, { owner: true, browser });
      const host = new URL(site).host;
      assert.equal(await resolver.resolve({ rawHeaders: ['Host', host] }), tenant);
      assert.notEqual(new URL(site).hostname, new URL(issuer).hostname, 'cookie hosts must differ');
    }
    assert.deepEqual(fixtureOrigins(first, second), { site: first, issuer: second });
    const defaults = fixtureOrigins(first, second, { browser: true });
    assert.equal(defaults.site, first);
    assert.equal(new URL(defaults.issuer).hostname, 'localhost');
  });

  it('refuses owner extension setup before TLS or runtime acquisition without complete reserved native inputs', async function () {
    const source = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    let calls = 0;
    const factory = Object.assign(() => { throw new Error('No factory acquisition in admission'); }, { admit () { calls++; } });
    for (const name of Object.keys(source)) {
      const missing = { ...source }; delete missing[name];
      assert.throws(() => admitOwnerExtension(factory, missing), /explicit reserved native/);
      assert.equal(calls, 0);
    }
    assert.throws(() => admitOwnerExtension(() => {}, source), /explicit reserved native/);
    admitOwnerExtension(factory, source); assert.equal(calls, 1);
    admitOwnerExtension(undefined, {});
    const saved = process.env.HUMAN_HTTPS_RESERVED;
    try {
      delete process.env.HUMAN_HTTPS_RESERVED;
      await assert.rejects(run({ createOwnerExtension: factory }), /one-run HTTPS reservation/);
      assert.equal(calls, 1, 'run refuses before invoking even pure extension admission');
    } finally {
      if (saved === undefined) delete process.env.HUMAN_HTTPS_RESERVED;
      else process.env.HUMAN_HTTPS_RESERVED = saved;
    }
  });

  it('keeps extension admission synchronous and propagates owned-config refusal', function () {
    const source = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    assert.throws(() => admitOwnerExtension(Object.assign(() => {}, { admit: () => Promise.resolve() }), source), /must be synchronous/);
    assert.throws(() => admitOwnerExtension(Object.assign(() => {}, { admit () { throw new Error('owned-config-refused'); } }), source), /owned-config-refused/);
  });

  it('checks extension-owned admission before reading TLS materials in the actual runner', async function () {
    const selected = { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_HTTP_STORE: 'postgres',
      HUMAN_HTTP_SIGNER_CONFIG: 'synthetic-config', HUMAN_SESSION_PG_ADMIN_URL: 'synthetic-admin', HUMAN_SESSION_PG_APP_URL: 'synthetic-app' };
    const saved = new Map(Object.keys(selected).map(key => [key, process.env[key]]));
    const factory = Object.assign(() => { throw new Error('No owner factory acquisition'); }, {
      admit () { throw new Error('OWNED_ADMISSION_REFUSED_BEFORE_TLS'); }
    });
    try {
      Object.assign(process.env, selected);
      await assert.rejects(run({ createOwnerExtension: factory }), /OWNED_ADMISSION_REFUSED_BEFORE_TLS/);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('drains owner pools before native schemas and retains both cleanup failures', async function () {
    const events = [];
    const owner = { async close () { await Promise.resolve(); events.push('owner'); } };
    const native = { async close () { assert.deepEqual(events, ['owner']); events.push('native'); } };
    await closeOwnerAndNative(owner, native); assert.deepEqual(events, ['owner', 'native']);
    const fail = value => ({ async close () { events.push(value); throw new Error(value); } });
    await assert.rejects(closeOwnerAndNative(fail('owner-failed'), fail('native-failed')), error =>
      error instanceof globalThis.AggregateError && error.errors.map(item => item.message).join(',') === 'owner-failed,native-failed');
    assert.deepEqual(events.slice(-2), ['owner-failed', 'native-failed']);
  });

  it('refuses the reserved ports after ephemeral binding without retrying them', function () {
    for (const port of [18080, 18081, 18082]) assert.throws(() => assertPort(port), /reserved port/);
    assertPort(23456);
  });

  it('waits for actual socket close events and server callbacks before reporting closure', async function () {
    const sockets = new Set(), socketClosures = new Map();
    let serverClosed = false, socketClosed = false, resolveSocket;
    const socket = { destroy () { setTimeout(() => {
      socketClosed = true; sockets.delete(socket); resolveSocket();
    }, 15); } };
    sockets.add(socket); socketClosures.set(socket, new Promise(resolve => { resolveSocket = resolve; }));
    const server = { close (callback) { setTimeout(() => { serverClosed = true; callback(); }, 25); } };
    const closing = closeOwned({ servers: [server], sockets, socketClosures, timeoutMs: 200 });
    assert.equal(socketClosed, false); assert.equal(serverClosed, false);
    await closing; assert.equal(socketClosed, true); assert.equal(serverClosed, true);
  });

  it('goes red on an unobserved socket close and invokes its finite deadline refusal', async function () {
    const socket = { destroy () {} }, sockets = new Set([socket]);
    let refused = false;
    await assert.rejects(closeOwned({ servers: [{ close: callback => callback() }], sockets,
      socketClosures: new Map([[socket, new Promise(() => {})]]), timeoutMs: 20,
      onDeadline: () => { refused = true; } }), /cleanup exceeded/);
    assert.equal(refused, true);
  });

  it('refuses failed server close rather than turning cleanup into a pass', async function () {
    await assert.rejects(closeOwned({ servers: [{ close: callback => callback(new Error('synthetic close failed')) }],
      sockets: new Set(), socketClosures: new Map(), timeoutMs: 100 }), /synthetic close failed/);
  });

  it('observes every owned cleanup even after a different resource refuses', async function () {
    let drained = false;
    await assert.rejects(closeOwned({ servers: [], sockets: new Set(), socketClosures: new Map(), timeoutMs: 200,
      resources: [{ close: async () => { throw new Error('synthetic resource refused'); } },
        { close: () => new Promise(resolve => setTimeout(() => { drained = true; resolve(); }, 20)) }] }), /synthetic resource refused/);
    assert.equal(drained, true);
  });

  it('kills a browser on immediate graceful-close refusal and retains that failure after proving listener closure', async function () {
    const events = [];
    const server = { wsEndpoint: () => 'ws://127.0.0.1:23456/owned',
      close: async () => { throw new Error('synthetic graceful close failed'); }, kill: async () => { events.push('kill'); } };
    await assert.rejects(closeBrowser(server, { probe: async () => { events.push('listener-closed'); } }), /synthetic graceful close failed/);
    assert.deepEqual(events, ['kill', 'listener-closed']);
  });

  it('kills a hung graceful browser close within its bound and refuses a surviving listener', async function () {
    let killed = false;
    const server = { wsEndpoint: () => 'ws://127.0.0.1:23456/owned',
      close: () => new Promise(() => {}), kill: async () => { killed = true; } };
    await assert.rejects(closeBrowser(server, { graceMs: 10, probe: async () => {} }), /graceful cleanup deadline/);
    assert.equal(killed, true);
    await assert.rejects(closeBrowser({ ...server, close: async () => {} }, {
      probe: async () => { throw new Error('synthetic surviving listener'); }
    }), /surviving listener/);
  });
});

describe('exhaustive native stage admission (no acquisition)', function () {
  const { admitNativeStage } = require('./human-session-http-native');
  const at = 1000000;
  function fixture (id) {
    const owner = id.startsWith('owner-');
    return { stage: { id, persistence: owner ? 'postgres' : 'mongo', signing: 'configured-transit',
      activeMs: 120000, cleanupMs: 15000, transportMs: id === 'owner-authority' ? 8000 : 5000,
      activeEndsAt: at + 120000, cleanupEndsAt: at + 135000, browser: ['mongo-http', 'owner-browser'].includes(id) },
    source: { HUMAN_HTTPS_RESERVED: '1', HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_VAULT_RESERVED: '1',
      HUMAN_HTTP_STORE: owner ? 'postgres' : 'mongo', HUMAN_HTTP_SIGNER_CONFIG: 'explicit-private-file',
      HUMAN_SESSION_MONGO_URL: 'explicit-mongo', HUMAN_SESSION_PG_ADMIN_URL: 'explicit-admin', HUMAN_SESSION_PG_APP_URL: 'explicit-app',
      HUMAN_BROWSER_RESERVED: '1', HUMAN_BROWSER_EXECUTABLE: 'explicit-browser' } };
  }
  it('requires explicit native persistence, Transit, phase and absolute bounds before TLS IO', function () {
    for (const id of ['mongo-http', 'owner-consumer', 'owner-authority', 'owner-browser', 'owner-compatibility']) {
      const value = fixture(id); assert.equal(admitNativeStage(value.stage, value.source, at), true);
      for (const key of Object.keys(value.stage)) {
        const missing = { ...value.stage }; delete missing[key];
        assert.throws(() => admitNativeStage(missing, value.source, at), /COMPLETE_STAGE_REQUIRED/, id + '/' + key);
      }
      for (const key of ['HUMAN_HTTPS_RESERVED', 'HUMAN_SESSION_NATIVE_RESERVED', 'HUMAN_VAULT_RESERVED', 'HUMAN_HTTP_STORE', 'HUMAN_HTTP_SIGNER_CONFIG']) {
        const missing = { ...value.source }; delete missing[key];
        assert.throws(() => admitNativeStage(value.stage, missing, at), /COMPLETE_STAGE_REQUIRED/);
      }
      for (const mutate of [stage => { stage.persistence = 'double'; }, stage => { stage.signing = 'local'; },
        stage => { stage.activeEndsAt = at; }, stage => { stage.cleanupEndsAt++; }, stage => { stage.activeMs++; }]) {
        const changed = { ...value.stage }; mutate(changed);
        assert.throws(() => admitNativeStage(changed, value.source, at), /COMPLETE_STAGE_REQUIRED/);
      }
    }
  });
});

describe('native Transit clock apparatus (offline public verification)', function () {
  const nativeAccess = require('./fixtures/human-native-access');
  it('denies before file IO without both native reservations and explicit profile', function () {
    for (const source of [{}, { HUMAN_SESSION_NATIVE_RESERVED: '1' },
      { HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_VAULT_RESERVED: '1' }]) {
      assert.throws(() => nativeAccess({ tenant: 'single', now: () => 1000, source }), /reserved native Transit/);
    }
  });
  it('keeps real configured Ed25519 verification, clock expiry and native-only issuance', async function () {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-clock-'));
    const file = path.join(directory, 'public.json');
    let clock = 1000;
    const local = require('./fixtures/human-access-issuer')({ tenant: 'single', now: () => clock });
    const config = { version: 1, issuer: local.issuer, audiences: local.audiences,
      vault: { addressEnv: 'NATIVE_CLOCK_ADDRESS', tokenEnv: 'NATIVE_CLOCK_TOKEN', mount: 'transit' },
      keys: local.keys.map(key => ({ tenant: key.tenant, purpose: key.purpose, kid: key.kid, current: true,
        publicKey: Buffer.from(key.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
        signingKey: 'synthetic-' + key.purpose, signingVersion: 1 })) };
    const source = { HUMAN_SESSION_NATIVE_RESERVED: '1', HUMAN_VAULT_RESERVED: '1', HUMAN_SESSION_SIGNER_CONFIG: file,
      NATIVE_CLOCK_ADDRESS: 'https://vault.synthetic.invalid', NATIVE_CLOCK_TOKEN: 'synthetic-test-only' };
    const saved = globalThis.fetch; let calls = 0;
    try {
      fs.writeFileSync(file, JSON.stringify(config));
      globalThis.fetch = async () => { calls++; throw new Error('offline provider refused'); };
      const loaded = nativeAccess({ tenant: 'single', now: () => clock, source });
      const token = await local.access.issue({ tenant: 'single', subject: 'reader', session: 'session', purpose: 'data',
        credentialVersion: 1, issuedAt: clock, expiresAt: clock + 600 });
      assert.equal(loaded.signing, 'configured-transit');
      assert.equal(loaded.access.verify({ tenant: 'single', token }).sub, 'reader');
      assert.throws(() => loaded.access.verify({ tenant: 'single', token: token.slice(0, -8) + 'AAAAAAAA' }));
      clock += 601; assert.throws(() => loaded.access.verify({ tenant: 'single', token })); clock = 1000;
      globalThis.fetch = async () => { calls++; throw new Error('offline provider refused'); };
      await assert.rejects(loaded.access.issue({ tenant: 'single', subject: 'reader', session: 'session', purpose: 'data',
        credentialVersion: 1, issuedAt: clock, expiresAt: clock + 600 }), { code: 'HUMAN_SESSION_UNAVAILABLE' });
      assert.equal(calls, 1, 'issuance reaches native provider and has no local signer fallback');
    } finally { globalThis.fetch = saved; fs.rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('standalone native active and cleanup budgets (inert)', function () {
  const createBudget = require('./fixtures/human-native-budget');
  it('refuses implicit stages and prevents cleanup allowance from authorizing active work', function () {
    let clock = 1000000;
    const stage = { id: 'mongo-sessions', persistence: 'mongo', signing: 'configured-transit', activeMs: 90000,
      cleanupMs: 15000, activeEndsAt: clock + 90000, cleanupEndsAt: clock + 105000 };
    const input = { stage, id: stage.id, persistence: stage.persistence, now: () => clock };
    assert.throws(() => createBudget({ ...input, stage: undefined }), /EXPLICIT_STAGE_REQUIRED/);
    const budget = createBudget(input); budget.active();
    clock = stage.activeEndsAt; assert.throws(() => budget.active(), /ACTIVE_DEADLINE/); budget.cleanup();
    clock = stage.cleanupEndsAt; assert.throws(() => budget.cleanup(), /CLEANUP_DEADLINE/);
  });
});

describe('native Mongo physical identity cleanup guard (inert)', function () {
  const { collectionIdentity, dropCollection } = require('./fixtures/human-native-identity');
  it('captures UUID and refuses a replaced same-name collection before drop', async function () {
    let value = 'a'.repeat(32), drops = 0;
    const db = { listCollections: () => ({ next: async () => ({ type: 'collection', info: {
      uuid: { sub_type: 4, length: () => 16, toString: () => value } } }) }), collection: () => ({ drop: async () => { drops++; } }) };
    const identity = await collectionIdentity(db, 'owned');
    value = 'b'.repeat(32); await assert.rejects(dropCollection(db, identity), /IDENTITY_CHANGED/); assert.equal(drops, 0);
    value = identity.uuid; await dropCollection(db, identity); assert.equal(drops, 1);
  });
  it('refuses absent physical identity', async function () {
    await assert.rejects(collectionIdentity({ listCollections: () => ({ next: async () => null }) }, 'owned'), /UUID_REQUIRED/);
  });
});
