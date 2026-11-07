'use strict';
// Actual constructors/resolver/handlers over a bounded SQL recording protocol.
// No listener, migration, database, or native transaction claim.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const scope = require('../lib/storage/tenant-scope');
const reads = require('../lib/server/storage-reads');
const domains = require('../lib/server/serve/postgres-domains');
const A = '11111111-1111-4111-8111-111111111111';
const names = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
function connection () {
  const queries = [], events = []; let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { entered = resolve; });
  let held = false;
  return { queries, events, writing, release, hold () { held = true; },
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
    async transaction (fn) { events.push('BEGIN'); const result = await fn(); if (held) { entered(); await gate; } events.push('COMMIT'); return result; },
    withSavepoint: fn => fn(),
    async query (sql, values) {
      queries.push({ sql, values });
      if (sql.includes("current_setting('server_version')")) return { rows: [{ version: 'source-protocol' }] };
      if (sql.startsWith('INSERT INTO')) { events.push('INSERT'); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith('SELECT')) return { rows: [] };
      throw new Error('Unexpected source protocol SQL');
    }
  };
}
async function withOrderPort (fn) {
  const migration = require('../lib/migrations/postgres'), old = migration.run, checks = [];
  migration.run = async (action, options) => { checks.push({ action, options }); };
  delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')];
  try { return await fn(require('../lib/server/tenant-socket-order-port'), checks); }
  finally { migration.run = old; delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')]; }
}
const env = () => ({ extendedSettings: {}, enable: [], settings: {}, serverSettings: {} });
async function preview (conn, socketForwarding = true) {
  return require('../lib/server/serve/preview-domains')({ connection: conn, config: {
    domains: names, bindings: new Map([[A, {}]]), environments: new Map([[A, env()]]),
    namespaces: Object.fromEntries(names.map(name => [name, 'source_' + name])),
    readinessConnectionString: 'postgres://synthetic-source-only', socketForwarding,
    legacyEnabled: false, contextEnabled: false
  } });
}
const operation = (logical, permissions = { read: true, write: true, write_treatment: true }) => ({ tenant: A,
  source: 'socket', namespace: '/', event: 'dbAdd', actor: { tenant: A, permissions }, args: [{ collection: logical, data: {
    _id: 'synthetic-' + logical, created_at: '2026-11-07T00:00:00.000Z',
    ...(logical === 'entries' ? { type: 'sgv', sgv: 111, date: 1794009600000 } : {}),
    ...(logical === 'treatments' ? { eventType: 'Note', notes: 'synthetic' } : {}),
    ...(logical === 'devicestatus' ? { device: 'synthetic' } : {}),
    ...(logical === 'profile' ? { NSCLIENT_ID: 'synthetic', startDate: '2026-11-07', store: { Synthetic: { dia: 3 } } } : {}),
    ...(logical === 'food' ? { name: 'Synthetic', carbs: 10 } : {}),
    ...(logical === 'activity' ? { type: 'activity', duration: 10 } : {})
  } }] });
describe('actual preview six-domain trusted socket port composition', function () {
  it('leaves the unselected preview without socket binding or order-catalogue checks', async function () {
    const old = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try { await withOrderPort(async (ordered, checks) => {
      const graph = await preview(connection(), false);
      assert.equal(checks.length, 0);
      assert.throws(() => graph.socketContextFor(operation('entries')), /Socket context refused/);
    }); } finally { scope.setTenancyMode(old); }
  });
  it('characterizes raw T/D/activity steps versus wrapper entries/profile/food without weakening resolver', async function () {
    await withOrderPort(async (ordered, checks) => {
      for (const logical of names) {
        const conn = connection(), options = { connection: conn, table: 'source_' + logical + '.' + logical, logical, bus: new EventEmitter(), env: env(), source: 'socket' };
        const port = ['treatments', 'devicestatus', 'profile'].includes(logical)
          ? await ordered({ ...options, namespace: 'source_' + logical, readinessConnectionString: 'postgres://synthetic-source-only' })
          : logical === 'activity' ? require('../lib/storage/postgres-collection-intent')(options) : domains.get(logical).factory(options);
        assert.equal(typeof port.storage.findFiltered, 'function');
        const raw = ['treatments', 'devicestatus', 'activity'].includes(logical);
        assert.equal(typeof port.intentFactory, raw ? 'undefined' : 'function', logical);
        if (raw) {
          assert.equal(typeof port.plan, 'function'); assert.equal(typeof port.write, 'function');
          assert.throws(() => reads.intent({ storagePorts: { resolve: () => port } }, logical, 'socket', {}, () => assert.fail('no fallback')), /Trusted storage port is unavailable/);
        }
      }
      assert.equal(checks.length, 3); for (const check of checks) assert.equal(check.action, 'check');
      await assert.rejects(ordered({ logical: 'unknown' }), /reviewed DATA domain/);
    });
  });
  it('binds all actual six ports to the strict resolver and canonical executor, with exact socket source and after-COMMIT replies', async function () {
    const old = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try { await withOrderPort(async (ordered, checks) => {
      const conn = connection(), graph = await preview(conn);
      const execute = require('../lib/server/tenant-socket-write-executor').createExecutor({ contextForOperation: graph.socketContextFor });
      for (const logical of names) {
        const op = operation(logical), context = graph.socketContextFor(op);
        assert.equal(context.authorizationFor(), op.actor.permissions, 'COMPOSED_CURRENT_SOCKET_AUTHORITY_' + logical);
        const step = reads.intent(context.ctx, logical, 'socket', {}, () => assert.fail('no Mongo fallback'));
        assert.equal(typeof step.plan, 'function', 'COMPOSED_SOCKET_STEP_' + logical);
        assert.equal(step.storage, reads.collection(context.ctx, context.env, logical, logical, { source: 'socket' }));
        const before = conn.events.length, reply = await execute(op);
        assert.equal(reply[0].length, 1, 'COMPOSED_SOCKET_CANONICAL_REPLY_' + logical);
        assert.equal(reply[0][0]._id, 'synthetic-' + logical);
        assert(conn.events.slice(before).includes('INSERT'), 'COMPOSED_SOCKET_INSERT_' + logical);
        assert.equal(conn.events.at(-1), 'COMMIT', 'COMPOSED_SOCKET_COMMIT_' + logical);
      }
      assert.equal(checks.length, 3);
      assert(checks.every(check => check.options.catalogue === ordered.catalogues[check.options.namespace.replace('source_', '')]));
      const context = graph.socketContextFor(operation('entries'));
      assert.throws(() => reads.intent(context.ctx, 'unknown', 'socket', {}, () => assert.fail('no fallback')), /Trusted storage port is unavailable/);
      assert.throws(() => graph.socketContextFor({ ...operation('entries'), actor: { tenant: 'foreign' } }), /Socket context refused/);
      const inserts = conn.queries.filter(query => query.sql.startsWith('INSERT INTO'));
      assert.equal(inserts.length, 6); assert(inserts.every(query => query.sql.includes("current_setting('app.current_tenant_id'")));
      conn.hold(); let replied = false;
      const pending = execute(operation('activity')).then(reply => { replied = true; return reply; });
      await conn.writing; assert.equal(replied, false, 'COMPOSED_SOCKET_NO_PRECOMMIT_REPLY'); conn.release();
      assert.equal((await pending)[0].length, 1); assert.equal(replied, true);
    }); } finally { scope.setTenancyMode(old); }
  });
});
