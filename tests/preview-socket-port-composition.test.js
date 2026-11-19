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
  let held = false, floor = Date.now();
  const raw = { queries, events, writing, release, hold () { held = true; },
    withTenant: (tenant, fn) => scope.withTenant(tenant, fn),
    async transaction (fn) { events.push('BEGIN'); const result = await fn(); if (held) { entered(); await gate; } events.push('COMMIT'); return result; },
    withSavepoint: fn => fn(),
    async query (sql, values) {
      queries.push({ sql, values });
      if (sql.includes("current_setting('server_version')")) return { rows: [{ version: 'source-protocol' }] };
      if (sql.includes('tenant_write_clock')) {
        if (sql.startsWith('SELECT')) return { rows: [{ last_stamp: String(floor) }] };
        if (sql.includes('GREATEST')) { floor = Math.max(floor + 1, values[1]); return { rows: [{ last_stamp: String(floor) }], rowCount: 1 }; }
        assert.equal(values[2], floor, 'CLOCK_UPDATE_MUST_COMPARE_ITS_LOCKED_FLOOR');
        floor = values[0]; return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO')) { events.push('INSERT'); return { rows: [], rowCount: 1 }; }
      if (sql.startsWith('SELECT')) return { rows: [] };
      throw new Error('Unexpected source protocol SQL');
    }
  };
  // Actual history allocator over a recording SQL protocol. These are unit
  // transaction/handler assertions; physical database locking is tested natively.
  return require('../lib/storage/postgres-write-clock')(raw, 'source_clock');
}
async function withOrderPort (fn) {
  const migration = require('../lib/migrations/postgres'), old = migration.run, checks = [];
  migration.run = async (action, options) => { checks.push({ action, options }); if (checks.refuse === options.namespace) throw new Error('SOURCE_ORDER_REFUSED'); };
  delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')];
  try { return await fn(require('../lib/server/tenant-socket-order-port'), checks); }
  finally { migration.run = old; delete require.cache[require.resolve('../lib/server/tenant-socket-order-port')]; }
}
const env = () => ({ extendedSettings: {}, enable: [], settings: {}, serverSettings: {} });
async function preview (conn, socketForwarding = true, verified = false) {
  return require('../lib/server/serve/preview-domains')({ connection: conn, config: {
    ...(verified ? {platformVerification:{namespace:'synthetic_verification',role:'api'}} : {}), domains: names, bindings: new Map([[A, {}]]), environments: new Map([[A, env()]]),
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
      await assert.rejects(graph.socketContextFor(operation('entries')), /Socket context refused/);
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
      assert.equal(checks.length, 0, 'SOCKET_PORT_BUILD_MUST_NOT_REVERIFY_PLATFORM');
      await assert.rejects(ordered({ logical: 'unknown' }), /reviewed DATA domain/);
    });
  });
  it('binds all actual six ports to the strict resolver and canonical executor, with exact socket source and after-COMMIT replies', async function () {
    const old = scope.getTenancyMode(); scope.setTenancyMode('multi');
    try { await withOrderPort(async (ordered, checks) => {
      const conn = connection(), graph = await preview(conn);
      const execute = require('../lib/server/tenant-socket-write-executor').createExecutor({ contextForOperation: graph.socketContextFor });
      for (const logical of names) {
        const op = operation(logical), context = await graph.socketContextFor(op);
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
      assert.equal(checks.length, 0, 'SOCKET_OPERATIONS_MUST_NOT_REVERIFY_PLATFORM');
      const context = await graph.socketContextFor(operation('entries'));
      assert.throws(() => reads.intent(context.ctx, 'unknown', 'socket', {}, () => assert.fail('no fallback')), /Trusted storage port is unavailable/);
      await assert.rejects(graph.socketContextFor({ ...operation('entries'), actor: { tenant: 'foreign' } }), /Socket context refused/);
      const inserts = conn.queries.filter(query => query.sql.startsWith('INSERT INTO'));
      assert.equal(inserts.length, 6); assert(inserts.every(query => query.sql.includes("current_setting('app.current_tenant_id'")));
      conn.hold(); let replied = false;
      const pending = execute(operation('activity')).then(reply => { replied = true; return reply; });
      await conn.writing; assert.equal(replied, false, 'COMPOSED_SOCKET_NO_PRECOMMIT_REPLY'); conn.release();
      assert.equal((await pending)[0].length, 1); assert.equal(replied, true);
    }); } finally { scope.setTenancyMode(old); }
  });
  it('selected socket context uses the existing async executor boundary and constructs only its addressed domain', async function () {
    const old=scope.getTenancyMode();scope.setTenancyMode('multi');
    try { await withOrderPort(async (ordered, checks) => {
      const conn=connection(),graph=await preview(conn,true,true),execute=require('../lib/server/tenant-socket-write-executor').createExecutor({contextForOperation:graph.socketContextFor});
      assert.equal(checks.length,0,'PRIMER_MUST_NOT_CONSTRUCT_UNUSED_SOCKET_PORTS');
      await assert.rejects(graph.socketContextFor({...operation('entries'),actor:{tenant:'foreign'}}),/Socket context refused/);assert.equal(checks.length,0);
      for(const logical of names){const before=conn.events.length,reply=await execute(operation(logical));assert.equal(reply[0][0]._id,'synthetic-'+logical);assert(conn.events.slice(before).includes('INSERT'));assert.equal(conn.events.at(-1),'COMMIT');}
      assert.equal(checks.length,0);await execute(operation('treatments'));assert.equal(checks.length,0,'SOCKET_PORT_MUST_NOT_REVERIFY_PLATFORM');
    }); } finally {scope.setTenancyMode(old);}
  });
  it('refuses a foreign actor before mutation and constructs the restored authorized port without a platform check', async function () {
    const old=scope.getTenancyMode();scope.setTenancyMode('multi');
    try { await withOrderPort(async (ordered, checks) => {
      const conn=connection(),graph=await preview(conn,true,true),execute=require('../lib/server/tenant-socket-write-executor').createExecutor({contextForOperation:graph.socketContextFor});
      await assert.rejects(execute({...operation('treatments'),actor:{tenant:'foreign'}}), /SOCKET_FORWARD_MESSAGE_REFUSED/);
      assert.equal(conn.events.includes('INSERT'),false,'FOREIGN_SOCKET_CONTEXT_MUST_NOT_WRITE');
      checks.refuse='source_treatments';
      const reply=await execute(operation('treatments'));assert.equal(reply[0][0]._id,'synthetic-treatments');
      assert.equal(checks.length,0,'ADMIN_VERIFICATION_IS_NOT_A_SOCKET_CONSTRUCTOR');assert.equal(conn.events.at(-1),'COMMIT');
    }); } finally {scope.setTenancyMode(old);}
  });

});
