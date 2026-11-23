'use strict';

// INC-U: equality unique indexes over the treatments fallback key
// (lib/storage/treatment-key-index.js) and the set-based re-send path
// (NS_TREATMENT_KEY_UPSERT, postgres-entries-write.js deferKeyed). Actual
// PostgreSQL, the clock-port fixture with the socket-order catalogues, late
// stamp on in every arm (the path builds on it).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const pg = require('pg');
const scope = require('../lib/storage/tenant-scope');
const lateStamp = require('../lib/storage/late-stamp');
const keyIndex = require('../lib/storage/treatment-key-index');
const createLab = require('./fixtures/tenant-commit-clock-port');
const holdProbe = require('./support/clock-hold-probe');
const { optInSuite } = require('./support/opt-in');

const RESERVE = 'GREATEST(last_stamp + $2::bigint';
const WRITE_FILE = path.resolve(__dirname, '../lib/storage/postgres-entries-write.js');
const INTENT_FILE = path.resolve(__dirname, '../lib/storage/postgres-collection-intent.js');

// A collection-intent module whose writer carries edits (red controls): [from, to] pairs.
function brokenIntent (...edits) {
  let source = fs.readFileSync(WRITE_FILE, 'utf8');
  for (const [from, to] of edits) {
    assert.equal(source.split(from).length, 2, 'The red edit must apply exactly once');
    source = source.replace(from, to);
  }
  const writeModule = new Module(WRITE_FILE, module);
  writeModule.filename = WRITE_FILE;
  writeModule.paths = Module._nodeModulePaths(path.dirname(WRITE_FILE));
  writeModule._compile(source, WRITE_FILE);
  const saved = require.cache[WRITE_FILE];
  const savedIntent = require.cache[INTENT_FILE];
  try {
    require.cache[WRITE_FILE] = writeModule;
    delete require.cache[INTENT_FILE];
    return require(INTENT_FILE);
  } finally {
    require.cache[WRITE_FILE] = saved;
    require.cache[INTENT_FILE] = savedIntent;
  }
}
// The arbiter on the primary key, and (INC-U2) the validation's decline
// removed, so the statement alone decides as it did in INC-U.
const PK_ARBITER = brokenIntent(["const target = cls === '_id' ? '(tenant_id, id_kind, \"_id\")' : keyIndex.conflictTarget(cls);",
  "const target = '(tenant_id, id_kind, \"_id\")';"], ['    if (await lateStamp.lock()) return null;\n    let written;', '    await lateStamp.lock();\n    let written;']);
const createLegacy = require('../lib/storage/postgres-collection-intent');

const T0 = Date.UTC(2026, 10, 20);
const at = k => new Date(T0 + k * 300000).toISOString();
const hex = n => n.toString(16).padStart(24, '0');

// One batch per client class of the dedup handoff's table (synthetic values).
const CLIENTS = {
  loop: k => ({ eventType: 'Correction Bolus', insulin: 0.05 * (k + 1), created_at: at(k), syncIdentifier: 'loop-sync-' + k, enteredBy: 'synthetic-loop' }),
  trio: k => ({ eventType: 'Meal Bolus', insulin: 0.1, carbs: 5 + k, created_at: at(k), id: 'trio-id-' + k, enteredBy: 'synthetic-trio' }),
  xdrip: k => ({ _id: hex(0xd000 + k), uuid: 'xdrip-uuid-' + k, eventType: 'Carb Correction', carbs: 10 + k, created_at: at(k), enteredBy: 'synthetic-xdrip' }),
  careportal: k => ({ eventType: 'Carb Correction', carbs: 15 + k, created_at: at(k), enteredBy: 'synthetic-careportal' }),
  nsclient: k => ({ eventType: 'Note', notes: 'n' + k, created_at: at(k), NSCLIENT_ID: 'nsc-' + k, enteredBy: 'synthetic-nsclient' })
};
const batchOf = (client, from, count, change = {}) => Array.from({ length: count }, (_, i) => Object.assign(CLIENTS[client](from + i), change));

optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_COMMIT_CLOCK_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'treatments fallback-key unique indexes (INC-U)', function () {
    this.timeout(180000);
    const lab = createLab({ replicas: 2 });
    Object.assign(lab.catalogues, require('../lib/server/tenant-socket-order-port').catalogues);
    const saved = {};
    const table = () => lab.namespaces.treatments + '.treatments';
    before(() => lab.open());
    beforeEach(async () => {
      for (const name of [lateStamp.SWITCH, keyIndex.SWITCH]) saved[name] = process.env[name];
      process.env[lateStamp.SWITCH] = '1';
      await lab.reset();
      await buildIndexes();
    });
    afterEach(() => {
      for (const name of Object.keys(saved)) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    });
    after(() => lab.close());

    async function buildIndexes () {
      const status = await keyIndex.ensure(lab.admin, table(), 'try', { log: { warn () {} } });
      keyIndex.forget();
      return status;
    }
    async function dropIndexes () {
      for (const cls of keyIndex.CLASSES) {
        await lab.admin.query(`DROP INDEX IF EXISTS "${lab.namespaces.treatments}"."${keyIndex.indexName('treatments', cls)}"`);
      }
      keyIndex.forget();
    }
    // An owner write bound to tenant A (the insertion-ordinal trigger requires the binding).
    async function asTenant (sql, params) {
      await lab.admin.query('BEGIN');
      try {
        await lab.admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [lab.A]);
        await lab.admin.query(sql, params);
        await lab.admin.query('COMMIT');
      } catch (error) { await lab.admin.query('ROLLBACK'); throw error; }
    }
    const setKeyed = on => { process.env[keyIndex.SWITCH] = on ? '1' : '0'; };
    const port = (connection, source = 'v1/internal', factory = createLegacy) => factory({ connection, table: table(), logical: 'treatments', source });
    const writeBatch = (docs, { clock = lab.clocks[0], factory } = {}) => scope.withTenant(lab.A, async () => {
      const p = port(clock, 'v1/internal', factory);
      const planned = p.plan({ op: 'create', form: 'batch', docs });
      const written = await p.write(planned);
      return { docs: planned.docs, items: written.items };
    });
    const stored = async () => (await lab.admin.query(
      `SELECT id_kind, doc FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1 ORDER BY insertion_ordinal`, [lab.A])).rows.map(r => r.doc);

    // An arm's observable outcome, with _ids and stamps replaced by what they
    // name, so two arms (different random ObjectIds) compare equal.
    async function scenario (steps) {
      await lab.reset();
      const observed = [];
      const firstCreated = new Map();
      for (const step of steps) {
        const { docs, items } = await writeBatch(step());
        const rows = await stored();
        const name = id => {
          const k = rows.findIndex(row => row._id === String(id));
          return k < 0 ? 'missing:' + String(id).length : 'row' + k;
        };
        observed.push({
          items: items.map(item => item.outcome),
          reply: docs.map(doc => name(doc._id)),
          rows: rows.map((row, k) => {
            const { _id, srvCreated, srvModified, ...rest } = row;
            if (!firstCreated.has(k)) firstCreated.set(k, srvCreated);
            return { rest, sentId: /^0{8}/.test(_id) ? _id : 'server', carried: srvCreated === firstCreated.get(k), ordered: srvModified >= srvCreated };
          })
        });
      }
      return observed;
    }

    it('census and build: equal live keys are marked exempt (all but the earliest), every class builds, drop restores the table', async function () {
      await dropIndexes();
      const census = await keyIndex.census(lab.admin, table());
      assert.equal(census.tenants.length, 0);
      // Two careportal rows with one key, two Loop rows with one syncIdentifier key, written while no index exists.
      setKeyed(false);
      await writeBatch([CLIENTS.careportal(1)]);
      await asTenant(`INSERT INTO "${lab.namespaces.treatments}".treatments (tenant_id,id_kind,doc) SELECT tenant_id,'objectid',doc || jsonb_build_object('_id',$2::text) FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1`,
        [lab.A, hex(0xbeef)]);
      await writeBatch([CLIENTS.loop(2)]);
      await asTenant(`INSERT INTO "${lab.namespaces.treatments}".treatments (tenant_id,id_kind,doc) SELECT tenant_id,'objectid',doc || jsonb_build_object('_id',$2::text,'enteredBy','other') FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1 AND doc ? 'syncIdentifier'`,
        [lab.A, hex(0xbee0)]);
      // A soft-deleted copy and an array-valued key are not counted as collisions.
      await asTenant(`INSERT INTO "${lab.namespaces.treatments}".treatments (tenant_id,id_kind,doc) VALUES ($1,'objectid',$2::jsonb),($1,'objectid',$3::jsonb)`,
        [lab.A, JSON.stringify({ ...CLIENTS.careportal(1), _id: hex(0xdead), isValid: false }),
          JSON.stringify({ ...CLIENTS.careportal(1), _id: hex(0xa77a), eventType: ['Carb Correction'] })]);
      const after = await keyIndex.census(lab.admin, table());
      assert.deepEqual(after.totals.none, { groups: 1, rows: 2, tenants: 1 });
      assert.deepEqual(after.totals.syncIdentifier, { groups: 1, rows: 2, tenants: 1 });
      assert.equal(after.tenants[0].unindexable, 1);
      const docsBefore = (await stored()).map(doc => JSON.stringify(doc));
      // Case 3 without the index: the re-send of the two-row key.
      const refusals = [];
      setKeyed(false);
      await assert.rejects(writeBatch([CLIENTS.careportal(1), CLIENTS.careportal(7)]), error => { refusals.push(error.message); return true; });
      const status = await buildIndexes();
      assert.deepEqual(status.errors, []);
      assert.equal(status.ready, true);
      assert.deepEqual(status.classes.none, { state: 'built', marked: 1, tenants: 1 });
      assert.deepEqual(status.classes.syncIdentifier, { state: 'built', marked: 1, tenants: 1 });
      for (const cls of ['id', 'uuid', 'NSCLIENT_ID']) assert.deepEqual(status.classes[cls], { state: 'built', marked: 0, tenants: 0 });
      const marked = (await lab.admin.query(`SELECT doc->>'_id' AS id FROM "${lab.namespaces.treatments}".treatments WHERE key_exempt ORDER BY 1`)).rows.map(r => r.id);
      assert.deepEqual(marked, [hex(0xbee0), hex(0xbeef)], 'the later copy of each group, not the earliest');
      assert.deepEqual((await stored()).map(doc => JSON.stringify(doc)), docsBefore, 'no document written by the migration');
      const after2 = await keyIndex.census(lab.admin, table());
      assert.deepEqual(after2.totals.none, { groups: 0, rows: 0, tenants: 0 });
      assert.equal(after2.tenants[0].exempt, 2);
      const required = await keyIndex.ensure(lab.admin, table(), 'require');
      assert.deepEqual(required.errors, []);
      // Case 3 with the index, switch off and on: the same answer as without the index.
      for (const on of [false, true]) {
        setKeyed(on);
        await assert.rejects(writeBatch([CLIENTS.careportal(1), CLIENTS.careportal(7)]), error => { refusals.push(error.message); return true; });
      }
      assert.deepEqual(refusals, [refusals[0], refusals[0], refusals[0]]);
      console.log('CASE3_REFUSAL ' + refusals[0]);
      // Reversal: indexes, then the column; documents untouched.
      await keyIndex.drop(lab.admin, table());
      keyIndex.forget();
      assert.deepEqual(await keyIndex.existing(lab.admin, table()), Object.fromEntries(keyIndex.CLASSES.map(c => [c, 'absent'])));
      assert.equal((await keyIndex.columnState(lab.admin, table())).exempt, false);
      assert.deepEqual((await stored()).map(doc => JSON.stringify(doc)), docsBefore);
    });

    it('differential: re-send outcomes per client class are the same switch on and off', async function () {
      const steps = [
        () => [...batchOf('loop', 0, 3), ...batchOf('trio', 0, 3), ...batchOf('xdrip', 0, 3), ...batchOf('careportal', 0, 3), ...batchOf('nsclient', 0, 3)],
        // whole re-send, as sent
        () => [...batchOf('loop', 0, 3), ...batchOf('trio', 0, 3), ...batchOf('xdrip', 0, 3), ...batchOf('careportal', 0, 3), ...batchOf('nsclient', 0, 3)],
        // re-send with changed payload plus new records, mixed order
        () => [...batchOf('careportal', 2, 3, { notes: 'edited' }), ...batchOf('loop', 1, 4, { notes: 'edited' }),
          ...batchOf('xdrip', 2, 2, { notes: 'edited' }), ...batchOf('trio', 2, 2, { notes: 'edited' }), ...batchOf('nsclient', 1, 3)],
        // a careportal record with other amounts at a stored time is a new record
        () => [Object.assign(CLIENTS.careportal(0), { carbs: 99 }), CLIENTS.loop(0)]
      ];
      setKeyed(false);
      const off = await scenario(steps);
      setKeyed(true);
      const original = pg.Client.prototype.query;
      let keyed = 0;
      pg.Client.prototype.query = function (...args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        if (typeof sql === 'string' && sql.includes('ON CONFLICT')) keyed++;
        return original.apply(this, args);
      };
      let on;
      try { on = await scenario(steps); } finally { pg.Client.prototype.query = original; }
      assert.ok(keyed >= 3 * 5, 'the on arm wrote its re-send batches by the keyed statements: ' + keyed);
      assert.deepEqual(on, off);
      assert.equal(off[1].rows.length, 15, 'a whole re-send stores no copy');
      assert.deepEqual(off[1].items, Array(15).fill('replaced'));
      assert.ok(off[1].rows.every(row => row.carried), 'srvCreated carried');
      assert.equal(off[3].rows.length, 15 + 7 + 1);
    });

    it('on: a re-send batch is one keyed statement per run under the clock after the validation read, no per-document fallback', async function () {
      setKeyed(true);
      await writeBatch([...batchOf('loop', 0, 3), ...batchOf('careportal', 0, 3)]);
      const probe = holdProbe(lab.role);
      let log;
      try {
        probe.start();
        await writeBatch([...batchOf('loop', 0, 3), ...batchOf('careportal', 0, 3), ...batchOf('loop', 3, 2)]);
        log = probe.stop();
      } finally { probe.restore(); }
      assert.equal(log.holds.length, 1);
      // reserve, validation read, SAVEPOINT, one INSERT .. ON CONFLICT per run (loop, careportal, loop), RELEASE, COMMIT
      assert.equal(log.holds[0].statements, 8);
    });

    it('gate: a 288-treatment batch with re-sends holds the clock for a fixed number of statements on; off it falls back per document', async function () {
      const probe = holdProbe(lab.role);
      const report = {};
      const sizes = [50, 288];
      try {
        for (const on of [false, true]) {
          setKeyed(on);
          report[on ? 'on' : 'off'] = [];
          for (const size of sizes) {
            await lab.reset();
            // half stored first, then the whole batch: every other record a re-send
            const docs = n => batchOf('loop', 0, n);
            await writeBatch(docs(size).filter((_, k) => k % 2 === 0));
            probe.start();
            const { items } = await writeBatch(docs(size));
            const { holds } = probe.stop();
            assert.equal(holds.length, 1);
            assert.equal(items.filter(item => item.outcome === 'replaced').length, size / 2);
            assert.equal((await stored()).length, size);
            report[on ? 'on' : 'off'].push({ size, statements: holds[0].statements, ms: Math.round(holds[0].ms * 10) / 10 });
          }
        }
      } finally { probe.restore(); }
      console.log('KEYED_RESEND_HOLD ' + JSON.stringify(report));
      // Off (INC-G alone): a batch with any re-send runs the per-document path under the clock.
      assert.ok(report.off[1].statements > 288, 'off: the per-document fallback');
      assert.deepEqual(report.on.map(row => row.statements), [6, 6], 'on: reserve, validation, savepoint, one upsert, release, commit');
      assert.ok(report.on[1].ms * 4 < report.off[1].ms, 'on: a quarter of the off hold or less (INC-U2: the validation read is back under the clock)');
    });

    async function duplicateRace (factory) {
      // one stored record makes both batches re-sends, so INC-G's insert-only path is not taken
      await writeBatch(batchOf('careportal', 0, 1));
      const original = pg.Client.prototype.query;
      const barrier = { count: 2, arrived: 0 };
      let keyed = 0, validated = 0;
      barrier.opened = new Promise(resolve => { barrier.open = resolve; });
      pg.Client.prototype.query = function (...args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        if (typeof sql === 'string' && sql.includes('ON CONFLICT')) keyed++;
        if (typeof sql === 'string' && sql.includes('UNION ALL') || /srvModified" > \$1::numeric/.test(sql || '')) validated++;
        if (this.connectionParameters?.user === lab.role && typeof sql === 'string' && sql.includes(RESERVE)) {
          barrier.arrived++;
          if (barrier.arrived >= barrier.count) barrier.open();
          return barrier.opened.then(() => original.apply(this, args));
        }
        return original.apply(this, args);
      };
      try {
        const docs = () => [...batchOf('careportal', 0, 10), ...batchOf('loop', 0, 10)];
        const outcomes = await Promise.allSettled([writeBatch(docs(), { factory }), writeBatch(docs(), { clock: lab.clocks[1], factory })]);
        assert.equal(barrier.arrived, 2, 'both batches read before either held the clock');
        return { outcomes, rows: await stored(), keyed, validated };
      } finally { pg.Client.prototype.query = original; }
    }

    it('on: two concurrent identical re-send batches store one row per key', async function () {
      setKeyed(true);
      const { outcomes, rows, keyed, validated } = await duplicateRace();
      assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled'], String(outcomes.find(o => o.reason)?.reason?.stack));
      assert.equal(rows.length, 20);
      // The first batch to hold the clock writes keyed (two runs); the second's
      // validation sees the first's rows and declines to the per-document path.
      assert.ok(keyed >= 2, 'the keyed statements ran: ' + keyed);
      assert.ok(validated >= 2, 'each batch validated its reads: ' + validated);
    });

    it('off (control for the counters above): the same race runs INC-G\'s validation and per-document path, one row per key', async function () {
      setKeyed(false);
      const { outcomes, rows, keyed, validated } = await duplicateRace();
      assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled']);
      assert.equal(rows.length, 20);
      assert.equal(keyed, 0);
      assert.ok(validated >= 2, 'the validation read is counted: ' + validated);
    });

    it('red: with the primary key as the arbiter instead of the key index, the same race stores duplicates', async function () {
      setKeyed(true);
      await dropIndexes();
      await lab.admin.query(`CREATE INDEX unrelated ON "${lab.namespaces.treatments}".treatments (tenant_id)`);
      // the runtime believes the classes are indexed; the statement arbitrates on the primary key
      const present = keyIndex.presentClasses;
      keyIndex.presentClasses = async () => new Set(keyIndex.CLASSES);
      try {
        const { outcomes, rows } = await duplicateRace(PK_ARBITER);
        assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled']);
        console.log('RED_PK_ARBITER rows ' + rows.length);
        assert.ok(rows.length > 20, 'the control detects duplicate keys: ' + rows.length);
      } finally {
        keyIndex.presentClasses = present;
        await lab.admin.query(`DROP INDEX "${lab.namespaces.treatments}".unrelated`);
      }
    });

    it('held writer: a later keyed re-send waits on the clock while an earlier batch is uncommitted; commit order is stamp order', async function () {
      setKeyed(true);
      await writeBatch(batchOf('careportal', 0, 10));
      const original = pg.Client.prototype.query;
      let holdPid, reached, release;
      const reachedPromise = new Promise(resolve => { reached = resolve; });
      const released = new Promise(resolve => { release = resolve; });
      pg.Client.prototype.query = function (...args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
        if (this.connectionParameters?.user === lab.role && typeof sql === 'string') {
          if (sql.includes(RESERVE) && holdPid === undefined) holdPid = this.processID;
          if (/^\s*COMMIT/.test(sql) && this.processID === holdPid) { holdPid = null; reached(); return released.then(() => original.apply(this, args)); }
        }
        return original.apply(this, args);
      };
      const baseline = await lab.floor(lab.A);
      let first, second, waited, visible;
      try {
        first = writeBatch([...batchOf('careportal', 10, 5), ...batchOf('careportal', 0, 2, { notes: 'h' })]);
        first.catch(() => {});
        await reachedPromise;
        second = writeBatch(batchOf('careportal', 0, 10, { notes: 'k' }), { clock: lab.clocks[1] });
        second.catch(() => {});
        waited = await lab.waitForClockLock();
        await new Promise(resolve => setTimeout(resolve, 200));
        visible = (await lab.admin.query(`SELECT count(*)::int AS n FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1 AND "srvModified" > $2`, [lab.A, baseline])).rows[0].n;
      } finally {
        release();
        await Promise.allSettled([first, second].filter(Boolean));
        pg.Client.prototype.query = original;
      }
      await first; await second;
      assert.ok(waited.blockers.length > 0, 'the later writer is blocked on the clock row');
      assert.equal(visible, 0, 'nothing above the baseline is visible while the earlier batch is held');
      const rows = await stored();
      assert.equal(rows.length, 15);
      const held = rows.filter(row => row.notes === 'h' || row.created_at >= at(10)), later = rows.filter(row => row.notes === 'k');
      assert.equal(later.length, 10, 'the later re-send replaced every stored record, the two the held batch edited included');
      assert.ok(Math.max(...rows.filter(row => row.created_at >= at(10)).map(row => row.srvModified)) < Math.min(...later.map(row => row.srvModified)));
      assert.ok(held.length >= 5);
    });

    // --- INC-U2: the three cases official/dev stores as two records -------

    for (const [label, indexed, on] of [['index, switch off', true, false], ['index, switch on', true, true], ['no index', false, true]]) {
      it(label + ': case 1, a new 24-hex _id onto a stored no-id key stores a second record, as official/dev', async function () {
        if (!indexed) await dropIndexes();
        setKeyed(on);
        const first = await writeBatch([CLIENTS.careportal(0)]);
        const storedId = String(first.docs[0]._id);
        const { docs, items } = await writeBatch([Object.assign(CLIENTS.careportal(0), { _id: hex(0xc0ffee), notes: 'with id' }), CLIENTS.careportal(5)]);
        const rows = await stored();
        assert.deepEqual(rows.map(row => row._id), [storedId, hex(0xc0ffee), String(docs[1]._id)]);
        assert.equal(rows[0].notes, undefined, 'the stored record is unchanged');
        assert.equal(rows[1].notes, 'with id');
        assert.equal(String(docs[0]._id), hex(0xc0ffee), 'the reply names the client _id');
        assert.deepEqual(items.map(item => item.outcome), ['inserted', 'inserted']);
        if (indexed) {
          const exempt = (await lab.admin.query(`SELECT doc->>'_id' AS id FROM "${lab.namespaces.treatments}".treatments WHERE key_exempt`)).rows.map(r => r.id);
          assert.deepEqual(exempt, [storedId], 'the stored holder of the key was marked; the new row is indexed');
        }
      });
    }

    it('case 2: a PUT or socket edit onto another record\'s key is applied with the index and without it', async function () {
      const outcomes = [];
      for (const indexed of [true, false]) {
        await lab.reset();
        if (indexed) await buildIndexes(); else await dropIndexes();
        setKeyed(true);
        const first = await writeBatch([CLIENTS.careportal(0), Object.assign(CLIENTS.careportal(0), { carbs: 40 }), Object.assign(CLIENTS.careportal(0), { carbs: 41 })]);
        const put = () => scope.withTenant(lab.A, async () => {
          const second = first.docs[1];
          const p = port(lab.clocks[0]);
          return p.write(p.plan({ op: 'update', docs: [Object.assign({}, second, { _id: String(second._id), carbs: CLIENTS.careportal(0).carbs })] }));
        });
        const socket = () => scope.withTenant(lab.A, () => port(lab.clocks[0], 'socket')
          .write({ op: 'update', form: 'merge', target: { _id: String(first.docs[2]._id) }, fields: { carbs: CLIENTS.careportal(0).carbs } }));
        const replies = [];
        for (const edit of [put, socket]) replies.push((await edit()).items.map(item => item.outcome));
        const rows = await stored();
        outcomes.push({ replies, carbs: rows.map(row => row.carbs) });
        if (indexed) {
          const exempt = (await lab.admin.query(`SELECT doc->>'_id' AS id FROM "${lab.namespaces.treatments}".treatments WHERE key_exempt ORDER BY insertion_ordinal`)).rows.map(r => r.id);
          assert.deepEqual(exempt, [String(first.docs[1]._id), String(first.docs[2]._id)], 'the edited rows were marked');
        }
      }
      assert.deepEqual(outcomes[0], outcomes[1]);
      assert.deepEqual(outcomes[0].carbs, [15, 15, 15]);
    });
  });
