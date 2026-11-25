'use strict';

// Focused joined-authority protocol checks. Real pg.Pool/transaction/authority
// modules with a recording synthetic driver; no PostgreSQL, listener or benchmark.
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
async function fixture (kind = 'legacy-subject', mutate) {
  const calls = [], events = [], clients = [], states = new Map([[A, true], [B, true]]);
  let action = async () => undefined;
  const state = { metadata: true, subject: true, anonymous: kind === 'anonymous', credential: true };
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
        if (text.startsWith('SELECT id_kind, doc')) return { rows: [{ id_kind: 'string', doc: { _id: 'reading', type: 'sgv', sgv: 123, date: Date.now() - 1000 } }] };
        if (text.includes('FROM pg_roles')) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes('FROM pg_class')) return { rows: Array.from({ length: 4 }, () =>
          ({ secured: true, owns: false, reads: true, writes: false, column_reads: true })) };
        if (text.includes('s.subject_id AS found_subject')) return { rows: !state.metadata ? [] : [{ anonymous_roles: state.anonymous ? ['readable'] : ['denied'], found_subject: state.subject ? 'subject' : null, role_name: 'reader', found_role: 'reader', permissions: states.get(values[0]) ? ['api:entries:read'] : [] }] };
        if (text.includes('s.subject_id, s.display_name')) return { rows: !state.metadata ? [] : [{ anonymous_roles: ['denied'], subject_id: state.subject ? 'subject' : null, display_name: 'current-name',
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
    humanSessions: { credential: () => kind === 'human' ? { cookie: true, token: 'synthetic-human' } : null,
      accepts: () => false, authenticate: async () => { events.push('human-current-authority'); return { actor: { subject: 'subject', allows: () => true } }; } },
    secrets: { async verifyLegacyCredential () {
      events.push('credential-and-audits-finished');
      if (!state.credential) return null;
      return kind === 'root' ? { kind: 'root' } : kind === 'anonymous' ? { kind: 'anonymous' } : { kind: 'subject', subjectId: 'subject' };
    } } });
  const request = (tenant = A, overrides = {}) => {
    const req = { method: 'GET', path: '/entries/sgv.json', rawHeaders: [], query: {} };
    if (kind === 'legacy-subject') req.query.token = 'synthetic';
    else if (['root', 'api-secret-subject'].includes(kind)) req.rawHeaders = ['api-secret', 'synthetic'];
    Object.assign(req, overrides);
    createAccess.registerRawRead(req, { tenant, logical: 'entries', connection: overrides.foreignConnection ? { ...connection, query: () => {} } : connection,
      async load () { events.push('load'); await connection.query('SELECT clinical_entries'); return { tenant }; },
      publish (frame) { events.push('publish'); req.frame = frame; } });
    return req;
  };
  calls.length = 0;
  return { connection, authority, access, request, calls, events, clients, states, state, action: value => { action = value; },
    async close () { await authority.close(); await connection.end(); } };
}
function oneTransaction (f) {
  assert.equal(f.calls.filter(x => REQUEST_BEGIN.has(x.text)).length, 1, 'AUTHORITY_AND_ENTRY_ONE_TRANSACTION');
  assert.equal(new Set(f.calls.map(x => x.pid)).size, 1, 'same physical backend');
  assert.equal(f.calls.filter(x => x.text === 'COMMIT').length, 1);
}
// A request's reads open a database-enforced read-only transaction; a write
// boundary still opens with BEGIN. Either one is one transaction.
const REQUEST_BEGIN = new Set(['BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY']);
describe('private joined entries authority coverage', function () {
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));
  for (const kind of ['legacy-subject', 'root', 'anonymous', 'api-secret-subject']) {
    it('joins ' + kind + ' current authority and entries for v1 GET and v2 HEAD', async function () {
      for (const [version, method] of [[1, 'GET'], [2, 'HEAD']]) {
        const f = await fixture(kind), req = f.request(A, { method });
        try {
          f.action(async (client, text) => {
            if (REQUEST_BEGIN.has(text)) assert.deepEqual(f.events, ['credential-and-audits-finished']);
            if (text === 'SELECT clinical_entries') assert(f.calls.some(x => x.text.includes('anonymous_roles')));
            if (text === 'COMMIT') { assert.equal(req.frame, undefined); assert.equal(authentication.get(req), undefined); }
          });
          assert(await f.access({ tenant: A, request: req, version }));
          oneTransaction(f);
          assert.equal(f.calls.filter(x => x.text.includes('anonymous_roles')).length, 1, 'one fresh current authority SELECT');
          assert.deepEqual(f.events, ['credential-and-audits-finished', 'load', 'publish']);
          assert.equal(req.frame.tenant, A); assert(authentication.get(req));
        } finally { await f.close(); }
      }
    });
  }
  it('reads current metadata and roles on every request and refuses removed subjects before clinical SQL', async function () {
    for (const [kind, field, code] of [['root', 'metadata', 'TENANT_AUTHORITY_UNKNOWN'],
      ['anonymous', 'anonymous', 'TENANT_LEGACY_FORBIDDEN'], ['api-secret-subject', 'subject', 'TENANT_LEGACY_FORBIDDEN'],
      ['legacy-subject', 'subject', null], ['api-secret-subject', 'role', 'TENANT_LEGACY_FORBIDDEN']]) {
      const f = await fixture(kind);
      try {
        assert(await f.access({ tenant: A, request: f.request(), version: 1 }));
        if (field === 'role') f.states.set(A, false); else f.state[field] = false;
        f.calls.length = 0; f.events.length = 0; const req = f.request();
        if (code) await assert.rejects(f.access({ tenant: A, request: req, version: 1 }), { code });
        else assert.equal(await f.access({ tenant: A, request: req, version: 1 }), null);
        assert(!f.events.includes('load')); assert.equal(req.frame, undefined); assert.equal(authentication.get(req), undefined);
        assert(f.calls.some(x => x.text.includes('anonymous_roles')), 'current metadata re-read');
        if (field === 'role') f.states.set(A, true); else f.state[field] = true;
        assert(await f.access({ tenant: A, request: f.request(), version: 1 }));
      } finally { await f.close(); }
    }
  });
  it('keeps failed root verification outside the joined transaction', async function () {
    const f = await fixture('root');
    try {
      f.state.credential = false; const req = f.request();
      assert.equal(await f.access({ tenant: A, request: req, version: 1 }), null);
      assert.deepEqual(f.calls, []); assert.equal(req.frame, undefined); assert.equal(authentication.get(req), undefined);
    } finally { await f.close(); }
  });
  it('rolls back without publication or binding on authority, data, COMMIT and transport failure', async function () {
    for (const kind of ['root', 'anonymous', 'api-secret-subject']) for (const phase of ['authority', 'SELECT clinical_entries', 'COMMIT', 'transport']) {
      const f = await fixture(kind), req = f.request(), failure = Error('synthetic ' + phase);
      try {
        f.action(async (client, text) => {
          if (phase === 'authority' && text.includes('anonymous_roles')) throw failure;
          if (phase === 'transport' && text === 'COMMIT') client.emit('error', failure);
          if (text === phase) throw failure;
        });
        await assert.rejects(f.access({ tenant: A, request: req, version: 1 }));
        assert(f.calls.some(x => x.text === 'ROLLBACK'));
        assert.equal(req.frame, undefined); assert.equal(authentication.get(req), undefined); assert(!f.events.includes('publish'));
      } finally { await f.close(); }
    }
  });
  it('isolates alternating tenants and refuses foreign registration or connection capability', async function () {
    const f = await fixture('root');
    try {
      for (const tenant of [A, B, A]) {
        f.calls.length = 0; const req = f.request(tenant);
        assert(await f.access({ tenant, request: req, version: 1 })); oneTransaction(f);
        assert.equal(req.frame.tenant, tenant);
        assert(f.calls.filter(x => x.text.includes('anonymous_roles')).every(x => x.values[0] === tenant));
      }
      for (const req of [f.request(B), f.request(A, { foreignConnection: true })]) {
        f.events.length = 0; assert(await f.access({ tenant: A, request: req, version: 1 }));
        assert(!f.events.includes('load')); assert.equal(req.frame, undefined);
      }
      assert.throws(() => accessImplementation()({ authority: f.authority, readConnection: { ...f.connection },
        secrets: { verifyLegacyCredential: async () => null }, verifierContext: async () => null }), /must own the same connection/);
    } finally { await f.close(); }
  });
  // The ns-access+jwt data token authority is retired (decision deployment-signing-secret).
  it('excludes writes, v3, OPTIONS and human-session snapshot authorities', async function () {
    for (const [kind, method, version, path] of [['root', 'POST', 1, '/entries'], ['root', 'GET', 3, '/entries'],
      ['root', 'OPTIONS', 1, '/entries'], ['human', 'GET', 1, '/entries']]) {
      const f = await fixture(kind), req = f.request(A, { method, path });
      try {
        assert(await f.access({ tenant: A, request: req, version }));
        assert(!f.events.includes('load')); assert.equal(req.frame, undefined);
        if (kind === 'human') {
          assert.equal(f.calls.length, 0, 'operation-local token/session authority retained');
          assert.deepEqual(f.events, [kind + '-current-authority']);
        }
      } finally { await f.close(); }
    }
  });
  it('control: the original legacy-subject restriction restores a second transaction for raw root entries', async function () {
    const f = await fixture('root', s => s.replace('if (joinedRead && currentAuthority === authority) {', 'if (joinedRead && legacySubject) {'));
    try {
      const req = f.request(); assert(await f.access({ tenant: A, request: req, version: 1 }));
      assert.equal(req.frame, undefined); assert(!f.events.includes('load'));
      await scope.withTenant(A, () => f.connection.query('SELECT clinical_entries'));
      assert.equal(f.calls.filter(x => REQUEST_BEGIN.has(x.text)).length, 2);
      assert.throws(() => oneTransaction(f), /AUTHORITY_AND_ENTRY_ONE_TRANSACTION/);
      console.log('JOINED_AUTHORITY_CONTROL old-root-transactions=2 expected=1 RED');
    } finally { await f.close(); }
    const restored = await fixture('root');
    try {
      assert(await restored.access({ tenant: A, request: restored.request(), version: 1 }));
      oneTransaction(restored);
      console.log('JOINED_AUTHORITY_CONTROL restored-root-transactions=1 GREEN');
    } finally { await restored.close(); }
  });
});
