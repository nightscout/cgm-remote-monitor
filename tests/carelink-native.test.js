'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const crypto = require('node:crypto');
const shiro = require('shiro-trie');
const { createAuth, capture, REDIRECT } = require('../lib/connect/sources/carelink/auth');
const { transform, timestamp } = require('../lib/connect/sources/carelink/transform');
const { providerUrl, publicAddress } = require('../lib/connect/sources/carelink/http');
const policy = require('../lib/connect/browser/policy');
const Manager = require('../lib/connect/manager');
const ConnectError = require('../lib/connect/errors');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

function setup(initial = null, options = {}) {
  let saved = clone(initial), emitted = [], events, closed = 0, exchanges = 0;
  let queue = Promise.resolve();
  const store = { load: async () => clone(saved), save: async value => { saved = clone(value); }, exclusive: fn => {
    const next = queue.then(() => fn(async () => {})); queue = next.catch(() => {}); return next;
  } };
  const auth = { countries: async () => [], begin: async country => ({ country, region: 'eu', state: 'state', url: 'https://carelink-login.minimed.eu/authorize' }),
    exchange: async () => { exchanges++; return { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 }; },
    refresh: async () => ({ accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresAt: Date.now() + 3600000 }) };
  const account = { patients: [{ username: 'patient-one', label: 'Person one' }] };
  const client = { account: async () => account, data: async () => ({ sgs: [{ sg: 123, datetime: new Date().toISOString() }] }) };
  const browser = { available: () => true, open: async callbacks => { events = callbacks; return { close: async () => { closed++; }, input: async () => ({ label: 'Password' }) }; } };
  const manager = new Manager({ store, auth, client, browser, output: async batch => emitted.push(batch), ...options });
  return { manager, store, auth, client, browser, account, saved: () => saved, emitted: () => emitted,
    events: () => events, closed: () => closed, exchanges: () => exchanges };
}
async function start(f) { const s = await f.manager.start('owner', { country: 'GB' }); await tick(); return s; }
async function loggedIn(f) { const s = await start(f); await f.manager.callback(f.manager.session, REDIRECT + '?state=state&code=one-use'); return s; }

describe('native CareLink protocol and security boundaries', function () {
  it('captures only the exact custom callback and matching state', function () {
    assert.equal(capture(REDIRECT + '?code=abc&state=correct', 'correct'), 'abc');
    for (const url of ['https://attacker.example/sso?code=x&state=correct', 'com.medtronic.carepartner://evil/sso?code=x&state=correct', REDIRECT + '/extra?code=x&state=correct']) assert.equal(capture(url, 'correct'), null);
  });
  it('rejects duplicate, missing, wrong and malformed state or authorization codes', function () {
    for (const suffix of ['?code=a', '?state=bad&code=a', '?state=ok&state=ok&code=a', '?state=ok&code=a&code=b', '?state=ok&error=access_denied', '?state=éé&code=x']) {
      assert.throws(() => capture(REDIRECT + suffix, 'ok'), ConnectError);
    }
  });
  it('rejects private and non-IPv4 resolved destinations', function () {
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.1.1', '::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false);
    assert.equal(publicAddress('8.8.8.8'), true);
  });
  it('restricts provider endpoints and browser navigation', function () {
    for (const url of ['http://carelink.minimed.eu', 'https://minimed.eu.evil.test', 'https://user:pass@carelink.minimed.eu', 'https://127.0.0.1', 'file:///etc/passwd', 'https://carelink.minimed.eu:8443']) {
      assert.throws(() => providerUrl(url)); assert.equal(policy.allowedUrl(url), false);
    }
    assert.equal(policy.allowedUrl('https://client-api.arkoselabs.com/'), true);
    assert.equal(policy.allowedUrl('https://carelink-login.minimed.eu/'), true);
    assert.equal(policy.allowedUrl('https://example.com/'), false);
  });
  it('validates pointer coordinates, text bounds and fixed key commands', function () {
    assert.equal(policy.input({ type: 'click', x: 20, y: 40 }, 320, 500).x, 20);
    for (const value of [{ type: 'click', x: Infinity, y: 0 }, { type: 'click', x: 320, y: 0 }, { type: 'key', key: 'F12' }, { type: 'text', text: 'a'.repeat(2049) }, { type: 'navigate', url: 'https://evil.test' }]) assert.throws(() => policy.input(value, 320, 500));
  });
  it('discovers countries/regions and binds a fresh PKCE transaction', async function () {
    const config = { server: { hostname: 'carelink-login.minimed.eu', port: 443 }, client: { client_id: 'public-client', scope: 'openid offline_access', audience: 'patient', redirect_uri: REDIRECT }, system_endpoints: { authorization_endpoint_path: '/authorize', token_endpoint_path: '/oauth/token' } };
    const auth = createAuth(async url => url.includes('/discover/') ? { CP: [{ region: 'EU', Auth0SSOConfiguration: 'https://carelink.minimed.eu/config' }], supportedCountries: [{ CA: { isoCode: 'CA', region: 'EU' } }] } : config);
    assert.deepEqual(await auth.countries(), [{ code: 'CA', name: 'Canada' }]);
    const a = await auth.begin('CA'), b = await auth.begin('CA');
    assert.equal(a.region, 'eu'); assert.notEqual(a.state, b.state);
    const url = new URL(a.url);
    assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(a.verifier).digest('base64url'));
    assert.equal(url.searchParams.get('ext-country'), 'CA');
    await assert.rejects(auth.begin('XX'), { code: 'invalid_country' });
  });
  it('retains a non-rotating refresh token and uses the discovered endpoint', async function () {
    let body;
    const auth = createAuth(async (url, opts) => { body = new URLSearchParams(opts.body); return { access_token: 'new', expires_in: 300 }; });
    const refreshed = await auth.refresh({ clientId: 'client', tokenUrl: 'https://carelink-login.minimed.eu/oauth/token', refreshToken: 'old' });
    assert.equal(refreshed.refreshToken, 'old'); assert.equal(body.get('grant_type'), 'refresh_token');
  });
  it('encrypts records using a stable secret, rejects tampering and key changes', function () {
    const make = () => { const enclave = require('../lib/server/enclave')(); enclave.setApiKey('only-a-test-secret-123'); return enclave; };
    const a = make(), b = make();
    const record = a.sealConnector({ refreshToken: 'sensitive', patient: 'private-person' });
    assert.ok(!JSON.stringify(record).includes('sensitive'));
    assert.deepEqual(b.openConnector(record), { refreshToken: 'sensitive', patient: 'private-person' });
    assert.notEqual(a.sealConnector({ refreshToken: 'sensitive' }).iv, record.iv);
    b.setApiKey('different-test-secret'); assert.throws(() => b.openConnector(record));
    record.data = Buffer.from('tampered').toString('base64'); assert.throws(() => a.openConnector(record));
  });
});

describe('native CareLink data mapping', function () {
  const now = Date.parse('2026-09-22T12:00:00Z');
  it('preserves explicit offsets and requires an offset for naive timestamps', function () {
    assert.equal(timestamp('2026-09-22T12:00:00+02:00', '2026-09-22T12:00:00-04:00'), Date.parse('2026-09-22T10:00:00Z'));
    assert.equal(timestamp('2026-09-22T12:00:00', '2026-09-22T12:00:00+02:00'), Date.parse('2026-09-22T10:00:00Z'));
    assert.ok(Number.isNaN(timestamp('2026-09-22T12:00:00')));
  });
  it('filters invalid, future and duplicate readings without mutating the input', function () {
    const payload = { sgs: [{ sg: 123, datetime: new Date(now).toISOString() }, { sg: 124, datetime: new Date(now).toISOString() }, { sg: 0, datetime: new Date(now - 60000).toISOString() }, { sg: 222, datetime: 'invalid' }, { sg: 200, datetime: new Date(now + 3600000).toISOString() }] };
    const before = JSON.stringify(payload), result = transform(payload, 'patient', now);
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].sgv, 123); assert.equal(JSON.stringify(payload), before);
  });
  it('keeps the newest glucose even when lastSG does not match', function () {
    const result = transform({ sgs: [{ sg: 123, datetime: new Date(now).toISOString() }], lastSG: { sg: 111 }, lastSGTrend: 'UP' }, 'patient', now);
    assert.equal(result.entries.length, 1); assert.equal(result.entries[0].direction, undefined);
  });
  it('preserves LOW/HIGH sentinels while ignoring malformed reading/marker items', function () {
    const result = transform({ sgs: [null, { sg: 39, datetime: new Date(now).toISOString() },
      { sg: 401, datetime: new Date(now - 300000).toISOString() }], markers: [null] }, 'patient', now);
    assert.deepEqual(result.entries.map(e => e.sgv), [401, 39]);
    assert.equal(result.treatments.length, 0);
  });
  it('maps trends only onto the latest ordered reading', function () {
    const result = transform({ sgs: [{ sg: 123, datetime: new Date(now).toISOString() }, { sg: 120, datetime: new Date(now - 300000).toISOString() }], lastSG: { sg: 123 }, lastSGTrend: 'UP' }, 'patient', now);
    assert.equal(result.entries[1].direction, 'SingleUp'); assert.equal(result.entries[0].direction, undefined);
  });
  it('never invents insulin for unknown or extended-bolus markers', function () {
    const markers = [{ type: 'UNKNOWN', dateTime: new Date(now).toISOString() }, { type: 'INSULIN', bolusType: 'SQUARE', deliveredFastAmount: 5, dateTime: new Date(now).toISOString() }];
    assert.equal(transform({ markers }, 'patient', now).treatments.length, 0);
  });
  it('pairs a meal with delivered fast insulin without duplicating the dose', function () {
    const dateTime = new Date(now).toISOString();
    const result = transform({ markers: [{ type: 'MEAL', amount: 30, index: 1, dateTime }, { type: 'INSULIN', bolusType: 'FAST', deliveredFastAmount: 2, index: 1, dateTime }] }, 'patient', now);
    assert.equal(result.treatments.length, 1); assert.equal(result.treatments[0].insulin, 2); assert.equal(result.treatments[0].carbs, 30);
  });
  it('uses deterministic patient-scoped identifiers across repeated polls', function () {
    const data = { sgs: [{ sg: 100, datetime: new Date(now).toISOString() }] };
    assert.equal(transform(data, 'a', now).entries[0].identifier, transform(data, 'a', now).entries[0].identifier);
    assert.notEqual(transform(data, 'a', now).entries[0].identifier, transform(data, 'b', now).entries[0].identifier);
  });
});

describe('native CareLink lifecycle', function () {
  let fixtures;
  function make(...args) { const f = setup(...args); fixtures.push(f); return f; }
  beforeEach(() => { fixtures = []; });
  afterEach(async () => { for (const f of fixtures) await f.manager.close(); });
  it('allows only one active login and does not reveal it to another owner', async function () {
    const f = make(); const s = await start(f);
    await assert.rejects(f.manager.start('other', { country: 'GB' }), { code: 'login_in_progress' });
    assert.equal(f.manager.status('other').session, null);
    assert.throws(() => f.manager.own(s.id, 'other'), { code: 'session_not_found' });
  });
  it('requires explicit confirmation before replacing another source', async function () {
    const f = make(null, { conflicts: () => ['dexcomshare'] });
    await assert.rejects(f.manager.start('owner', { country: 'GB' }), { code: 'source_conflict' });
    assert.equal(f.manager.session, null);
  });
  it('consumes the callback once and asks for account confirmation', async function () {
    const f = make(); await loggedIn(f);
    await f.manager.callback(f.manager.session, REDIRECT + '?state=state&code=replay');
    assert.equal(f.exchanges(), 1); assert.equal(f.manager.session.machine.state.value, 'selecting');
    assert.equal(f.saved(), null); assert.equal(f.closed(), 1);
  });
  it('retains the failed token-exchange step without exposing provider secrets', async function () {
    const f = make();
    f.auth.exchange = async () => { throw new ConnectError('provider_unavailable', 502,
      { operation: 'token_exchange', reason: 'http_error', httpStatus: 403, body: 'private-token', url: 'private-url' }); };
    await loggedIn(f);
    const status = f.manager.status('owner');
    assert.equal(status.configured, false); assert.equal(status.session.state, 'failed');
    assert.equal(status.session.phase, 'token_exchange');
    assert.deepEqual(status.session.diagnostic, { operation: 'token_exchange', reason: 'http_error', httpStatus: 403 });
    assert.ok(!JSON.stringify(status).includes('private-'));
    assert.equal(f.saved(), null); assert.equal(f.manager.session.transaction, null);
  });
  it('distinguishes account lookup failure after successful token exchange', async function () {
    const f = make();
    f.client.account = async () => { throw new ConnectError('provider_unavailable', 502,
      { operation: 'account_profile', reason: 'invalid_json', httpStatus: 503 }); };
    await loggedIn(f);
    const status = f.manager.status('owner');
    assert.equal(status.session.phase, 'account_lookup');
    assert.equal(status.session.diagnostic.operation, 'account_profile');
    assert.equal(status.session.state, 'failed'); assert.equal(status.configured, false);
    assert.equal(f.manager.session.candidate, null); assert.equal(f.saved(), null);
  });
  it('persists and activates the importer without environment changes', async function () {
    const f = make(); const s = await loggedIn(f);
    await f.manager.select(s.id, 'owner', 'patient-one');
    assert.equal(f.saved().enabled, true); assert.equal(f.manager.status('owner').connected, true);
    clearTimeout(f.manager.timer); await f.manager.poll();
    assert.equal(f.emitted().length, 1); assert.ok(f.saved().lastSync); assert.ok(f.saved().lastReading);
  });
  it('rejects a patient not returned by CareLink', async function () {
    const f = make(); const s = await loggedIn(f);
    await assert.rejects(f.manager.select(s.id, 'owner', 'another-person'), { code: 'invalid_patient' });
    assert.equal(f.saved(), null);
  });
  it('preserves the old connection if reconnect saving fails', async function () {
    const old = { enabled: true, tokens: { refreshToken: 'old' }, patient: 'old' };
    const f = make(old); await f.manager.init(); const s = await loggedIn(f);
    f.store.save = async () => { throw new Error('private database details'); };
    await assert.rejects(f.manager.select(s.id, 'owner', 'patient-one'));
    assert.deepEqual(f.saved(), old); assert.equal(f.manager.connection.patient, 'old');
    assert.equal(f.manager.session.error, 'storage_unavailable');
  });
  it('ignores a callback after cancellation and clears frames and secrets', async function () {
    const f = make(); const s = await start(f);
    f.events().onFrame('private-frame'); await f.manager.cancel(s.id, 'owner');
    await f.manager.callback(f.manager.session, REDIRECT + '?state=state&code=a');
    assert.equal(f.exchanges(), 0); assert.equal(f.manager.session.frame, null); assert.equal(f.manager.session.transaction, null);
  });
  it('does not install a token exchange that finishes after cancellation', async function () {
    const f = make(); const s = await start(f); let release;
    f.auth.exchange = () => new Promise(resolve => { release = resolve; });
    const pending = f.manager.callback(f.manager.session, REDIRECT + '?state=state&code=a'); await tick();
    await f.manager.cancel(s.id, 'owner'); release({ accessToken: 'late' }); await pending;
    assert.equal(f.manager.session.candidate, null); assert.equal(f.saved(), null);
  });
  it('does not reuse a browser slot until a cancelled startup has been cleaned up', async function () {
    const f = make(); let release;
    f.browser.open = () => new Promise(resolve => { release = resolve; });
    const s = await start(f); await f.manager.cancel(s.id, 'owner');
    await assert.rejects(f.manager.start('other', { country: 'GB' }), { code: 'login_in_progress' });
    release({ close: async () => {} }); await tick();
    assert.equal(f.manager.status('other').busy, false);
  });
  it('persists rotated credentials before fetching or writing data', async function () {
    const f = make({ enabled: true, tokens: { expiresAt: 0 }, patient: 'patient-one' }); await f.manager.init();
    let tokenAtFetch;
    f.client.account = async () => { tokenAtFetch = f.saved().tokens.accessToken; return f.account; };
    await f.manager.poll(); assert.equal(tokenAtFetch, 'rotated');
  });
  it('stops fetching if token rotation could not be saved', async function () {
    const f = make({ enabled: true, tokens: { expiresAt: 0 }, patient: 'patient-one' }); await f.manager.init();
    f.store.save = async () => { throw new Error('db failed'); };
    await f.manager.poll(); assert.equal(f.emitted().length, 0);
  });
  it('distinguishes revoked grants from transient provider failures', async function () {
    const f = make({ enabled: true, tokens: { expiresAt: 0 } }); await f.manager.init();
    f.auth.refresh = async () => { throw new ConnectError('reconnect_required', 401); };
    await f.manager.poll(); assert.equal(f.saved().needsLogin, true); assert.equal(f.manager.status('owner').connected, false);
    const g = make({ enabled: true, tokens: { expiresAt: 0 } }); await g.manager.init();
    g.auth.refresh = async () => { throw new ConnectError('provider_unavailable', 502); };
    await g.manager.poll(); assert.equal(g.saved().needsLogin, undefined); assert.ok(g.manager.timer);
  });
  it('disconnect removes credentials while preserving native source ownership', async function () {
    const f = make({ enabled: true, patient: 'private', tokens: { refreshToken: 'secret' } }); await f.manager.init();
    await f.manager.disconnect(); assert.deepEqual(f.saved(), { enabled: false, replacesLegacy: true });
    await f.manager.poll(); assert.equal(f.emitted().length, 0); assert.equal(f.manager.status('owner').connected, false);
  });
  it('does not report connected when storage cannot be decrypted', async function () {
    const f = make(); f.store.load = async () => { throw new ConnectError('encryption_key_changed'); };
    await f.manager.init(); assert.equal(f.manager.status('owner').connected, false); assert.equal(f.manager.error, 'encryption_key_changed');
  });
  it('fails closed on unknown source ownership instead of starting a legacy importer', async function () {
    const env = { extendedSettings: { connect: { source: 'dexcomshare' } }, enclave: {} };
    const ctx = { bus: new (require('node:events'))(), store: { collection: () => ({ findOne: async () => { throw new Error('database unavailable'); } }) } };
    const manager = await require('../lib/connect')(env, ctx);
    assert.equal(manager.ownsSource(), true);
    assert.deepEqual(manager.status('owner').conflicts, ['dexcomshare']);
    assert.equal(manager.error, 'storage_unavailable');
    let wrote = false;
    const adapter = manager.legacyAdapter(Object.assign(() => {}, { create: () => { wrote = true; } }));
    await adapter.create([], () => {}); assert.equal(wrote, false);
    await manager.close();
  });
});

describe('native CareLink private API', function () {
  let app, f, secret;
  beforeEach(async function () {
    f = setup(); await f.manager.init();
    secret = crypto.createHash('sha1').update('a-test-secret-123').digest('hex');
    const permissions = shiro.new(); permissions.add(['connect:manage']);
    const read = shiro.new(); read.add(['api:*:read']);
    const ctx = { nativeConnect: f.manager, authorization: { checkMultiple: (p, list) => list.some(s => s.check(p)), storage: {
      resolveSubjectAndPermissions: token => token === 'owner-token' ? { subject: { _id: 'a' }, shiros: [permissions] } :
        token === 'other-token' ? { subject: { _id: 'b' }, shiros: [permissions] } : { subject: { _id: 'reader' }, shiros: [read] }
    } } };
    const env = { enclave: { isApiKey: s => s === secret, verifyJWT: s => s === 'test-jwt' ? { accessToken: 'owner-token' } : null } };
    app = express(); app.use('/connect', require('../lib/api/connect')(env, ctx));
  });
  afterEach(async () => f.manager.close());
  it('denies anonymous, cookie-only and query-token requests', async function () {
    await request(app).get('/connect/carelink').expect(401);
    await request(app).get('/connect/carelink').set('Cookie', 'api-secret=' + secret).expect(401);
    await request(app).get('/connect/carelink?secret=' + secret).expect(401);
  });
  it('accepts an administrator or explicit connector-management role', async function () {
    await request(app).get('/connect/carelink').set('api-secret', secret).expect(200).expect('Cache-Control', /no-store/);
    await request(app).get('/connect/carelink').set('Authorization', 'Bearer test-jwt').expect(200);
    await request(app).get('/connect/carelink').set('api-secret', 'read-token').expect(403);
  });
  it('rejects a cross-origin attempt even with credentials', async function () {
    await request(app).post('/connect/carelink/sessions').set('api-secret', secret).set('Origin', 'https://evil.test').send({ country: 'GB' }).expect(403);
  });
  it('binds frames and input to their authenticated owner', async function () {
    const result = await request(app).post('/connect/carelink/sessions').set('api-secret', 'owner-token').send({ country: 'GB' }).expect(201);
    await tick();
    const id = result.body.id;
    await request(app).get('/connect/carelink/sessions/' + id + '/frame').set('api-secret', 'other-token').expect(404);
    await request(app).post('/connect/carelink/sessions/' + id + '/input').set('api-secret', 'other-token').send({ type: 'text', text: 'a' }).expect(404);
    f.events().onFrame('test-frame');
    const frame = await request(app).get('/connect/carelink/sessions/' + id + '/frame').set('api-secret', 'owner-token').expect(200);
    assert.equal(frame.body.image, 'test-frame');
  });
  it('does not serialize tokens or provider details in status/errors', async function () {
    f.manager.connection = { enabled: true, tokens: { refreshToken: 'top-secret' } };
    const result = await request(app).get('/connect/carelink').set('api-secret', secret).expect(200);
    assert.ok(!JSON.stringify(result.body).includes('top-secret'));
    f.manager.auth.countries = async () => { throw new Error('provider response including a credential'); };
    const failure = await request(app).get('/connect/carelink/countries').set('api-secret', secret).expect(500);
    assert.deepEqual(failure.body, { error: 'connection_failed' });
  });
});
