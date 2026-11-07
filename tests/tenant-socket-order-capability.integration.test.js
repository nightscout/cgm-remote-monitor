'use strict';

// Optional successor experiment only. Not transparent mixed-version admission.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const createOrderPort = require('../lib/server/tenant-socket-order-port');
const createPort = require('../lib/storage/postgres-collection-intent');
const reads = require('../lib/server/storage-reads');
const { optInSuite } = require('./support/opt-in');
const A = '11111111-1111-4111-8111-111111111111';
const old = { treatments: require('../migrations/candidates/postgres-treatments-v1.json'),
  devicestatus: require('../migrations/candidates/postgres-devicestatus-v1.json') };

optInSuite(process.env.NS_SOCKET_ORDER_CAPABILITY_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_SOCKET_ORDER_CAPABILITY_TEST=1 with disposable PostgreSQL')('optional socket order catalogue characterization', function () {
  this.timeout(30000);
  let admin;
  const namespaces = [];
  const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
  const options = (logical, successor = false) => {
    const namespace = 'socket_order_test_' + crypto.randomBytes(8).toString('hex');
    namespaces.push(namespace);
    return { direct: true, connectionString: uri, namespace,
      catalogue: successor ? createOrderPort.catalogues[logical] : old[logical] };
  };
  const connection = { query: (...args) => admin.query(...args), transaction: fn => fn() };
  const selected = (o, logical) => createOrderPort({ readinessConnectionString: uri, namespace: o.namespace, logical, connection });
  const insert = (o, logical, id) => admin.query(`INSERT INTO "${o.namespace}"."${logical}"(tenant_id,id_kind,doc) VALUES($1,'string',$2::jsonb)`,
    [A, JSON.stringify({ _id: id, eventType: 'Note', created_at: '2026-11-06T00:00:00.000Z' })]);
  before(async () => {
    assert.match(new URL(uri).pathname, /test/i);
    admin = new Client({ connectionString: uri }); await admin.connect();
  });
  after(async () => {
    try { for (const namespace of namespaces) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); }
    finally { if (admin) await admin.end(); }
  });

  it('measures the old/new startup matrix and refuses selected capability before binding on an old ledger', async () => {
    for (const logical of Object.keys(old)) {
      const o = options(logical); await run('up', o);
      assert.equal((await run('check', o)).current, true);
      const successor = { ...o, catalogue: createOrderPort.catalogues[logical] };
      await assert.rejects(run('check', successor), { code: 'MIG_STALE' });
      await assert.rejects(selected(o, logical), { code: 'MIG_STALE' });
      await run('up', successor);
      assert.equal((await run('check', successor)).current, true);
      await selected(o, logical);
      // Existing exact-prefix inspector deliberately refuses an unknown upgrade.
      await assert.rejects(run('check', o), { code: 'MIG_UNKNOWN' });
    }
  });

  it('refuses populated upgrade atomically without assigning past order or changing rows, columns or ledger', async () => {
    for (const logical of Object.keys(old)) {
      const o = options(logical); await run('up', o); await insert(o, logical, 'existing');
      const before = await admin.query(`SELECT id_kind,doc FROM "${o.namespace}"."${logical}"`);
      await assert.rejects(run('up', { ...o, catalogue: createOrderPort.catalogues[logical] }), error => {
        for (let cause = error; cause; cause = cause.cause) if (cause.code === '23514') return true;
        return false;
      });
      assert.deepEqual((await admin.query(`SELECT id_kind,doc FROM "${o.namespace}"."${logical}"`)).rows, before.rows);
      assert.equal((await run('check', o)).current, true);
      const columns = await admin.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name=$2',
        [o.namespace, 'insertion_ordinal']);
      assert.deepEqual(columns.rows, []);
      const guard = await admin.query('SELECT 1 FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname=$2',
        [o.namespace, 'socket_order_requires_empty']);
      assert.deepEqual(guard.rows, []);
    }
  });

  it('retains generated fresh insertion order through edits and keeps unselected bounded-read refusal', async () => {
    for (const logical of Object.keys(old)) {
      const o = options(logical, true); await run('up', o);
      await insert(o, logical, 'z-first'); await insert(o, logical, 'a-second');
      const ordinals = await admin.query(`SELECT "_id",insertion_ordinal FROM "${o.namespace}"."${logical}" ORDER BY insertion_ordinal`);
      assert.deepEqual(ordinals.rows.map(row => row._id), ['z-first', 'a-second']);
      assert(BigInt(ordinals.rows[0].insertion_ordinal) < BigInt(ordinals.rows[1].insertion_ordinal));
      await admin.query(`UPDATE "${o.namespace}"."${logical}" SET doc=doc || '{"notes":"synthetic-edit"}'::jsonb WHERE "_id"='z-first'`);
      assert.deepEqual((await admin.query(`SELECT "_id",insertion_ordinal FROM "${o.namespace}"."${logical}" ORDER BY insertion_ordinal`)).rows, ordinals.rows);
      const port = await selected(o, logical);
      assert.equal((await reads.findOne(port.storage, { eventType: 'Note' }))._id, 'z-first');
      const unselected = createPort({ connection, table: o.namespace + '.' + logical, logical, source: 'socket' });
      await assert.rejects(reads.findOne(unselected.storage, { eventType: 'Note' }), /without a sort/);
      const explicit = await reads.find(unselected.storage, reads.toFilter({}), { sort: { _id: 1 } });
      assert.deepEqual(explicit.map(row => row._id), ['a-second', 'z-first']);
    }
  });
});
