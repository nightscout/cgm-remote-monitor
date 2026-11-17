'use strict';
const assert = require('node:assert/strict');
const recovery = require('../lib/pgstream/snapshot-recovery');
const TENANT = '11111111-1111-4111-8111-111111111111';
const mainSource = { system_id: '123456', timeline: 1, database: 'synthetic', slot: 'main_stream' };
function fixture (overrides = {}) {
  const calls = [], clients = [], imported = [];
  let generation = 'epoch:3';
  function client (kind) {
    const value = { on () {}, async connect () { calls.push(kind + ':connect'); }, async end () { calls.push(kind + ':end'); }, async query (sql, params) {
      calls.push([kind, sql, params]);
      if (overrides.query) { const result = await overrides.query(kind, sql, params); if (result) return result; }
      if (sql.startsWith('SELECT NOT EXISTS')) return { rows: [{ absent: true }] };
      if (sql === 'IDENTIFY_SYSTEM') return { rows: [{ systemid: '123456', timeline: '1', dbname: 'synthetic' }] };
      if (sql.startsWith('CREATE_REPLICATION_SLOT')) return { rows: [{ slot_name: sql.split(' ')[1], output_plugin: 'wal2json', snapshot_name: '00000001-00000002-1', consistent_point: '0/123' }] };
      return { rows: [] };
    } }; clients.push(value); return value;
  }
  const connection = { async importedSnapshotTransaction (name, fn, options) {
    imported.push({ name, options }); calls.push('import');
    if (overrides.import) return overrides.import(fn, options);
    return fn();
  } };
  const coordinator = recovery.create({ connection, createReplicationClient: () => client('export'), createLockClient: () => client('lock'), namespace: 'checkpoint', consumer: 'evaluator-test', mainSource,
    generation: async () => generation, timeoutMs: 1000, ...overrides.options });
  return { coordinator, calls, clients, imported, setGeneration: value => { generation = value; } };
}
describe('exact clinical snapshot recovery coordinator', function () {
  it('locks before export, imports the exact name and retains main source identity', async function () {
    const f = fixture();
    const result = await f.coordinator.withSnapshot({ tenant: TENANT, fn: async descriptor => {
      assert.deepEqual(descriptor, { source_identity: mainSource, generation: 'epoch:3', snapshot_position: '0/123' });
      assert(!f.calls.includes('export:end')); return 'seeded';
    } });
    assert.equal(result, 'seeded');
    assert.equal(f.imported[0].name, '00000001-00000002-1');
    const sql = f.calls.filter(Array.isArray);
    assert.equal(sql[0][1], 'SELECT pg_advisory_lock($1::bigint)');
    assert.equal(sql[0][2][0], recovery.lockKey('checkpoint', 'evaluator-test'));
    assert.deepEqual(sql.slice(1).filter(row => !row[1].startsWith('SELECT NOT EXISTS')).map(row => row[1].split(' ')[0]), ['IDENTIFY_SYSTEM', 'CREATE_REPLICATION_SLOT']);
    assert(f.calls.includes('export:end')); assert(f.calls.includes('lock:end'));
    await f.coordinator.close();
  });
  it('refuses a changed source before exporting or calling the seed', async function () {
    const f = fixture({ query: async (kind, sql) => sql === 'IDENTIFY_SYSTEM' ? { rows: [{ systemid: '999', timeline: 1, dbname: 'synthetic' }] } : null });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('source mismatch reached seed') }), /SOURCE_CHANGED/);
    assert(!f.calls.some(row => Array.isArray(row) && row[1].startsWith('CREATE_REPLICATION_SLOT')));
    assert(f.calls.includes('export:end')); assert(f.calls.includes('lock:end'));
    await f.coordinator.close();
  });
  it('refuses importer loss and drops its exporter and lock without a fresh-view fallback', async function () {
    const f = fixture({ import: async () => { throw Error('importer lost'); } });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('lost import reached seed') }), /importer lost/);
    assert.equal(f.imported.length, 1); assert(f.calls.includes('export:end')); assert(f.calls.includes('lock:end'));
    await f.coordinator.close();
  });
  it('bounds blocked export and allows a later independent attempt after deadline cleanup', async function () {
    let block = true;
    const f = fixture({ options: { timeoutMs: 20 }, query: async (kind, sql) => { if (sql.startsWith('CREATE_REPLICATION_SLOT') && block) return new Promise(() => {}); } });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('blocked export reached seed') }), /DEADLINE/);
    assert(f.calls.includes('export:end')); assert(f.calls.includes('lock:end'));
    block = false;
    assert.equal(await f.coordinator.withSnapshot({ tenant: TENANT, fn: () => 'recovered' }), 'recovered');
    await f.coordinator.close();
  });
  it('aborts an imported transaction at the deadline and never accepts its late result', async function () {
    let finish;
    const f = fixture({ options: { timeoutMs: 20 }, import: async (fn, options) => {
      return new Promise((resolve, reject) => { finish = resolve; options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
    } });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('unreached') }), /DEADLINE/);
    assert(f.imported[0].options.signal.aborted); finish('late seed');
    await f.coordinator.close();
  });
  it('refuses generation change before seed persistence', async function () {
    let f;
    f = fixture({ import: async fn => { f.setGeneration('epoch:4'); return fn(); } });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('changed generation reached seed') }), /GENERATION_CHANGED/);
    assert(f.calls.includes('export:end')); await f.coordinator.close();
  });
  it('closes recovery admission if exact slot cleanup cannot be confirmed', async function () {
    const f = fixture({ query: async (kind, sql) => sql.startsWith('SELECT NOT EXISTS') ? { rows: [{ absent: false }] } : null });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => 'seeded' }), /CLEANUP_UNCONFIRMED/);
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => assert.fail('uncertain cleanup reopened') }), /CLOSED/);
    await f.coordinator.close();
  });
  it('limits queued recovery and closes an active blocked export', async function () {
    const f = fixture({ options: { maxQueued: 1 }, query: async (kind, sql) => { if (sql.startsWith('CREATE_REPLICATION_SLOT')) return new Promise(() => {}); } });
    const entered = f.coordinator.withSnapshot({ tenant: TENANT, fn: () => {} });
    await assert.rejects(f.coordinator.withSnapshot({ tenant: TENANT, fn: () => {} }), /QUEUE_BOUND/);
    await new Promise(resolve => setImmediate(resolve));
    const closing = f.coordinator.close();
    await assert.rejects(entered, /CLOSED/); await closing;
    assert(f.calls.includes('export:end')); assert(f.calls.includes('lock:end'));
  });
});
