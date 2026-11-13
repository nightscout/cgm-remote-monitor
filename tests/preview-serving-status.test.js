'use strict';
// Actual HTTP shipping status/client gate + API boot dependency protocol only.
// No PostgreSQL/Vault/browser/provider or clinical-materialization acceptance.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), Module = require('node:module');
const express = require('express'), request = require('supertest'), shiro = require('shiro-trie');
const environment = require('../lib/server/tenant-app/environment');
const authentication = require('../lib/api3/tenant-authentication'), scope = require('../lib/storage/tenant-scope');
const A = '11111111-1111-4111-8111-111111111111';
function clientGate (status) {
  // Compile the actual unchanged client.init AST node, not a mirrored condition.
  const source = fs.readFileSync(require.resolve('../lib/client/index'), 'utf8');
  const tree = require('acorn').parse(source, { ecmaVersion: 'latest' });
  const assignment = tree.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.left.object?.name === 'client' && node.expression.left.property?.name === 'init').expression.right;
  let retried = false, proceeded = false;
  const $ = () => ({ html () {}, show () {} }); $.ajax = () => ({ done (fn) { fn(status); return this; }, fail () {} });
  const client = { headers: () => ({}), hashauth: {}, loadLanguage: () => { proceeded = true; } };
  const init = vm.runInNewContext('(' + source.slice(assignment.start, assignment.end) + ')', { $, client,
    require: name => { assert.equal(name, './browser-utils'); return () => ({ queryParms: () => ({}) }); },
    Storages: { localStorage: { get: () => null } }, window: { setTimeout: (fn, ms) => { assert.equal(ms, 5000); retried = true; } }, console: { log () {} } });
  init(() => {}); return { retried, proceeded };
}
async function statusApp (servingState, display = false) {
  let presentationReads = 0, clinicalReads = 0, booted = false;
  const connection = { withTenant: (tenant, fn) => scope.withTenant(tenant, fn), transaction: fn => fn(), query: async sql => {
    if (sql.includes("current_setting('server_version')")) return { rows: [{ version: 'source-protocol' }] };
    if (booted) clinicalReads++; return { rows: [] }; // actual entry-port restore allowed only during construction
  } };
  const graph = await require('../lib/server/serve/preview-domains')({ config: { domains: ['entries'], legacyEnabled: false, contextEnabled: true,
    bindings: new Map([[A, {}]]), environments: new Map([[A, environment()]]), namespaces: { entries: 'source_entries' } }, connection,
  exchange: async () => null, servingState, displaySettings: display ? { read: async tenant => { assert.equal(tenant, A); presentationReads++;
    return { effective: { DISPLAY_UNITS: { value: 'mmol' }, SHOW_SECONDS: { value: true } } }; } } : undefined });
  booted = true;
  const app = express(); app.use((req, res, next) => scope.withTenant(A, () => {
    req.tenantContext = { tenant: A }; req.tenantAuthenticate = async () => {
      const trie = shiro.new(); if (req.header('x-synthetic-denied') !== '1') trie.add(['api:status:read']);
      authentication.bind(req, { shiros: [trie] });
    }; next();
  }));
  app.use('/api/v1', graph.legacyRouter);
  app.use((error, req, res, next) => { void next; res.status(500).json({ error: 'SOURCE_PROTOCOL_FAILED' }); });
  return { app, counts: () => ({ presentationReads, clinicalReads }) };
}
function bootProtocol ({ hold, fail } = {}) {
  const events = [], oldLoad = Module._load; let readState, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const stage = async name => { events.push(name); if (name === hold) { entered(); await gate; } if (name === fail) throw new Error('synthetic boot refusal'); };
  const resource = () => ({ end: async () => { if (readState) assert.equal(readState.read(), 'unavailable', 'API_UNAVAILABLE_BEFORE_RESOURCE_TEARDOWN'); events.push('end'); } });
  const legacy = { ...resource(), read: async () => ({ reference: { tenant: A, id: 'synthetic' } }) };
  const authority = { ...resource(), authorize: async () => false }, persistence = { ...resource(), store: { get: async () => ({}) } };
  const stubs = {
    '../../storage/postgres-connection': async () => resource(),
    '../../secrets/component': { createSecrets: () => ({}) }, '../../secrets/postgres': { createPostgresSecrets: async () => persistence },
    '../../secrets/legacy-postgres': async () => legacy, '../../tenant-authorization/postgres': async () => authority,
    '../tenant-app/data-access': () => (req, res, next) => next(), '../tenant-app/exchange': () => async () => null,
    '../tenant-app': { createTenantApp: () => express.Router() },
    './postgres-domains': { readiness: () => stage('readiness'), assertServing: async () => { await stage('assertServing'); return { ensure: async () => {}, invalidateTenant () {} }; } },
    './preview-domains': async options => { readState = options.servingState; await stage('domains'); return { data: express.Router(), v3Names: [], legacyNames: [], safeRoutes: {}, initializeTenant: async () => {} }; },
    '../realtime/private-api': { boot: async () => { await stage('private'); return { close: resource().end }; } }
  };
  Module._load = function (name, ...args) { return Object.hasOwn(stubs, name) ? stubs[name] : oldLoad.call(this, name, ...args); };
  const file = require.resolve('../lib/server/serve/preview-api'); delete require.cache[file];
  let api; try { api = require(file); } finally { Module._load = oldLoad; }
  // boot also has a dynamic selected private receiver import.
  const run = async config => { Module._load = function (name, ...args) { return Object.hasOwn(stubs, name) ? stubs[name] : oldLoad.call(this, name, ...args); };
    try { return await api.boot(config); } finally { Module._load = oldLoad; delete require.cache[file]; } };
  return { events, started, release, state: () => readState, run: () => run({ bindings: new Map([[A, { principal: 'synthetic', consumer: 'api' }]]), providers: new Map(), namespaces: {}, socketForwarding: true }) };
}
describe('selected API-local serving status compatibility', function () {
  let old; before(() => { old = scope.getTenancyMode(); scope.setTenancyMode('multi'); }); after(() => scope.setTenancyMode(old));
  it('reproduces omitted-status client retry and dynamically admits loaded only with selected capability, including derived display context', async function () {
    const original = await statusApp(); const omitted = await request(original.app).get('/api/v1/status.json').expect(200);
    assert.equal(Object.hasOwn(omitted.body, 'runtimeState'), false); assert.deepEqual(clientGate(omitted.body), { retried: true, proceeded: false });
    let ready = false; const selected = await statusApp({ read: () => ready ? 'loaded' : 'unavailable' }, true);
    const waiting = await request(selected.app).get('/api/v1/status.json').expect(200);
    assert.equal(waiting.body.runtimeState, 'unavailable'); assert.deepEqual(clientGate(waiting.body), { retried: true, proceeded: false });
    ready = true; const loaded = await request(selected.app).get('/api/v1/status.json').expect(200);
    assert.equal(loaded.body.runtimeState, 'loaded', 'API_SERVING_CAPABILITY_REACHES_STATUS'); assert.deepEqual(clientGate(loaded.body), { retried: false, proceeded: true });
    assert.equal(loaded.body.settings.units, 'mmol'); assert.deepEqual(selected.counts(), { presentationReads: 2, clinicalReads: 0 });
    await request(selected.app).get('/api/v1/status.json').set('x-synthetic-denied', '1').expect(401);
  });
  it('holds actual API boot readiness until complete private receiver and invalidates quiesce/close before resource teardown', async function () {
    const fixture = bootProtocol({ hold: 'private' }); const pending = fixture.run(); await fixture.started; let role;
    try {
      assert.equal(fixture.state().read(), 'unavailable', 'API_NOT_LOADED_DURING_PRIVATE_BOOT'); fixture.release(); role = await pending;
      assert.deepEqual(fixture.events.slice(0, 4), ['readiness', 'assertServing', 'domains', 'private'], 'API_BOOT_READINESS_REQUIRED');
      assert.equal(fixture.state().read(), 'loaded'); await role.quiesce(); assert.equal(fixture.state().read(), 'unavailable', 'API_QUIESCE_INVALIDATES_STATUS');
      await role.close(); assert(fixture.events.includes('end')); await role.close();
    } finally { fixture.release(); role = role || await pending.catch(() => null); if (role) await Promise.allSettled([role.close()]); }
  });
  it('never returns a ready role after readiness/serving/domain/private failures and invalidates close before teardown', async function () {
    for (const fail of ['readiness', 'assertServing', 'domains', 'private']) {
      const fixture = bootProtocol({ fail }); await assert.rejects(fixture.run(), /preview readiness or storage initialization refused/);
      if (fixture.state()) assert.equal(fixture.state().read(), 'unavailable');
    }
    const fixture = bootProtocol(); const role = await fixture.run(); assert.equal(fixture.state().read(), 'loaded');
    await role.close(); assert.equal(fixture.state().read(), 'unavailable');
  });
});
