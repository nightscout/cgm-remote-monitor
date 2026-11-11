'use strict';

// Source/protocol checks only. No listener, network, PG or Vault is started.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const scope = require('../lib/storage/tenant-scope');
const authorityFactory = require('../lib/server/realtime/authority');
const protocolFactory = require('../lib/server/realtime/protocol');
const runtimeFactory = require('../lib/server/realtime/runtime');
const admissionFactory = require('../lib/server/realtime/admission');
const ipc = require('../lib/server/internal-api/transport');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const current = tenant => ({ tenant, identity: 'same-effective-config', env: require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } }) });
class Socket extends EventEmitter {
  constructor (host) { super(); this.request = { headers: { host }, rawHeaders: ['Host', host], socket: {} }; this.sent = []; this.rooms = new Set(['self']); this.id = 'self'; }
  emit (event, value) { this.sent.push({ event, value }); return true; }
  async receive (event, ...args) { return Promise.all(this.listeners(event).map(fn => fn(...args))); }
  join (name) { this.rooms.add(name); }
  leave (name) { this.rooms.delete(name); }
  disconnect () { this.disconnected = true; super.emit('disconnect'); }
}
async function fixture () {
  const state = { allowed: true, config: true, unavailable: false, rows: [{ domain: 'entries', document: { _id: 'old', sgv: 250 } }], writes: [] };
  const lookup = host => host === 'a.test' ? A : host === 'b.test' ? B : null;
  const admission = { resolve: async req => { const t = lookup(req.headers.host); if (!t) throw new Error('UNKNOWN'); return t; } };
  let runtime;
  const readCurrent = async tenant => state.config ? current(tenant) : null;
  const api = {
    async executeSocketMutation (body) {
      if (state.unavailable) throw new Error('UNAVAILABLE');
      state.writes.push(body); return { replyArgs: [{ result: 'success' }] };
    },
    async authorizeSocket (body) {
    if (state.unavailable) throw new Error('UNAVAILABLE');
    if (state.deniedCredential && state.deniedCredential === body.credential?.secret) return { denied: true };
    const read = state.allowed && Object.keys(body.credential).length > 0;
    if (state.holdAuthority) { const held = state.holdAuthority; state.holdAuthority = null; held.entered.resolve(); await held.release.promise; }
    return { permissions: { read, write: read, write_treatment: read, ack: read }, collections: read ? ['entries', 'treatments'] : [] };
  } };
  const protocol = protocolFactory.create({ admission, api, readCurrent, runtime: () => runtime, maxSockets: 10, domains: ['entries', 'treatments'] });
  const schedule = {};
  runtime = await runtimeFactory({ tenants: [A, B], readCurrent,
    create: selected => ({ acquire: async () => ({ tenant: selected.tenant, checkpoint: 0, rows: structuredClone(state.rows),
      frame: { delta: false, lastUpdated: 1000, sgvs: state.rows.filter(row => row.domain === 'entries').map(row => ({ _id: row.document._id, mgdl: row.document.sgv, mills: 1000 })) } }) }),
    fanout: protocol.fanout, recoveryIntervalMs: 100,
    schedule: callback => { schedule.callback = callback; return 1; }, cancel: () => { schedule.closed = true; } });
  return { A, B, state, runtime, protocol, schedule,
    async socket (host = 'a.test', namespace = '/') { const socket = new Socket(host); await protocol.prepare(socket); protocol.bind(socket, namespace); return socket; },
    async close () { protocol.close(); await runtime.close(); } };
}
describe('explicit realtime preview source contracts', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  it('requires bounded explicit config and uses shared PG/environment validation without enabling a default', function () {
    const parse = require('../lib/server/realtime/config').parse;
    const value = { version: 1, postgres: { connectionEnv: 'RT_DB', namespaces: Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(k => [k, 'rt_' + k])) },
      consumer: 'realtime-test', pageSize: 1, maxRows: 10, maxBytes: 10000, maxTenants: 2, recoveryIntervalMs: 100,
      tenants: [{ id: A, revision: 'v1', settings: { enable: ['bgnow'] } }], admissionFileEnv: 'RT_ADMISSION',
      maxMessageBytes: 10000, operationTimeoutMs: 1000, maxSockets: 10 };
    const source = { RT_DB: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test', RT_ADMISSION: '/tmp/admission.json', NS_API_INTERNAL_SOCKET: '/tmp/a.sock' };
    const selected = parse(value, source);
    assert.equal(selected.consumer, 'realtime-test'); assert.equal(selected.tenants.get(A).tenant, A);
    assert.deepEqual(selected.api, { socketPath: '/tmp/a.sock', maxBytes: 10000, timeoutMs: 1000 }, 'api peer address from NS_API_INTERNAL_SOCKET');
    assert.equal(Object.hasOwn(selected, 'alarms'), false, 'alarm delivery is served on serve.internal, not configured per contract');
    for (const retired of [{ apiSocketPathEnv: 'API_SOCKET' }, { alarmSocketPathEnv: 'RT_SOCKET' }, { apiEndpoint: { urlEnv: 'API', trust: 'network' } }]) {
      assert.throws(() => parse({ ...value, ...retired }, source), /REFUSED/, 'per-contract endpoint keys are retired');
    }
    for (const mutate of [v => { v.consumer = 'evaluator-shared'; }, v => { v.maxSockets = 0; }, v => { v.maxBytes = undefined; }, v => { v.postgres.namespaces.entries = 'public'; }]) {
      const bad = structuredClone(value); mutate(bad); assert.throws(() => parse(bad, source));
    }
    assert.throws(() => require('../lib/server/realtime/config').load({}), /REFUSED|configuration/);
  });
  it('fresh preview admission covers all credentials and rejects unknown/path/header selectors without D15 claims', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-admission-')), file = path.join(dir, 'allow.json');
    const doc = { version: 1, mode: 'preview-socket-allowlist', tenants: [{ id: A, aliases: ['a.test'], enabled: true }] };
    try {
      fs.writeFileSync(file, JSON.stringify(doc)); const admission = admissionFactory.load({ file, maxTenants: 2 });
      assert.equal(await admission.resolveHost('a.test'), A);
      await assert.rejects(admission.resolve({ rawHeaders: ['Host','b.test'], url: '/a/socket.io', socket: {} }));
      await assert.rejects(admission.resolve({ rawHeaders: ['Host','a.test','X-Resolved-Tenant',A], socket: {} }));
      doc.tenants[0].enabled = false; fs.writeFileSync(file, JSON.stringify(doc));
      assert.equal(await admission.allows(A), false, 'RT_CURRENT_ADMISSION no retained tenant enablement');
      await assert.rejects(admission.resolveHost('a.test'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('requires same origin for browsers and allows native absent Origin without trusting engine path', function () {
    assert.equal(protocolFactory.origin({ headers: { host: 'a.test:123' }, socket: {} }), true);
    assert.equal(protocolFactory.origin({ headers: { host: 'a.test:123', origin: 'http://a.test:123' }, socket: {} }), true);
    assert.equal(protocolFactory.origin({ headers: { host: 'a.test:123', origin: 'http://b.test:123' }, socket: {} }), false);
    assert.equal(protocolFactory.origin({ headers: { host: 'a.test', origin: 'https://a.test' }, socket: {} }), false);
  });
  it('keeps current root/opaque/JWT/carriers scoped and never promotes storage accessToken into root', async function () {
    let allowed = true, enabled = true; const inputs = [];
    const auth = authorityFactory.create({ admission: { allows: async () => enabled }, verifierContext: tenant => ({ tenant }),
      secrets: { async verifyLegacyCredential (ctx, values) { inputs.push(values); if (values.apiSecret === 'root-' + ctx.tenant) return { kind: 'root' };
        if (values.apiSecret === 'subject' || values.token === 'jwt') return { kind: 'subject', subjectId: 'one' }; return values.apiSecret === undefined && values.token === undefined ? { kind: 'anonymous' } : null; } },
      authority: { authorize: async ({ principal }) => principal.kind === 'root',
        subjectSnapshot: async () => allowed ? { permissionGroups: [['api:*:read','api:*:create,update,delete','notifications:*:ack']] } : null } });
    const root = await auth.verify({ tenant: A, namespace: '/', credential: { secret: 'root-' + A } });
    assert.equal(root.permissions.write, true);
    await assert.rejects(auth.verify({ tenant: B, namespace: '/', credential: { secret: 'root-' + A } }));
    assert.equal((await auth.verify({ tenant: A, namespace: '/', credential: { token: 'jwt' } })).permissions.read, true);
    assert.equal((await auth.verify({ tenant: A, namespace: '/storage', credential: { accessToken: 'subject' } })).collections.length, 6);
    await assert.rejects(auth.verify({ tenant: A, namespace: '/storage', credential: { accessToken: 'root-' + A } }));
    allowed = false; await assert.rejects(auth.verify({ tenant: A, namespace: '/', credential: { secret: 'subject' } }), /REFUSED/, 'RT_CURRENT_CREDENTIAL current grant removal');
    enabled = false; await assert.rejects(auth.verify({ tenant: A, namespace: '/', credential: { secret: 'root-' + A } }));
    assert.ok(inputs.some(input => input.token === 'jwt'));
  });
  it('uses actual asymmetric token verification/current state without any legacy provider call', async function () {
    const crypto = require('node:crypto'), access = require('../lib/tenant-authorization/access-token');
    const key = crypto.generateKeyPairSync('ed25519'), time = Math.floor(Date.now() / 1000); let active = true, snapshots = 0;
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'key1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: 'synthetic', aud: 'data', tid: A, purpose: 'data', sub: 'subject', sid: 'session', cv: 1,
      iat: time, nbf: time, exp: time + 1000 })).toString('base64url');
    const input = header + '.' + payload, token = input + '.' + crypto.sign(null, Buffer.from(input), key.privateKey).toString('base64url');
    const auth = authorityFactory.create({ admission: { allows: async () => true }, verifierContext: tenant => ({ tenant }),
      secrets: { verifyLegacyCredential: async () => assert.fail('current token must not require Vault/decrypt') },
      authority: { subjectSnapshot: async () => assert.fail('token uses one current access snapshot'), authorize: async () => false },
      accessTokens: { authenticate: access.createAuthentication({ verifyToken: access.createVerifier({ issuer: 'synthetic', audience: 'data', purpose: 'data', maxLifetimeSeconds: 28800,
        resolveKey: tenant => tenant === A ? { tenant: A, kid: 'key1', issuer: 'synthetic', purpose: 'data', publicKey: key.publicKey } : null }),
      snapshot: async () => { snapshots++; return { active, sessionActive: true, keyActive: true, credentialVersion: 1, sessionExpiresAt: time + 2000,
        allows: permission => permission.endsWith(':read') || permission === 'notifications:*:ack' }; } }) } });
    for (const [namespace, credential] of [['/', { token }], ['/storage', { accessToken: token }], ['/alarm', { jwtToken: token }]]) {
      assert.equal((await auth.verify({ tenant: A, namespace, credential })).permissions.read, true);
    }
    assert.equal(snapshots, 3, 'RT_LOCAL_CURRENT_STATE one fresh authority snapshot per operation');
    await assert.rejects(auth.verify({ tenant: B, namespace: '/', credential: { token } }), /TOKEN_KEY/);
    active = false; await assert.rejects(auth.verify({ tenant: A, namespace: '/', credential: { token } }), /AUTHORITY_FORBIDDEN/);
  });
  it('disconnects restored A sockets and discards A projection while retaining B sockets/output', async function () {
    const f = await fixture();
    try {
      const a=await f.socket(), b=await f.socket('b.test');
      await a.receive('authorize',{secret:'synthetic'}); await b.receive('authorize',{secret:'synthetic'});
      const bOutput=f.runtime.last(B);
      f.protocol.invalidateTenant(A); await f.runtime.invalidateTenant(A);
      assert.equal(a.disconnected,true); assert.notEqual(b.disconnected,true);
      assert.equal(f.runtime.last(A),null); assert.equal(f.runtime.last(B),bOutput);
      f.state.rows=[]; await f.runtime.refresh(A);
      assert.deepEqual(f.runtime.last(A).frame.sgvs,[]); assert.equal(f.runtime.last(B),bOutput);
      const before=b.sent.length; await f.runtime.refresh(B);
      assert.ok(b.sent.length>before); assert.notEqual(b.disconnected,true);
    } finally { await f.close(); }
  });
  it('full replacement reaches browser consumer and tenant-local current fanout stops after revocation', async function () {
    const f = await fixture();
    try {
      const a = await f.socket(), b = await f.socket('b.test');
      await a.receive('authorize', { secret: 'synthetic' }); await b.receive('authorize', { secret: 'synthetic' });
      a.sent.length = 0; b.sent.length = 0;
      f.state.rows = []; await f.runtime.refresh(A);
      const update = a.sent.find(x => x.event === 'dataUpdate');
      assert.ok(update, 'RT_BACKSTOP_CONSUMED quiet absence yields current frame');
      assert.equal(update.value.delta, false, 'RT_FULL_RESET deletion cannot be an SGV-only merge');
      assert.deepEqual(update.value.sgvs, []);
      const browser = { ...Object.fromEntries(Object.entries(update.value).filter(([, value]) => Array.isArray(value)).map(([key]) => [key, []])),
      sgvs: [{ mills: Date.now(), mgdl: 250 }], processTreatments () {} };
      require('../lib/client/receiveddata')(update.value, browser, { extendedSettings: {} });
      assert.deepEqual(browser.sgvs, [], 'RT_BROWSER_ABSENCE actual receiveddata discards physically removed SGV');
      assert.equal(b.sent.some(x => x.event === 'dataUpdate'), false, 'RT_TENANT_FANOUT foreign socket receives nothing');
      // Publish on change: revocation is found by the authorization recheck
      // (periodic, expiry or event), not by re-authorizing every frame.
      f.state.allowed = false; a.sent.length = 0; await f.protocol.recheckTenant(A);
      f.state.rows = [{ domain: 'entries', document: { _id: 'new', sgv: 120 } }]; await f.runtime.refresh(A);
      assert.equal(a.sent.some(x => x.event === 'dataUpdate'), false, 'RT_CURRENT_DELIVERY revoked socket no data');
      assert.equal(a.disconnected, true);
    } finally { await f.close(); }
  });
  it('forwards original socket credential/main and alarm ack and relays actual replies or noack on outage', async function () {
    const f = await fixture();
    try {
      const a = await f.socket(); await a.receive('authorize', { secret: 'original' }); let replies = 0;
      await a.receive('dbAdd', { collection: 'treatments', data: {} }, reply => { replies++; assert.deepEqual(reply, { result: 'success' }); });
      assert.equal(f.state.writes[0].envelope.credential.secret, 'original');
      assert.equal(f.state.writes[0].envelope.tenant, A);
      await a.receive('ack', 2, 'default', 60000);
      assert.equal(f.state.writes.at(-1).envelope.namespace, '/');
      f.state.unavailable = true;
      await a.receive('dbAdd', { collection: 'treatments', data: {} }, () => { replies++; });
      assert.equal(replies, 1, 'RT_API_OUTAGE_NOACK failed private forward never synthesizes reply');
    } finally { await f.close(); }
  });
  it('builds an actual recovered empty frame that clears the existing browser SGV consumer', async function () {
    const connection = { snapshotTransaction: async fn => fn(), async query (text) {
      if (text.startsWith('SELECT checkpoint')) return { rows: [{ checkpoint: '0', contract_digest: '', projection: null }] };
      if (text.startsWith('SELECT last_stamp')) return { rows: [{ last_stamp: '0' }] };
      if (text.startsWith('SELECT count(*)')) return { rows: [{ row_count: '0', document_bytes: '0' }] };
      if (text.startsWith('UPDATE')) return { rowCount: 1, rows: [] };
      if (text.startsWith('SELECT COALESCE(sum(pg_column_size')) return { rows: [{ bytes: 0 }] };
      return { rows: [] };
    } };
    const config = { namespaces: Object.fromEntries(['entries','treatments','devicestatus','profile','food','activity','clock','checkpoint'].map(k => [k, 'rt_' + k])),
      consumer: 'realtime-source', pageSize: 3, maxRows: 100, maxBytes: 100000 };
    const acquired = await require('../lib/server/realtime/projection')({ config, connection, current: current(A) }).acquire({ at: 10000000 });
    const browser = { ...Object.fromEntries(Object.entries(acquired.frame).filter(([, value]) => Array.isArray(value)).map(([key]) => [key, []])),
      sgvs: [{ mills: Date.now(), mgdl: 250 }], processTreatments () {} };
    require('../lib/client/receiveddata')(acquired.frame, browser, { extendedSettings: {} });
    assert.deepEqual(browser.sgvs, [], 'RT_ACTUAL_BROWSER_ABSENCE no SGV is retained by actual browser merge');
    assert.equal(acquired.frame.delta, false, 'RT_ACTUAL_FULL_RESET source acquisition sets a full snapshot');
  });
  it('uses the explicit recovery backstop with no wake and contains a failed tenant', async function () {
    const f = await fixture();
    try {
      const a = await f.socket(); await a.receive('authorize', { secret: 'synthetic' }); a.sent.length = 0;
      f.state.rows = []; await f.schedule.callback();
      assert.ok(a.sent.some(row => row.event === 'dataUpdate' && row.value.sgvs.length === 0), 'RT_QUIET_BACKSTOP no wake still repairs current absence');
    } finally { await f.close(); }
    let failA = false, b = 0;
    const rt = await runtimeFactory({ tenants: [A, B], recoveryIntervalMs: 10, readCurrent: async t => current(t),
      create: selected => ({ acquire: async () => { if (selected.tenant === A && failA) throw new Error('ROW_BOUND'); return { tenant: selected.tenant, rows: [], frame: {} }; } }),
      fanout: async ({ tenant }) => { if (tenant === B) b++; }, schedule: () => 1, cancel: () => {} });
    const before = b; failA = true;
    const failures = await Promise.allSettled([rt.refresh(A), rt.refresh(B)]);
    assert.equal(failures[0].status, 'rejected'); assert.equal(failures[1].status, 'fulfilled');
    assert.equal(b, before + 1, 'RT_TENANT_FAILURE B progresses despite A bound failure');
    assert.equal(rt.last(A), null); await rt.close();
  });
  it('wires the actual private receiver to canonical source and durable alarm while refusing forged host or transport', async function () {
    const f = require('./fixtures/tenant-alarm-protocol')();
    const token = Symbol(), calls = [];
    const rights = { read: true, write: true, write_treatment: true, ack: true };
    const auth = { verify: async op => ({ tenant: op.tenant, permissions: rights, collections: ['entries'] }),
      authorizeWrite: async op => op.credential.secret === 'client' ? { tenant: op.tenant, principal: { kind: 'root' }, permissions: rights } : null };
    const db = { ...f.db, query: (text, values) => text.startsWith('SELECT c.anonymous_roles')
      ? Promise.resolve({ rows: [{ anonymous_roles: ['denied'], subject_id: null, role_name: null }] }) : f.db.query(text, values) };
    const ops = require('../lib/server/realtime/private-api').operations({ token, alarmConnection: db, authority: auth,
      admission: { resolveHost: async host => host === 'a.test' ? A : B, allows: async () => true },
      config: { bindings: new Map([[A, true], [B, true]]), aliases: [{ host: 'a.test', tenant: A }, { host: 'b.test', tenant: B }],
        socketForwarding: { alarm: { namespace: 'alarm_protocol' } }, namespaces: { authorization: 'authority_test' } },
      executeWrite: async op => { calls.push(op); return [{ result: 'success' }]; } });
    const envelope = { tenant: A, namespace: '/', event: 'dbAdd', credential: { secret: 'client' }, args: [{ collection: 'entries', data: {} }] };
    const result = await ops.executeSocketMutation({ transport: token }, { host: 'a.test', envelope });
    assert.deepEqual(result.replyArgs, [{ result: 'success' }]); assert.equal(calls[0].source, 'socket');
    await assert.rejects(ops.executeSocketMutation({ transport: Symbol() }, { host: 'a.test', envelope }), /REFUSED/);
    await assert.rejects(ops.executeSocketMutation({ transport: token }, { host: 'b.test', envelope }), /TENANT_REFUSED/);
    await ops.executeSocketMutation({ transport: token }, { host: 'a.test', envelope: { ...envelope, event: 'ack', args: [2, 'default', 1000] } });
    assert.equal(f.rows().length, 2, 'RT_DURABLE_ACK actual composed receiver persists both suppression levels');
    assert.equal(calls.length, 1, 'alarm does not pass through clinical write executor');
  });
  it('uses the actual alarm sink adapter contract and current per-socket rights without external delivery claims', async function () {
    const f = await fixture();
    try {
      const socket = await f.socket('a.test', '/alarm'); await socket.receive('subscribe', { secret: 'client' });
      const notification = { level: 2, group: 'default', title: 'Synthetic', message: 'Synthetic details' };
      const token = Symbol();
      const ops = require('../lib/server/realtime/alarm-transport').operations({ token, deliver: f.protocol.alarm });
      const id = '33333333-3333-4333-8333-333333333333';
      const body = { tenant: A, id, attempt: 1, notification, receipts: [] };
      const accepted = await ops.deliverAlarm({ transport: token }, body);
      assert.equal(accepted.accepted, true); assert.equal(accepted.receipt, null);
      assert.deepEqual(socket.sent.find(item => item.event === 'urgent_alarm').value, notification);
      const clear = await ops.deliverAlarm({ transport: token }, { ...body, notification: { clear: true },
        receipts: [{ request_id: id, receipt: { kind: 'legacy-realtime', id } }, { request_id: B, receipt: { kind: 'other', id: B } }] });
      assert.deepEqual(clear.clearedRequestIds, [], 'RT_NO_PROVIDER_RECEIPT socket clear never manufactures provider cancellation');
      f.state.allowed = false; socket.sent.length = 0;
      await ops.deliverAlarm({ transport: token }, body);
      assert.equal(socket.sent.length, 0, 'RT_ALARM_CURRENT_AUTHORITY revocation stops protected alarm delivery');
    } finally { await f.close(); }
  });
  it('isolates refused alarm subscribers while preserving API outage failure', async function () {
    const f = await fixture();
    try {
      const bad = await f.socket('a.test', '/alarm'), good = await f.socket('a.test', '/alarm');
      await bad.receive('subscribe', { secret: 'rotated' }); await good.receive('subscribe', { secret: 'valid' });
      f.state.deniedCredential = 'rotated';
      await f.protocol.alarm({ tenant: A, notification: { level: 2 } });
      assert.equal(bad.sent.some(row => row.event === 'urgent_alarm'), false);
      assert.equal(bad.disconnected, true, 'RT_BAD_ALARM_SOCKET refused credential is retired');
      assert.equal(good.sent.some(row => row.event === 'urgent_alarm'), true, 'RT_GOOD_ALARM_SOCKET later valid recipient is not blocked');
      f.state.unavailable = true;
      await assert.rejects(f.protocol.alarm({ tenant: A, notification: { level: 2 } }), /UNAVAILABLE/, 'RT_ALARM_OUTAGE transport outage never becomes successful handoff');
    } finally { await f.close(); }
  });
  for (const mgdl of [190, 300]) it('preserves actual treatmentnotify alarm precedence for announcement at ' + mgdl, async function () {
    const levels = require('../lib/levels'), notifications = [];
    const ctx = { levels };
    require('../lib/plugins/treatmentnotify')(ctx).checkNotifications({ levels, data: { mbgs: [], treatments: [{ eventType: 'Announcement', notes: 'Synthetic', mgdl, mills: Date.now(), isAnnouncement: true }] },
      extendedSettings: {}, language: { translate: value => value }, lastEntry: rows => rows.at(-1), scaleMgdl: value => value,
      settings: { alarmUrgentHigh: true, alarmHigh: true, thresholds: { bgHigh: 260, bgTargetTop: 180 } },
      notifications: { requestNotify: value => notifications.push(value) } });
    assert.equal(notifications.length, 1); const notification = notifications[0]; assert.equal(notification.isAnnouncement, true);
    const baseline = []; const single = new (require('../lib/api3/alarmSocket'))({}, {}, ctx);
    single.namespace = { to: () => ({ emit: (event, value) => baseline.push({ event, value }) }) }; single.emitNotification(notification);
    const f = await fixture();
    try {
      const socket = await f.socket('a.test', '/alarm'); await socket.receive('subscribe', { secret: 'synthetic' });
      await f.protocol.alarm({ tenant: A, notification });
      assert.deepEqual(socket.sent.find(row => ['announcement', 'alarm', 'urgent_alarm'].includes(row.event)), baseline[0], 'RT_ALARM_PRECEDENCE actual producer and actual single event match');
    } finally { await f.close(); }
  });
  for (const namespace of ['/', '/alarm', 'retro']) it('fences old delivery when socket credential epoch changes in ' + namespace, async function () {
    const f = await fixture();
    try {
      const socket = await f.socket('a.test', namespace === 'retro' ? '/' : namespace);
      await socket.receive(namespace !== '/alarm' ? 'authorize' : 'subscribe', { secret: 'old-allowed' }); socket.sent.length = 0;
      const held = { entered: deferred(), release: deferred() }; f.state.holdAuthority = held;
      const pending = namespace === 'retro' ? socket.receive('loadRetro', {}, () => {}) : namespace === '/' ? f.protocol.recheckTenant(A) : f.protocol.alarm({ tenant: A, notification: { level: 2, message: 'protected' } });
      await held.entered.promise; f.state.allowed = false;
      await socket.receive(namespace !== '/alarm' ? 'authorize' : 'subscribe', { secret: 'new-denied' });
      held.release.resolve(); await Promise.allSettled([pending]);
      assert.equal(socket.sent.some(row => ['dataUpdate', 'urgent_alarm', 'retroUpdate'].includes(row.event)), false, 'RT_SOCKET_EPOCH old authority cannot deliver after reauthorization');
    } finally { await f.close(); }
  });
  it('matches actual single storage subscribe without inventing offline cursor or replay', async function () {
    const single = new (require('../lib/api3/storageSocket'))({ get: () => ['entries', 'treatments'] }, {}, {
      authorization: { resolveAccessToken: (token, cb) => cb(null, { shiros: [] }), checkMultiple: () => true } });
    const old = new Socket('a.test'); let oldReply;
    single.subscribe(old, { accessToken: 'synthetic', collections: ['entries'] }, value => { oldReply = value; });
    assert.deepEqual(oldReply, { success: true, collections: ['entries'] });
    assert.deepEqual(old.sent, [], 'RT_STORAGE_BASELINE no subscribe data replay or reset exists');
    const f = await fixture();
    try {
      const now = await f.socket('a.test', '/storage'); let reply;
      await now.receive('subscribe', { accessToken: 'synthetic', collections: ['entries'] }, value => { reply = value; });
      assert.deepEqual(reply, oldReply);
      assert.deepEqual(now.sent, [], 'RT_STORAGE_BASELINE matching subscribe does not invent reset/replay');
      f.state.rows = []; await f.schedule.callback();
      assert.equal(now.sent.filter(row => row.event === 'delete').length, 1, 'RT_STORAGE_CONNECTED_LOSS connected absence still emits delete');
    } finally { await f.close(); }
  });
  it('classifies normalized typed twin ambiguity against actual single normalization and broadcaster', function () {
    const normalize = require('../lib/api3/storage/mongoCollection/utils').normalizeDoc;
    const { ObjectId } = require('mongodb'), id = '0123456789abcdef01234567';
    const first = { _id: new ObjectId(id) }, second = { _id: id }; normalize(first); normalize(second);
    assert.deepEqual(first, second, 'RT_TYPED_WIRE_BASELINE actual normalization collapses the wire identifiers');
    const single = new (require('../lib/api3/storageSocket'))({}, {}, {}); const sent = [];
    single.namespace = { to: collection => ({ emit: (event, value) => sent.push({ collection, event, value }) }) };
    single.emitDelete({ colName: 'entries', identifier: first.identifier });
    const changes = protocolFactory.storageChanges([{ domain: 'entries', document: { _id: new ObjectId(id) } }], []);
    assert.deepEqual(changes[0].value, sent[0].value, 'RT_TYPED_WIRE_BASELINE actual single broadcaster has the same delete wire');
  });
  it('storage changes use existing normalized wire shapes and include connected typed identity absence', function () {
    const { ObjectId } = require('mongodb'); const id = '0123456789abcdef01234567';
    const rows = [{ domain: 'entries', document: { _id: new ObjectId(id), sgv: 111 } }, { domain: 'entries', document: { _id: id, sgv: 222 } }];
    const changes = protocolFactory.storageChanges(rows, rows.slice(1));
    assert.deepEqual(changes, [{ event: 'delete', domain: 'entries', value: { colName: 'entries', identifier: id } }]);
    assert.notEqual(protocolFactory.room(A, '/storage', 'entries'), protocolFactory.room(B, '/storage', 'entries'));
  });
  it('separates recovery scheduling from writes and fences late acquisition after close/config change', async function () {
    let timer, count = 0; const held = deferred(); let block = false, enabled = true;
    const runtime = await runtimeFactory({ tenants: [A], recoveryIntervalMs: 10, readCurrent: async tenant => enabled ? current(tenant) : null,
      create: () => ({ acquire: async () => { count++; if (block) await held.promise; return { tenant: A, rows: [], frame: { sgvs: [] } }; } }),
      fanout: async () => {}, schedule: callback => { timer = callback; return 1; }, cancel: () => {} });
    block = true; const pending = runtime.refresh(A); await Promise.resolve(); await Promise.resolve();
    const closing = runtime.close(); held.resolve(); await assert.rejects(pending, /CHANGED/); await closing;
    assert.equal(runtime.last(A), null, 'RT_CLOSE_FENCE no late result');
    assert.equal(typeof timer, 'function'); assert.ok(count >= 1);
    enabled = false;
  });
  it('private handler uses fixed owned operations and bounded bodies without network listeners', async function () {
    const syntheticService = require('./fixtures/internal-api-contract').service;
    const token = Symbol(), called = []; const handler = ipc.handler({ token, maxBytes: 100, timeoutMs: 1000, admitted: req => req.owned === true,
      service: syntheticService, operations: { echo: async (ctx, value) => { assert.equal(ctx.transport, token); called.push(value); return { allowed: true }; } } });
    async function run (body, url = '/authorize', owned = true) {
      const req = Readable.from([Buffer.from(body)]); Object.assign(req, { owned, method: 'POST', url, headers: require('./fixtures/internal-api-contract').headers(syntheticService) });
      const res = new EventEmitter();
      res.writeHead = function (code) { this.code=code; this.headersSent=true; };
      res.end = function (bytes) { this.bytes=String(bytes); this.emit('finish'); };
      res.destroy = function () { this.destroyed=true; this.emit('close'); };
      await handler(req, res); return res;
    }
    assert.equal((await run('{"a":1}')).code, 200);
    assert.equal((await run('{"a":1}', '/api/v1/entries')).code, 503);
    assert.equal((await run('{"a":1}', '/authorize', false)).code, 503);
    assert.equal((await run('"' + 'x'.repeat(101) + '"')).code, 503);
    assert.equal(called.length, 1, 'RT_PRIVATE_CAPABILITY untrusted/public/unbounded request never enters API');
  });
  it('refuses unsafe IPC directories and pre-existing paths without starting a server', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-ipc-'));
    try {
      ipc.directory(path.join(dir, 'api.sock'));
      fs.chmodSync(dir, 0o777); assert.throws(() => ipc.directory(path.join(dir, 'api.sock')), /DIRECTORY/);
      assert.throws(() => ipc.options({ socketPath: '/tmp/a', maxBytes: 1, timeoutMs: 0 }), /CONFIG/);
    } finally { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
