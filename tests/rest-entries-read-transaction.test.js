'use strict';

// Real pg.Pool and PostgreSQL connection transaction code; the synthetic driver
// records backend/commit behavior without opening PostgreSQL or another service.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const scope = require('../lib/storage/tenant-scope');
const authentication = require('../lib/api3/tenant-authentication');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function accessImplementation (mutate) {
  if (!mutate) return require('../lib/server/tenant-app/data-access');
  const file = require.resolve('../lib/server/tenant-app/data-access'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const source = fs.readFileSync(file, 'utf8'), changed = mutate(source);
  assert.notEqual(source, changed, 'control mutation landed');
  loaded._compile(changed, file); return loaded.exports;
}
function readsPreviewEntries (sql) {
  return sql.includes('FROM "source_entries"."entries"');
}
async function fixture (mutate) {
  const calls = [], events = [], clients = [], states = new Map([[A, true], [B, true]]);
  let action = async () => undefined;
  class Client extends EventEmitter {
    constructor () { super(); this.processID = 100 + clients.length; this._queryable = true; this._ending = false; clients.push(this); }
    connect (done) { queueMicrotask(() => done(null)); }
    query (input, values, done) {
      if (typeof values === 'function') { done = values; values = undefined; }
      const text = typeof input === 'string' ? input : input.text;
      values = typeof input === 'object' ? input.values : values;
      const execute = async () => {
        calls.push({ text, values, pid: this.processID, timeout: input.query_timeout });
        const override = await action(this, text, values);
        if (override) return override;
        if (text.includes("current_setting('server_version')")) return { rows: [{ version: 'synthetic' }] };
        if (readsPreviewEntries(text) || text.startsWith('SELECT id_kind, doc')) return { rows: [{ id_kind: 'string', doc: { _id: 'reading', type: 'sgv', sgv: 123, date: Date.now() - 1000 } }] };
        if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes('FROM pg_class')) return { rows: Array.from({ length: 4 }, () =>
          ({ secured: true, owns: false, reads: true, writes: false, column_reads: true })) };
        if (text.includes('s.subject_id, s.display_name')) return { rows: [{ anonymous_roles: ['denied'], subject_id: 'subject', display_name: 'current-name',
          role_name: 'reader', found_role: 'reader', permissions: states.get(values[0]) ? ['api:entries:read'] : [] }] };
        return { rows: [], command: text.split(' ')[0], rowCount: 1 };
      };
      if (done) { execute().then(x => done(null, x), done); return; }
      return execute();
    }
    end (done) { this._ending = true; this.emit('end'); if (done) queueMicrotask(done); }
  }
  const filename = require.resolve('../lib/storage/postgres-connection'), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = loaded.require.bind(loaded);
  loaded.require = name => name === './postgres-settings-protocol'
    ? { Client, assertTransaction () {}, assertRollback () {}, assertUnlock () {} } : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  const connection = await loaded.exports({ connectionString: 'postgres://synthetic:synthetic@127.0.0.1/synthetic_test',
    direct: true, displaySettings: true, application_name: 'nightscout-display-settings', max: 4, idleTimeoutMillis: 0 });
  const authority = await require('../lib/tenant-authorization/postgres')({ namespace: 'synthetic_auth', connection });
  const createAccess = accessImplementation(mutate);
  const access = createAccess({ authority, readConnection: connection,
    verifierContext: async tenant => ({ tenant, consumer: 'api' }), legacyCollections: ['entries'],
    secrets: { async verifyLegacyCredential () { events.push('credential-and-audits-finished'); return { kind: 'subject', subjectId: 'subject' }; } } });
  const request = (tenant = A) => {
    const req = { method: 'GET', path: '/entries/sgv.json', rawHeaders: [], query: { token: 'synthetic' } };
    createAccess.registerRawRead(req, { tenant, logical: 'entries', connection,
      async load () { events.push('load'); await connection.query('SELECT clinical_entries'); return { tenant }; },
      publish (frame) { events.push('publish'); req.frame = frame; } });
    return req;
  };
  calls.length = 0;
  return { connection, authority, access, request, calls, events, clients, states, action: value => { action = value; },
    async close () { await authority.close(); await connection.end(); } };
}
function oneTransaction (f) {
  assert.equal(f.calls.filter(x => x.text === 'BEGIN').length, 1, 'AUTHORITY_AND_ENTRY_ONE_TRANSACTION');
  assert.equal(new Set(f.calls.map(x => x.pid)).size, 1, 'same physical backend');
  assert.equal(f.calls.filter(x => x.text === 'COMMIT').length, 1);
}
describe('private current-authority and raw entries read transaction', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  it('finishes credential/audits first, admits current actor before data and publishes only after COMMIT', async function () {
    const f = await fixture(), req = f.request();
    try {
      f.action(async (client, text) => {
        if (text === 'BEGIN') assert.deepEqual(f.events, ['credential-and-audits-finished']);
        if (text === 'SELECT clinical_entries') assert(f.calls.some(x => x.text.includes('s.subject_id, s.display_name')));
        if (text === 'COMMIT') { assert.equal(authentication.get(req), undefined); assert.equal(req.frame, undefined); }
      });
      assert(await f.access({ tenant: A, request: req, version: 1 }));
      oneTransaction(f);
      assert.deepEqual(f.events, ['credential-and-audits-finished', 'load', 'publish']);
      assert.equal(req.frame.tenant, A); assert(authentication.get(req));
      assert.equal(f.calls.find(x => x.text.includes('s.subject_id, s.display_name')).timeout, 5000);
      f.action(async () => undefined);
      await f.authority.close();
      await scope.withTenant(A, () => f.connection.query('SELECT still_owned'));
      assert(f.clients.every(c => !c._ending), 'borrowed authority does not close data pool');
    } finally { await f.close(); }
  });
  it('refuses a revoked actor before clinical SQL and re-reads authority on the next request', async function () {
    const f = await fixture();
    try {
      assert(await f.access({ tenant: A, request: f.request(), version: 1 }));
      f.states.set(A, false); f.calls.length = 0;
      const denied = f.request();
      await assert.rejects(f.access({ tenant: A, request: denied, version: 1 }), { code: 'TENANT_LEGACY_FORBIDDEN' });
      assert(!f.calls.some(x => x.text === 'SELECT clinical_entries'));
      assert.equal(authentication.get(denied), undefined); assert.equal(denied.frame, undefined);
      assert(f.calls.some(x => x.text === 'ROLLBACK'));
      assert(await f.access({ tenant: B, request: f.request(B), version: 1 }));
      f.states.set(A, true); assert(await f.access({ tenant: A, request: f.request(), version: 1 }));
    } finally { await f.close(); }
  });
  it('never publishes a frame or bound actor when COMMIT or data SQL fails', async function () {
    for (const phase of ['COMMIT', 'SELECT clinical_entries', 'TRANSPORT_COMMIT']) {
      const f = await fixture(), req = f.request(), failure = Error('synthetic phase failure');
      try {
        f.action(async (client, text) => {
          if (phase === 'TRANSPORT_COMMIT' && text === 'COMMIT') client.emit('error', failure);
          if (text === phase) throw failure;
        });
        await assert.rejects(f.access({ tenant: A, request: req, version: 1 }), error => error === failure);
        assert.equal(authentication.get(req), undefined); assert.equal(req.frame, undefined);
        assert(!f.events.includes('publish'));
      } finally { await f.close(); }
    }
  });
  it('does not select a joint transaction for writes or a foreign materializer', async function () {
    const f = await fixture();
    try {
      const req = f.request(); req.method = 'POST'; req.path = '/entries';
      await assert.rejects(f.access({ tenant: A, request: req, version: 1 }), { code: 'TENANT_LEGACY_FORBIDDEN' });
      assert(!f.events.includes('load'));
      f.calls.length = 0; const foreign = f.request(B);
      assert(await f.access({ tenant: A, request: foreign, version: 1 }));
      assert.equal(foreign.frame, undefined); assert(!f.events.includes('load'));
    } finally { await f.close(); }
  });
  it('connects the actual preview materializer to the shared transaction and keeps HTTP responses after commit', async function () {
    const f = await fixture();
    try {
      const preview = require('../lib/server/serve/preview-domains');
      const environment = require('../lib/server/tenant-app/environment');
      const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
      const graph = await preview({ config: { domains, legacyEnabled: true, contextEnabled: true,
        bindings: new Map([[A, {}], [B, {}]]), environments: new Map([[A, environment()], [B, environment()]]),
        namespaces: Object.fromEntries(domains.map(d => [d, 'source_' + d])) }, connection: f.connection, exchange: async () => null });
      const unused = async () => { throw Error('not installed'); };
      const app = require('../lib/server/tenant-app').createTenantApp({
        resolver: { resolve: async () => A }, dataAccess: f.access, legacyRouter: graph.legacyRouter,
        verifyCredential: unused, authorizeRequest: unused,
        tenantSettings: { read: unused, replace: unused, rollback: unused },
        subjectPolicy: { read: unused, replace: unused }, dataRouter: require('express').Router() });
      const request = require('./fixtures/in-memory-http');
      f.calls.length = 0;
      const result = await request(app, '/api/v1/entries/sgv.json?token=synthetic&count=1');
      assert.equal(result.status, 200);
      assert.equal(result.body[0].sgv, 123); oneTransaction(f);
      assert.equal(f.calls.filter(x => readsPreviewEntries(x.text)).length, 1, 'committed frame reused without another acquisition');
      f.calls.length = 0;
      const commitFailure = Error('synthetic commit refused');
      f.action(async (client, text) => { if (text === 'COMMIT') throw commitFailure; });
      const refused = await request(app, '/api/v1/entries/sgv.json?token=synthetic&count=1');
      assert.notEqual(refused.status, 200, 'no HTTP success before committed acquisition');
      assert(!Array.isArray(refused.body));
    } finally { await f.close(); }
  });

  it('joins actual treatments and devicestatus materializers with fresh authority before HTTP success', async function () {
    const f = await fixture();
    try {
      const domains = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
      const environment = require('../lib/server/tenant-app/environment');
      const graph = await require('../lib/server/serve/preview-domains')({ config: {
        domains, legacyEnabled: true, contextEnabled: true,
        bindings: new Map([[A, {}]]), environments: new Map([[A, environment()]]),
        namespaces: Object.fromEntries(domains.map(name => [name, 'source_' + name]))
      }, connection: f.connection, exchange: async () => null });
      const unused = async () => { throw Error('not installed'); };
      const access = require('../lib/server/tenant-app/data-access')({ authority: f.authority, readConnection: f.connection,
        verifierContext: async tenant => ({ tenant, consumer: 'api' }), legacyCollections: domains,
        secrets: { verifyLegacyCredential: async () => ({ kind: 'root' }) } });
      const app = require('../lib/server/tenant-app').createTenantApp({ resolver: { resolve: async () => A },
        dataAccess: access, legacyRouter: graph.legacyRouter, dataRouter: require('express').Router(),
        verifyCredential: unused, authorizeRequest: unused, tenantSettings: { read: unused, replace: unused, rollback: unused },
        subjectPolicy: { read: unused, replace: unused } });
      const request = require('./fixtures/in-memory-http');
      for (const logical of ['treatments', 'devicestatus']) for (const version of [1, 2]) {
        f.action(async (client, text) => {
          if (text.includes('s.subject_id AS found_subject')) return { rows: [{ anonymous_roles: ['denied'],
            found_subject: null, role_name: null, found_role: null, permissions: null }] };
          if (text.startsWith('SELECT id_kind, doc')) return { rows: [{ id_kind: 'string', doc: {
            _id: logical + '-synthetic', eventType: 'Note', created_at: new Date().toISOString(), device: 'synthetic'
          } }] };
        });
        f.calls.length = 0;
        const result = await request(app, '/api/v' + version + '/' + logical + '?count=1', { headers: { 'api-secret': 'synthetic' } });
        assert.equal(result.status, 200); assert.equal(result.body[0]._id, logical + '-synthetic');
        oneTransaction(f);
        assert.equal(f.calls.filter(call => call.text.startsWith('SELECT id_kind, doc')).length, 1, 'ONE_DOMAIN_ACQUISITION');
        assert.equal(f.calls.filter(call => call.text.includes('s.subject_id AS found_subject')).length, 1, 'FRESH_AUTHORITY_ON_EVERY_READ');
      }
    } finally { await f.close(); }
  });

  it('does not close a borrowed pool if authority startup admission refuses', async function () {
    const f = await fixture();
    try {
      f.action(async (client, text) => { if (text.includes('FROM pg_class')) return { rows: [] }; });
      await assert.rejects(require('../lib/tenant-authorization/postgres')({ namespace: 'unsafe_auth', connection: f.connection }),
        { code: 'TENANT_AUTHORITY_UNSAFE' });
      f.action(async () => undefined);
      await scope.withTenant(A, () => f.connection.query('SELECT healthy_owner'));
      assert(f.clients.every(c => !c._ending));
    } finally { await f.close(); }
  });

  it('refuses a different authority/data connection identity', async function () {
    const f = await fixture();
    try {
      assert.throws(() => accessImplementation()({ authority: f.authority,
        readConnection: { ...f.connection }, secrets: { verifyLegacyCredential: async () => null },
        verifierContext: async () => null }), /must own the same connection/);
    } finally { await f.close(); }
  });

  it('control: early publication is caught at the physical COMMIT boundary', async function () {
    const f = await fixture(s => s.replace('return { binding: allowed, frame, joined: true };',
      'registered.publish(frame); authentication.bind(request, Object.freeze(allowed)); return { binding: allowed, frame, joined: true };'));
    const req = f.request();
    try {
      f.action(async (client, text) => {
        if (text === 'COMMIT') assert.equal(req.frame, undefined, 'READ_COMMIT_REQUIRED_BEFORE_PUBLICATION');
      });
      await assert.rejects(f.access({ tenant: A, request: req, version: 1 }), /READ_COMMIT_REQUIRED_BEFORE_PUBLICATION/);
      assert(req.frame && authentication.get(req), 'control really exposes data and actor prematurely');
    } finally { await f.close(); }
  });

  it('control: disabling the joined boundary restores two transactions and fails the transaction oracle', async function () {
    const f = await fixture(s => s.replace('if (joinedRead && currentAuthority === authority) {', 'if (false && joinedRead && currentAuthority === authority) {'));
    try {
      const req = f.request(); await f.access({ tenant: A, request: req, version: 1 });
      await scope.withTenant(A, () => f.connection.query('SELECT clinical_entries'));
      assert.equal(f.calls.filter(x => x.text === 'BEGIN').length, 2);
      assert.throws(() => oneTransaction(f), /AUTHORITY_AND_ENTRY_ONE_TRANSACTION/);
    } finally { await f.close(); }
  });
});
