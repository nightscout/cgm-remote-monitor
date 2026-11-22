'use strict';

// NS_CLOCK_LATE_STAMP (INC-G): the tenant write clock is taken last and held
// across a fixed number of statements whatever the batch size. Actual
// PostgreSQL, the clock-port fixture. Each property is shown with the switch
// on and off, and the two controls that guard it go red on a broken clock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const pg = require('pg');
const scope = require('../lib/storage/tenant-scope');
const createLegacy = require('../lib/storage/postgres-collection-intent');
const connect = require('../lib/storage/postgres-connection');
const decorate = require('../lib/storage/postgres-write-clock');
const lateStamp = require('../lib/storage/late-stamp');
const createLab = require('./fixtures/tenant-commit-clock-port');
const holdProbe = require('./support/clock-hold-probe');
const { optInSuite } = require('./support/opt-in');

const RESERVE = 'GREATEST(last_stamp + $2::bigint';
const CLOCK_FILE = path.resolve(__dirname, '../lib/storage/postgres-write-clock.js');

// A clock module with one edit (red controls), sharing every other module.
function brokenClock (from, to) {
  const source = fs.readFileSync(CLOCK_FILE, 'utf8');
  assert.equal(source.split(from).length, 2, 'The red edit must apply exactly once');
  const m = new Module(CLOCK_FILE, module);
  m.filename = CLOCK_FILE;
  m.paths = Module._nodeModulePaths(path.dirname(CLOCK_FILE));
  m._compile(source.replace(from, to), CLOCK_FILE);
  return m.exports;
}
const NO_VALIDATION = brokenClock('ctx.overlapped = await overlapped(ctx.reads, floor0);', 'ctx.overlapped = false;');
const NO_RESERVE_LOCK = brokenClock(
  "'UPDATE ' + table +\n              ' SET last_stamp = GREATEST(last_stamp + $2::bigint, $3::bigint + $2::bigint - 1) WHERE tenant_id = $1 RETURNING last_stamp'",
  "'SELECT GREATEST(last_stamp + $2::bigint, $3::bigint + $2::bigint - 1) AS last_stamp FROM ' + table + ' WHERE tenant_id = $1'");

function treatments (count, tag, { insulin = 0.1 } = {}) {
  const start = Date.UTC(2026, 10, 20) + (tag.charCodeAt(0) % 64) * 86400000;
  return Array.from({ length: count }, (_, k) => ({ eventType: 'Correction Bolus', insulin,
    created_at: new Date(start + k * 300000).toISOString(), enteredBy: 'synthetic-' + tag }));
}

// Hooks on the lab role's statements: hold one backend's COMMIT, or let the
// reserving statements through only when `count` have arrived.
function statementHooks (role) {
  const original = pg.Client.prototype.query;
  const hooks = { barrier: null, holdCommit: null };
  pg.Client.prototype.query = function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0] && args[0].text;
    if (this.connectionParameters?.user !== role || typeof sql !== 'string') return original.apply(this, args);
    const client = this;
    if (hooks.barrier && sql.includes(RESERVE)) {
      const barrier = hooks.barrier;
      barrier.arrived++;
      if (barrier.arrived >= barrier.count) barrier.open();
      return barrier.opened.then(() => original.apply(client, args));
    }
    if (hooks.holdCommit && sql.includes(RESERVE) && hooks.holdCommit.pid === undefined) hooks.holdCommit.pid = client.processID;
    if (hooks.holdCommit && /^\s*COMMIT/.test(sql) && hooks.holdCommit.pid === client.processID) {
      const hold = hooks.holdCommit;
      hooks.holdCommit = null;
      hold.reached();
      return hold.released.then(() => original.apply(client, args));
    }
    return original.apply(this, args);
  };
  hooks.barrierOf = count => {
    const barrier = { count, arrived: 0 };
    barrier.opened = new Promise(resolve => { barrier.open = resolve; });
    hooks.barrier = barrier;
    return barrier;
  };
  hooks.holdNextCommit = () => {
    const hold = {};
    hold.reachedPromise = new Promise(resolve => { hold.reached = resolve; });
    hold.released = new Promise(resolve => { hold.release = resolve; });
    hooks.holdCommit = hold;
    return hold;
  };
  hooks.restore = () => { pg.Client.prototype.query = original; };
  return hooks;
}

optInSuite(process.env.NS_TENANT_COMMIT_CLOCK_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_COMMIT_CLOCK_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'tenant write clock taken last (NS_CLOCK_LATE_STAMP)', function () {
    this.timeout(120000);
    const lab = createLab({ replicas: 2 });
    // As served with socket forwarding (deployment-settings): treatments,
    // device statuses and profiles carry the per-tenant insertion ordinal,
    // whose counter row every insert holds until COMMIT.
    Object.assign(lab.catalogues, require('../lib/server/tenant-socket-order-port').catalogues);
    let saved;
    before(() => lab.open());
    beforeEach(async () => { saved = process.env[lateStamp.SWITCH]; await lab.reset(); });
    afterEach(() => { if (saved === undefined) delete process.env[lateStamp.SWITCH]; else process.env[lateStamp.SWITCH] = saved; });
    after(() => lab.close());
    const setSwitch = on => { process.env[lateStamp.SWITCH] = on ? '1' : '0'; };
    const tableOf = logical => lab.namespaces[logical] + '.' + logical;
    const port = (connection, logical = 'treatments') => createLegacy({ connection, table: tableOf(logical), logical, source: 'v1/internal' });
    const writeBatch = (connection, docs, tenant = lab.A) => scope.withTenant(tenant, async () => {
      const p = port(connection);
      const planned = p.plan({ op: 'create', form: 'batch', docs });
      const written = await p.write(planned);
      return { planned, written };
    });
    const stored = async (logical = 'treatments', tenant = lab.A) => (await lab.admin.query(
      `SELECT id_kind, doc, insertion_ordinal FROM "${lab.namespaces[logical]}"."${logical}" WHERE tenant_id=$1 ORDER BY insertion_ordinal`,
      [tenant])).rows;

    for (const on of [false, true]) {
      it((on ? 'on' : 'off') + ': a batch is stored with ordered stamps at or below the floor, and the caller sees the stored stamps', async function () {
        setSwitch(on);
        const before = await lab.floor(lab.A);
        const docs = treatments(40, 'e');
        const { planned, written } = await writeBatch(lab.clocks[0], docs);
        const rows = await stored();
        assert.equal(rows.length, 40);
        const floor = await lab.floor(lab.A);
        rows.forEach((row, k) => {
          assert.equal(row.doc.created_at, docs[k].created_at, 'insertion order is batch order');
          assert.equal(row.doc.srvCreated, row.doc.srvModified);
          assert.ok(row.doc.srvModified > before && row.doc.srvModified <= floor);
          if (k) assert.ok(row.doc.srvModified > rows[k - 1].doc.srvModified, 'stamps rise in batch order');
          assert.equal(planned.docs[k].srvModified, row.doc.srvModified, 'the caller keeps the stored stamp');
          assert.equal(String(planned.docs[k]._id), row.doc._id);
        });
        assert.equal(floor, rows[39].doc.srvModified);
        assert.ok(!JSON.stringify(written).includes(String(lateStamp.PROVISIONAL).slice(0, 8)), 'no provisional stamp in the reply');
      });

      it((on ? 'on' : 'off') + ': a re-sent batch matches its stored rows and stores no copy', async function () {
        setSwitch(on);
        await writeBatch(lab.clocks[0], treatments(10, 'r'));
        const first = await stored();
        await writeBatch(lab.clocks[1], treatments(10, 'r', {}));
        const second = await stored();
        assert.equal(second.length, 10);
        assert.deepEqual(second.map(row => row.doc._id), first.map(row => row.doc._id));
        assert.deepEqual(second.map(row => row.doc.srvCreated), first.map(row => row.doc.srvCreated), 'srvCreated carried');
        assert.ok(second.every((row, k) => row.doc.srvModified > first[k].doc.srvModified), 'a replace takes a new stamp');
      });

      it((on ? 'on' : 'off') + ': a device status batch is stored once each, stamped in order', async function () {
        setSwitch(on);
        const statuses = Array.from({ length: 30 }, (_, k) => ({ device: 'synthetic-loop', created_at: new Date(Date.UTC(2026, 10, 20) + k * 300000).toISOString(), loop: { iob: k } }));
        const result = await scope.withTenant(lab.A, () => port(lab.clocks[0], 'devicestatus').write({ op: 'create', docs: statuses }));
        const rows = await stored('devicestatus');
        assert.equal(rows.length, 30);
        rows.forEach((row, k) => {
          assert.equal(row.doc.loop.iob, k);
          if (k) assert.ok(row.doc.srvModified > rows[k - 1].doc.srvModified);
          assert.equal(String(statuses[k]._id), row.doc._id);
          assert.equal(statuses[k].srvModified, row.doc.srvModified);
        });
        assert.ok(!JSON.stringify(result).includes(String(lateStamp.PROVISIONAL).slice(0, 8)));
      });
    }

    it('gate: the clock hold is a fixed number of statements on, and grows with the batch off (red on base)', async function () {
      const probe = holdProbe(lab.role);
      const report = {};
      try {
        for (const on of [false, true]) {
          setSwitch(on);
          report[on ? 'on' : 'off'] = [];
          for (const size of [1, 50, 288, 1000]) {
            await lab.reset();
            probe.start();
            await writeBatch(lab.clocks[0], treatments(size, 'g'));
            const { holds } = probe.stop();
            assert.equal(holds.length, 1);
            report[on ? 'on' : 'off'].push({ size, statements: holds[0].statements, ms: Math.round(holds[0].ms * 10) / 10 });
          }
        }
      } finally { probe.restore(); }
      console.log('CLOCK_HOLD ' + JSON.stringify(report));
      // Primary: wall time from the clock-row statement to the end of COMMIT
      // (decision per-tenant-lock-bounded-hold). Secondary: statements.
      const ms = arm => report[arm].map(row => row.ms);
      const statements = arm => report[arm].map(row => row.statements);
      // Off: the per-document loop runs under the clock (the measured defect).
      assert.ok(ms('off')[2] > 400 && ms('off')[3] > ms('off')[0] * 50, 'base hold grows with the batch');
      assert.ok(statements('off')[3] > statements('off')[0] * 100);
      // On: reserve, validate, insert, COMMIT, whatever the size. What is
      // left grows only with the one INSERT (its per-row triggers).
      ms('on').forEach((value, i) => assert.ok(value * 5 < ms('off')[i] || value < 20, 'on hold is a fifth of off or under 20 ms'));
      assert.ok(ms('on')[2] < 200, 'a 288 batch holds the clock under 200 ms');
      assert.deepEqual(statements('on'), [4, 4, 4, 4]);
    });

    it('red: the hold gate fails on the per-document path', async function () {
      setSwitch(false);
      const probe = holdProbe(lab.role);
      const sizes = [];
      try {
        for (const size of [1, 288]) {
          await lab.reset();
          probe.start();
          await writeBatch(lab.clocks[0], treatments(size, 'g'));
          sizes.push(probe.stop().holds[0]);
        }
      } finally { probe.restore(); }
      assert.throws(() => assert.deepEqual(sizes.map(row => row.statements), [4, 4]));
      assert.throws(() => assert.ok(sizes[1].ms < 200));
    });

    async function duplicateRace (clockOf) {
      const hooks = statementHooks(lab.role);
      try {
        const barrier = hooks.barrierOf(2);
        const docs = () => treatments(20, 'd');
        const outcomes = await Promise.allSettled([writeBatch(clockOf(0), docs()), writeBatch(clockOf(1), docs())]);
        assert.equal(barrier.arrived, 2, 'both batches read before either held the clock');
        return { outcomes, rows: await stored() };
      } finally { hooks.restore(); }
    }

    it('on: two concurrent batches with the same identities never both insert; the later one replaces under the clock', async function () {
      setSwitch(true);
      const { outcomes, rows } = await duplicateRace(i => lab.clocks[i]);
      assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled']);
      assert.equal(rows.length, 20, 'one stored row per identity');
    });

    it('off: two concurrent batches with the same identities store one row each (the second replaces)', async function () {
      setSwitch(false);
      const docs = () => treatments(20, 'd');
      const outcomes = await Promise.allSettled([writeBatch(lab.clocks[0], docs()), writeBatch(lab.clocks[1], docs())]);
      assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled']);
      assert.equal((await stored()).length, 20);
    });

    it('red: without the validation under the clock, both concurrent batches insert', async function () {
      setSwitch(true);
      const clocks = lab.raw.map(raw => NO_VALIDATION(raw, lab.namespaces.clock));
      const { outcomes, rows } = await duplicateRace(i => clocks[i]);
      assert.deepEqual(outcomes.map(o => o.status), ['fulfilled', 'fulfilled']);
      assert.equal(rows.length, 40, 'the control detects duplicate identities');
    });

    // The later writer re-sends stored treatments: a replace takes no
    // insertion-ordinal lock, so only the clock orders it behind the held batch.
    async function heldWriter (clockOf) {
      await writeBatch(lab.clocks[0], treatments(30, 'k'));
      const hooks = statementHooks(lab.role);
      const baseline = await lab.floor(lab.A);
      const hold = hooks.holdNextCommit();
      const first = writeBatch(clockOf(0), treatments(30, 'h'));
      first.catch(() => {});
      let second, secondDone = false, visibleWhileHeld, waited;
      try {
        await Promise.race([hold.reachedPromise, first.then(() => { throw new Error('held batch committed before its hold'); })]);
        second = writeBatch(clockOf(1), treatments(30, 'k'));
        second.then(() => { secondDone = true; }, () => { secondDone = true; });
        try { waited = await lab.waitForClockLock(); } catch { waited = null; }
        await new Promise(resolve => setTimeout(resolve, 200));
        visibleWhileHeld = (await lab.rows(lab.A, baseline)).length + (await lab.admin.query(
          `SELECT count(*)::int AS n FROM "${lab.namespaces.treatments}".treatments WHERE tenant_id=$1 AND "srvModified" > $2`, [lab.A, baseline])).rows[0].n;
      } finally {
        hold.release();
        await Promise.allSettled([first, second].filter(Boolean));
        hooks.restore();
      }
      return { first: await first, second: await second, waited, secondDone, visibleWhileHeld, baseline };
    }

    it('on: a later writer waits on the clock while an earlier stamped batch is uncommitted; no higher cursor is exposed', async function () {
      setSwitch(true);
      const { waited, visibleWhileHeld, baseline } = await heldWriter(i => lab.clocks[i]);
      assert.ok(waited && waited.blockers.length > 0, 'the later writer is blocked on the clock row');
      assert.equal(visibleWhileHeld, 0, 'nothing above the baseline is visible while the earlier batch is held');
      const rows = (await stored()).map(row => row.doc);
      assert.equal(rows.length, 60);
      const held = rows.filter(row => row.enteredBy === 'synthetic-h'), later = rows.filter(row => row.enteredBy === 'synthetic-k');
      assert.ok(later.every(row => row.srvModified > baseline), 'the later writer replaced the stored rows');
      assert.ok(Math.max(...held.map(row => row.srvModified)) < Math.min(...later.map(row => row.srvModified)), 'commit order is stamp order');
      assert.ok(held.every(row => row.srvModified > baseline));
    });

    it('red: a reservation that does not hold the clock row exposes a later cursor ahead of the held batch', async function () {
      setSwitch(true);
      const clocks = lab.raw.map(raw => NO_RESERVE_LOCK(raw, lab.namespaces.clock));
      const { waited, secondDone, visibleWhileHeld } = await heldWriter(i => clocks[i]);
      assert.equal(waited, null, 'the later writer was not blocked');
      assert.equal(secondDone, true, 'the later batch committed while the earlier one was held');
      assert.ok(visibleWhileHeld > 0, 'a cursor past the later batch skips the held one');
    });

    it('reproduction: eight concurrent 288-treatment batches to one tenant under a 1 s statement deadline, off and on', async function () {
      const report = {};
      const probe = holdProbe(lab.role);
      const deadline = await connect({ connectionString: lab.appURI, max: 8, query_timeout: 1000,
        application_name: lab.name + '_deadline', connectionTimeoutMillis: 5000 });
      try {
        const clock = decorate(deadline, lab.namespaces.clock);
        for (const on of [false, true]) {
          setSwitch(on);
          await lab.reset();
          const started = Date.now();
          probe.start();
          const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
            writeBatch(clock, treatments(288, String.fromCharCode(97 + i)))));
          const holds = probe.stop().holds.map(hold => hold.ms).sort((a, b) => a - b);
          const codes = outcomes.map(o => o.status === 'fulfilled' ? 'ok' : (o.reason.code || 'error'));
          report[on ? 'on' : 'off'] = { codes: codes.reduce((m, c) => Object.assign(m, { [c]: (m[c] || 0) + 1 }), {}),
            rows: (await stored()).length, ms: Date.now() - started,
            holdMs: { n: holds.length, p50: Math.round(holds[Math.floor(holds.length / 2)]), max: Math.round(holds[holds.length - 1]) } };
        }
      } finally { probe.restore(); await deadline.end(); }
      console.log('CLOCK_CONTENTION ' + JSON.stringify(report));
      // Characterization (single runs): off reproduces INC-D (6 of 8 refused).
      assert.ok((report.off.codes.STORAGE_TIMEOUT || 0) >= 1, 'off: the long hold refuses waiting batches');
      assert.ok(report.on.holdMs.p50 * 3 < report.off.holdMs.p50, 'on: the hold under load is a third of off or less');
      assert.equal(report.on.rows, 288 * (report.on.codes.ok || 0), 'every committed batch is whole');
    });
  });
