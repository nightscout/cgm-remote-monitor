'use strict';

// Registry mode for realtime, the api's socket forwarding, tenant removal on the
// admin REST API and the static-tenants lab gate, without a database. The
// PostgreSQL halves are tests/tenant-registry-provision.integration.test.js
// (PV_REMOVE, PV_SETTINGS). Synthetic tenants and hosts only.
// covers: lib/server/realtime/config.js, lib/server/realtime/registry-admission.js, lib/server/realtime/private-api.js, lib/server/realtime/private-config.js, lib/tenant-registry/rest.js, lib/cli/commands/admin.js, lib/server/serve/static-tenants.js
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');

const A = randomUUID(), B = randomUUID();
const SOURCE = { RT_DB: 'postgres://synthetic:synthetic@127.0.0.1/disposable_test', RT_ADMISSION: '/tmp/admission.json', NS_API_INTERNAL_SOCKET: '/tmp/a.sock', RT_SETTINGS_DB: 'postgres://settings:synthetic@127.0.0.1/disposable_test' };
const realtimeConfig=extra=>require('./fixtures/realtime-completed-config')({registry:{namespace:'rr_registry',refreshMs:500},...extra}).value;
const request = host => ({ rawHeaders: ['Host', host], socket: {} });
// A registry resolver double: hosts map to tenants; the registry decides activity.
const resolverOf = hosts => ({ resolve: async req => { const host = req.rawHeaders[1]; if (!hosts.has(host)) throw Object.assign(new Error('TENANT_HOST_UNKNOWN'), { code: 'TENANT_HOST_UNKNOWN' }); return hosts.get(host); } });

describe('registry mode: realtime, socket forwarding, removal and the static lab gate', function () {
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));

  function readerRuntime (mutate = value => value, failLookup = false) {
    const fs = require('node:fs'), vm = require('node:vm');
    const filename = require.resolve('../lib/server/serve/preview-realtime');
    const original = require('node:module').createRequire(filename), output = { exports: {} };
    const counts = { opened: 0, registryClosed: 0, lookupClosed: 0, resolverClosed: 0, displayClosed: 0, reads: 0 };
    const registrySet = { tenants: new Map([[A, { tenant: A }]]), isActive: tenant => tenant === A,
      close: async () => { counts.registryClosed++; } };
    const dependencies = {
      './registry-tenant-set': { open: async () => { counts.opened++; return registrySet; } },
      './evaluator-config': { registryEntry: tenant => ({ tenant }), applySettings: (base, settings) => ({ ...base, settings }) },
      '../../storage/postgres-connection': async () => { if (failLookup) throw new Error('synthetic lookup refusal'); return { end: async () => { counts.lookupClosed++; } }; },
      '../../tenant-registry/postgres': { create: () => ({}) },
      '../../tenant-registry/resolver': { createRegistryResolver: () => ({ start: async () => {}, close: () => { counts.resolverClosed++; } }) },
      '../realtime/registry-admission': { create: () => ({}) }
    };
    vm.runInThisContext('(function(require,module,exports){' + mutate(fs.readFileSync(filename, 'utf8')) + '\n})', { filename })(
      id => Object.hasOwn(dependencies, id) ? dependencies[id] : original(id), output, output.exports);
    const display = { read: async () => ({ version: ++counts.reads }), close: async () => { counts.displayClosed++; } };
    return { counts, display, open: provider => output.exports.registryMode({ registry: {}, maxTenants: 10 }, provider) };
  }

  async function refusedReader (provider, mutate) {
    const fixture = readerRuntime(mutate);
    await assert.rejects(fixture.open(provider), { name: 'TypeError', message: 'Explicit committed realtime presentation reader required' });
    assert.equal(fixture.counts.opened, 0, 'invalid presentation reader must acquire no registry resource');
    assert.equal(fixture.counts.registryClosed, 0);
  }

  it('RR_READER_REFUSAL: missing or invalid committed readers refuse before any registry acquisition', async function () {
    for (const provider of [undefined, null, {}, { read: async () => {} }, { close: async () => {} }, { read: true, close: async () => {} }]) {
      await refusedReader(provider);
    }
  });

  it('RR_READER_REFUSAL_CONTROL: restoring acquisition before validation leaks the counted resource; restored order refuses without acquisition', async function () {
    const guard = "  if(typeof trustedSettings?.read!=='function'||typeof trustedSettings?.close!=='function')throw new TypeError('Explicit committed realtime presentation reader required');";
    await refusedReader(undefined);
    await assert.rejects(refusedReader(undefined, source => {
      assert.equal(source.split(guard).length, 2, 'control must land on actual reader validation');
      return source.replace(guard + '\n', '').replace('  let lookup;', guard + '\n  let lookup;');
    }), error => error.code === 'ERR_ASSERTION' && error.actual === 1 && error.expected === 0);
    await refusedReader(undefined);
  });

  it('RR_READER_LIFECYCLE: valid supplied reader serves current settings and keeps normal and refused-start cleanup', async function () {
    const fixture = readerRuntime();
    const runtime = await fixture.open(fixture.display);
    assert.deepEqual(await runtime.config.readCurrent(A), { tenant: A, settings: { version: 1 } });
    assert.deepEqual(await runtime.config.readCurrent(A), { tenant: A, settings: { version: 2 } });
    await runtime.close();
    assert.deepEqual(fixture.counts, { opened: 1, registryClosed: 1, lookupClosed: 1, resolverClosed: 1, displayClosed: 1, reads: 2 });
    const failed = readerRuntime(value => value, true);
    await assert.rejects(failed.open(failed.display), /synthetic lookup refusal/);
    assert.deepEqual(failed.counts, { opened: 1, registryClosed: 1, lookupClosed: 0, resolverClosed: 0, displayClosed: 1, reads: 0 });
  });

  it('RR_CONFIG: realtime takes `registry` in place of `tenants` and the admission file, and refuses both together', function () {
    const { parse } = require('../lib/server/realtime/config');
    const parsed = parse(realtimeConfig(), SOURCE);
    assert.equal(parsed.registry.namespace, 'rr_registry'); assert.equal(parsed.registry.refreshMs, 500);
    assert.equal(parsed.tenants.size, 0); assert.equal(Object.hasOwn(parsed,'admissionFile'),false);
    for (const extra of [{ tenants: [{ id: A, revision: 'v1', settings: {} }] }, { admissionFileEnv: 'RT_ADMISSION' }]) {
      assert.throws(() => parse(realtimeConfig(extra), SOURCE), {code:'REALTIME_REGISTRY_REQUIRED'});
    }
    assert.throws(() => parse(realtimeConfig({ registry: { namespace: 'rr_registry', refreshMs: 10 } }), SOURCE));
  });

  it('RR_ADMISSION: sockets are admitted by registry host lookup and the registry tenant set; definitive denials are SOCKET_ADMISSION_REFUSED', async function () {
    const active = new Set([A]);
    const admission = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map([['a.example.test', A], ['b.example.test', B]])),
      active: tenant => active.has(tenant), enabled: () => active });
    assert.equal(await admission.resolve(request('a.example.test')), A);
    assert.equal(await admission.resolveHost('a.example.test'), A);
    await assert.rejects(admission.resolve(request('b.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' }, 'resolves, but not in the served set');
    await assert.rejects(admission.resolve(request('unknown.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' });
    assert.equal(await admission.allows(A), true); assert.equal(await admission.allows('not-a-uuid'), false);
    assert.deepEqual([...await admission.enabled()], [A]);
    active.delete(A);
    await assert.rejects(admission.resolve(request('a.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' }, 'removal applies to the next socket');
    const failing = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map()), active: () => { throw new Error('down'); } });
    await assert.rejects(failing.allows(A), { code: 'SOCKET_ADMISSION_UNAVAILABLE' }, 'uncertainty rejects without admitting or manufacturing denial');
  });

  it('RR_PRIVATE_CONFIG: socket forwarding in registry mode names no admission file', function () {
    const privateConfig = require('../lib/server/realtime/private-config');
    const existing = { namespaces: { entries: 'rr_entries' }, connections: ['postgres://app:synthetic@db.example.test/ns'] };
    const value = { maxTenants: 10, maxMessageBytes: 10000, operationTimeoutMs: 1000, alarm: { connectionEnv: 'ALARM_PG', namespace: 'rr_alarm' } };
    const source = { ALARM_PG: 'postgres://alarm:synthetic@db.example.test/ns', ADMISSION: '/tmp/a.json' };
    assert.equal(privateConfig(value, source, { ...existing, registry: true }).admissionFile, null);
    assert.throws(() => privateConfig({ ...value, admissionFileEnv: 'ADMISSION' }, source, { ...existing, registry: true }), { code: 'SOCKET_PRIVATE_CONFIG_REFUSED' });
    assert.throws(() => privateConfig(value, source, existing), { code: 'SOCKET_PRIVATE_CONFIG_REFUSED' }, 'static mode still needs its admission file');
  });

  it('RR_WARM: the registry-mode warm names the tenant only; the api prepares an admitted tenant and answers denied; static mode refuses a hostless call', async function () {
    const { operations } = require('../lib/server/realtime/private-api');
    const token = Symbol('transport'), prepared = [];
    const active = new Set([A]);
    const registryAdmission = require('../lib/server/realtime/registry-admission').create({ resolver: resolverOf(new Map([['a.example.test', A]])), active: tenant => active.has(tenant) });
    const base = { token, authority: { verify: async () => ({ permissions: {}, collections: [] }) }, executeWrite: async () => [],
      alarmConnection: require('./fixtures/tenant-alarm-protocol')().db, prepareTenant: async tenant => { prepared.push(tenant); } };
    const config = { bindings: new Map([[A, true]]), aliases: null, socketForwarding: { alarm: { namespace: 'rr_alarm' } }, namespaces: { authorization: 'rr_auth' } };
    const ops = operations({ ...base, admission: registryAdmission, config });
    assert.deepEqual(await ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: {} }), { denied: true });
    assert.deepEqual(prepared, [A]);
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: B, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' }, 'a tenant the registry does not admit');
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: { secret: 'x' } }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' }, 'a hostless call carries no credential');
    await assert.rejects(ops.authorizeSocket({ transport: token }, { tenant: A, namespace: '/storage', credential: {} }), { code: 'SOCKET_PRIVATE_TENANT_REFUSED' });
    await assert.rejects(ops.authorizeSocket({ transport: Symbol('other') }, { tenant: A, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_REQUEST_REFUSED' });
    // With a host, the registry path resolves through the same admission (no static alias list).
    assert.deepEqual(Object.keys(await ops.authorizeSocket({ transport: token }, { host: 'a.example.test', tenant: A, namespace: '/', credential: {} })).sort(), ['collections', 'permissions']);
    const staticOps = operations({ ...base, config: { ...config, aliases: [{ host: 'a.example.test', tenant: A }] },
      admission: { resolveHost: async () => A, allows: async () => true } });
    await assert.rejects(staticOps.authorizeSocket({ transport: token }, { tenant: A, namespace: '/', credential: {} }), { code: 'SOCKET_PRIVATE_REQUEST_REFUSED' });
  });

  it('RR_REMOVE_REST: DELETE /v1/tenants/{id} answers removed, already removed, or 409 until the deletion ceremony executed; the CLI prints one line', async function () {
    const { createProvisioningApi } = require('../lib/tenant-registry/rest');
    const state = new Map([[A, 'executed'], [B, 'active']]), calls = [];
    const provisioning = { provision: async () => ({}), provisionBatch: async () => [], get: async () => null,
      async remove (id) {
        calls.push(id);
        if (!state.has(id)) return { id, outcome: 'refused', code: 'TENANT_NOT_FOUND' };
        if (state.get(id) === 'removed') return { id, outcome: 'existing', state: 'removed' };
        if (state.get(id) !== 'executed') return { id, outcome: 'refused', code: 'TENANT_REMOVAL_REQUIRES_DELETION' };
        state.set(id, 'removed'); return { id, outcome: 'removed', state: 'removed' };
      } };
    const handler = createProvisioningApi({ provisioning });
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const call = (method, route, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end();
    });
    try {
      assert.deepEqual(await call('DELETE', '/v1/tenants/' + A), { status: 200, body: { id: A, outcome: 'removed', state: 'removed' } });
      assert.deepEqual(await call('DELETE', '/v1/tenants/' + A), { status: 200, body: { id: A, outcome: 'existing', state: 'removed' } });
      const refused = await call('DELETE', '/v1/tenants/' + B);
      assert.equal(refused.status, 409); assert.equal(refused.body.code, 'TENANT_REMOVAL_REQUIRES_DELETION');
      assert.equal((await call('DELETE', '/v1/tenants/' + randomUUID())).status, 404);
      assert.equal((await call('DELETE', '/v1/tenants/' + B, { 'idempotency-key': A })).body.code, 'TENANT_PROVISION_IDEMPOTENCY_KEY_MISMATCH');
      assert.equal((await call('DELETE', '/v1/tenants/not-a-uuid')).status, 422);
      assert.equal((await call('PUT', '/v1/tenants/' + B)).status, 405);
      const openapi = (await call('GET', '/v1/openapi.json')).body;
      assert.equal(openapi.paths['/v1/tenants/{id}'].delete.operationId, 'removeTenant');
      assert.ok(openapi.components.schemas.Code.enum.includes('TENANT_REMOVAL_REQUIRES_DELETION'));
      // The CLI adapter.
      const admin = require('../lib/cli/commands/admin');
      const out = { stdout: '', stderr: '' };
      const io = { env: {}, stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } };
      state.set(B, 'executed');
      assert.equal(await admin.run(['remove', '--id', B, '--url', 'http://127.0.0.1:' + port], io), 0);
      assert.equal(out.stdout, B + ' removed\n');
      const other = randomUUID(); state.set(other, 'active'); out.stdout = '';
      assert.equal(await admin.run(['remove', '--id', other, '--url', 'http://127.0.0.1:' + port], io), 1);
      assert.equal(out.stdout, other + ' refused TENANT_REMOVAL_REQUIRES_DELETION\n');
      assert.equal(await admin.run(['remove', '--id', other, '--host', 'a.example.test', '--url', 'http://127.0.0.1:' + port], io), 64);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  it('RR_STATIC_LAB: a role configuration that lists tenants is refused without MULTITENANT_STATIC_TENANTS=lab; registry mode needs no flag', function () {
    const gate = require('../lib/server/serve/static-tenants');
    const configs = { preview: { registry: null }, adminPreview: { ownership: { tenants: [A] } }, operationConfig: { locks: [{ tenant: A, key: '1' }] } };
    assert.throws(() => gate.check({}, configs), error => error.code === 'STATIC_TENANTS_REFUSED' && /api, admin, operation cohort/.test(error.message));
    assert.match(gate.check({ MULTITENANT_STATIC_TENANTS: 'lab' }, configs), /lab and test only\): api, admin, operation cohort/);
    assert.throws(() => gate.check({ MULTITENANT_STATIC_TENANTS: 'yes' }, configs), { code: 'STATIC_TENANTS_REFUSED' });
    const registry = { preview: { registry: { namespace: 'r' } }, realtimePreview: { registry: { namespace: 'r' } }, evaluatorPreview: { registry: { namespace: 'r' } },
      ownerPreview: { registry: { namespace: 'r' } }, adminPreview: { ownership: { registry: { namespace: 'r' } }, provisioning: {} }, operationConfig: { locks: null } };
    assert.equal(gate.check({}, registry), null);
    assert.equal(gate.check({}, { adminPreview: { provisioning: {} } }), null, 'provisioning alone lists no tenants');
    assert.deepEqual(gate.staticRoles({ vcpoolPreview: {} }), ['vcpool'], 'vcpool has no registry mode yet');
  });
});

// Actual registry resolver, admission and protocol. No network or database.
describe('RR_REGISTRY_RETRY: connected socket admission uncertainty', function () {
  const { EventEmitter } = require('node:events');
  const admissionFactory = require('../lib/server/realtime/registry-admission');
  const resolverFactory = require('../lib/tenant-registry/resolver');
  const protocolFactory = require('../lib/server/realtime/protocol');
  const env = require('../lib/server/tenant-app/environment')({ settings: { enable: ['bgnow'] } });
  const frame = stamp => ({ identity: 'same', checkpoint: stamp, rows: [], frame: { delta: false, lastUpdated: stamp, sgvs: [{ mgdl: 100, mills: stamp }] } });
  class Socket extends EventEmitter {
    constructor () { super(); this.request = { ...request('a.example.test'), headers: { host: 'a.example.test' } }; this.sent = []; this.connected = true; }
    emit (event, value) { this.sent.push({ event, value }); return true; }
    join () {}
    leave () {}
    disconnect () { this.connected = false; super.emit('disconnect'); }
  }
  async function fixture () {
    let clock = 0;
    const ctl = { lookupError: null, activeError: null, removed: false, denied: false, mutations: 0, frame: frame(1) };
    const resolver = resolverFactory.createRegistryResolver({
      store: { revision: async () => '1', entry: async () => null, lookup: async host => {
        if (ctl.lookupError) throw ctl.lookupError;
        return host === 'a.example.test' && !ctl.removed ? { tenant: A, state: 'active' } : null;
      } }, refreshMs: 1000, now: () => clock, schedule: () => null, cancel () {}
    });
    await resolver.start();
    const admission = admissionFactory.create({ resolver, active: () => {
      if (ctl.activeError) throw ctl.activeError;
      return !ctl.removed;
    } });
    const api = { authorizeSocket: async () => ctl.denied ? { denied: true } : ({ permissions: { read: true, write: true, write_treatment: true, ack: true }, collections: ['entries'] }),
      executeSocketMutation: async () => { ctl.mutations++; return { replyArgs: [] }; } };
    const runtime = { warm: () => true, fresh: async () => ctl.frame, last: () => ctl.frame };
    const protocol = protocolFactory.create({ admission, api, readCurrent: async () => ({ identity: 'same', env }), runtime: () => runtime,
      domains: ['entries'], retry: { minMs: 1, maxMs: 2 }, authorizationRecheckMs: 600000 });
    const socket = new Socket();
    await protocol.prepare(socket); protocol.bind(socket, '/');
    for (let i = 0; i < 100 && protocol.stats().primed !== 1; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(protocol.stats().primed, 1, 'actual protocol primed before fault');
    return { ctl, resolver, admission, protocol, socket, stale () { clock += 3001; }, close () { protocol.close(); resolver.close(); } };
  }
  let mode;
  beforeEach(() => { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(mode));
  for (const source of ['lookupError', 'activeError']) {
    it('keeps a primed socket, withholds changed frames, and resumes after ' + source, async function () {
      const f = await fixture();
      try {
        const failure = Object.assign(new Error('synthetic store timeout'), { code: 'ETIMEDOUT' });
        f.ctl[source] = failure; f.stale();
        await f.protocol.recheckTenant(A);
        assert.equal(f.socket.connected, true, 'uncertainty must not permanently disconnect');
        assert.equal(f.protocol.stats().recheckFailures, 1);
        const before = f.socket.sent.length, previous = f.ctl.frame; f.ctl.frame = frame(2);
        await f.protocol.fanout({ tenant: A, previous, next: f.ctl.frame });
        assert.equal(f.socket.sent.length, before, 'held socket receives no changed frame');
        let acknowledged = false;
        const blocked = await f.socket.listeners('dbAdd')[0]({ collection: 'entries', data: {} }, () => { acknowledged = true; });
        assert.equal(blocked.delivered, false);
        assert.equal(f.ctl.mutations, 0, 'uncertain admission never forwards writes');
        assert.equal(acknowledged, false, 'uncertain writes are never acknowledged');
        if (source === 'activeError') await assert.rejects(f.admission.allows(A), { code: 'SOCKET_ADMISSION_UNAVAILABLE' });
        f.ctl[source] = null;
        await f.protocol.recheckTenant(A);
        for (let i = 0; i < 100 && !f.socket.sent.some(row => row.event === 'dataUpdate' && row.value.sgvs?.[0]?.mills === 2); i++) await new Promise(resolve => setImmediate(resolve));
        assert.ok(f.socket.sent.some(row => row.event === 'dataUpdate' && row.value.sgvs?.[0]?.mills === 2), 'restored authority releases missed frame');
        assert.equal(f.socket.connected, true);
        const delivered = await f.socket.listeners('dbAdd')[0]({ collection: 'entries', data: {} });
        assert.equal(delivered.delivered, true);
        assert.equal(f.ctl.mutations, 1, 'same forwarding path resumes after admission recovers');
      } finally { f.close(); }
    });
  }
  for (const cause of ['removed', 'denied', 'bad-selector', 'removed-entry']) {
    it('still disconnects on definitive ' + cause, async function () {
      const f = await fixture();
      try {
        if (cause === 'removed-entry') {
          // Actual API active path delegates to resolver.entry. A missing/removed
          // entry is a definitive denial, unlike a failed entry lookup.
          f.ctl.activeError = await f.resolver.entry(A).catch(error => error);
          assert.equal(f.ctl.activeError.code, 'TENANT_REMOVED');
          assert.equal(await f.admission.allows(A), false);
        } else if (cause === 'bad-selector') f.socket.request.rawHeaders.push('Host', 'b.example.test');
        else f.ctl[cause] = true;
        f.stale(); await f.protocol.recheckTenant(A);
        assert.equal(f.socket.connected, false);
        assert.equal(f.protocol.stats().disconnects.REALTIME_RECHECK_REFUSED, 1);
      } finally { f.close(); }
    });
  }
  it('keeps definitive removal from the API resolver materialization wrapper terminal', async function () {
    const f = await fixture();
    try {
      // registry-tenants.resolve materializes the resolved tenant's entry before
      // returning. Its entry read can definitively establish removal too.
      const wrapped = admissionFactory.create({ resolver: { resolve: async req => {
        const tenant = await f.resolver.resolve(req);
        await f.resolver.entry(tenant);
        return tenant;
      } }, active: () => true });
      await assert.rejects(wrapped.resolve(request('a.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' });
    } finally { f.close(); }
  });
  it('preserves unknown host and untrusted selector refusals, but does not relabel a closed resolver', async function () {
    const f = await fixture();
    try {
      await assert.rejects(f.admission.resolve(request('missing.example.test')), { code: 'SOCKET_ADMISSION_REFUSED' });
      const forwarded = request('a.example.test'); forwarded.rawHeaders.push('X-Forwarded-Host', 'foreign.example.test');
      await assert.rejects(f.admission.resolve(forwarded), { code: 'SOCKET_ADMISSION_REFUSED' });
      f.resolver.close();
      await assert.rejects(f.admission.resolve(request('a.example.test')), { code: 'SOCKET_ADMISSION_UNAVAILABLE' });
      assert.equal(await f.admission.allows('invalid'), false);
    } finally { f.close(); }
  });
});


describe('canonical source fixture background registry grants', function () {
  it('gives realtime lookup/enumeration and evaluator enumeration without tenant-row or key reads', function () {
    const layout=require('./fixtures/realtime-preview/bootstrap-plan').layout('eeeeeeeeeeeeeeee');
    const statements=require('./fixtures/realtime-preview/bootstrap-grants').grants(layout),ns='"'+layout.namespaces.registry+'"';
    const grants=role=>statements.filter(sql=>sql.endsWith(' TO "'+role+'"'));
    for(const role of [layout.roles.realtime,layout.roles.evaluator]){
      const selected=grants(role);assert(selected.some(sql=>sql.includes('tenant_registry_tenants(uuid, integer)')));
      assert(!selected.some(sql=>sql.includes('GRANT SELECT ON '+ns+'.tenant_registry,')));
      assert(!selected.some(sql=>sql.includes('tenant_registry_alias(uuid)')));
    }
    assert(grants(layout.roles.realtime).some(sql=>sql.includes('tenant_registry_lookup(text, text)')));
    assert(!grants(layout.roles.evaluator).some(sql=>sql.includes('tenant_registry_lookup(text, text)')));
    for(const role of [layout.roles.api,layout.roles.owner_reader])assert(grants(role).some(sql=>sql.includes('GRANT SELECT ON '+ns+'.tenant_registry,')));
  });
});
