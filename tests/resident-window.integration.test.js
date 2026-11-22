'use strict';

// Resident window (decision stateful-evaluator-resident-window), behind
// NS_EVALUATOR_RESIDENT_WINDOW=1, on actual PostgreSQL.
//
// Two evaluator components read the same tenant: one through a replay that
// keeps a resident window and brings it up to date from the writers' window
// marks, one through the bounded full window read (the path with the switch
// off). After every step both evaluate at the same pinned instant and their
// complete published results (properties, alarms, browser frame, signature,
// due) must be the same text. Writes go through the shipping storage writer
// and write clock, so the marks are the writers' own. The work row is
// completed through the typed checkpoint store after each cycle, as the
// runtime does.
//
// Controls: each deliberately wrong build must fail the scenario that guards
// it (tests/lib/clinical-working-set/control.js loads the broken source).
// Synthetic data only, on a disposable database (its name must contain "test").
const assert = require('node:assert/strict');
const createLab = require('./fixtures/s1-level-lab');
const { optInSuite } = require('./support/opt-in');
const brokenModule = require('./lib/clinical-working-set/control');
const scope = require('../lib/storage/tenant-scope');
const dates = require('../lib/server/srv-dates');
const { fromMongo } = require('../lib/storage/filter');
const windowMark = require('../lib/writer-driven/window-mark');

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const IDENTITY = 'synthetic-s1-identity';
const iso = ms => new Date(ms).toISOString();

optInSuite(process.env.NS_RESIDENT_WINDOW_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_RESIDENT_WINDOW_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'resident window: updated from the writers\' marks, equal to the bounded full read', function () {
    this.timeout(240000);
    const lab = createLab({ tenants: 2 });
    let previousSwitch, connection, store, writers, T0;
    const open = [];

    before(async () => {
      previousSwitch = process.env[windowMark.SWITCH];
      process.env[windowMark.SWITCH] = '1'; // before the lab builds its write clock
      await lab.open();
    });
    after(async () => {
      await lab.close();
      if (previousSwitch === undefined) delete process.env[windowMark.SWITCH]; else process.env[windowMark.SWITCH] = previousSwitch;
    });
    beforeEach(async () => {
      await lab.reset();
      const connect = require('../lib/storage/postgres-connection');
      connection = await connect({ connectionString: lab.evaluatorURI, max: 6, statement_timeout: 20000, application_name: 'resident-window-test' });
      store = require('../lib/pgstream/typed-checkpoint').create({ connection, namespace: lab.base.name + '_work', consumer: lab.CONSUMER,
        maxBytes: 33554432, timeIntervalMs: 60000, generationFence: { table: lab.lifecycleTable } });
      await store.own(() => {});
      writers = storageWriters(lab.writer);
      T0 = Math.floor(Date.now() / MIN) * MIN;
    });
    afterEach(async () => {
      for (const component of open.splice(0)) component.close();
      await store.close().catch(() => {}); await connection.end();
    });

    // ---- writers: the shipping storage writer over the lab's write clock
    function storageWriters (clock, factory = require('../lib/storage/postgres-entries-write')) {
      const out = {};
      for (const logical of ['entries', 'treatments', 'devicestatus', 'profile', 'food']) {
        out[logical] = factory({ connection: clock, table: lab.base.tables[logical], legacyPatterns: true, windowDomain: logical });
      }
      out.clock = clock;
      return out;
    }
    const write = (tenant, fn, options, set = writers) => scope.withTenant(tenant, () => set.clock.transaction(() => fn(set, () => dates.next()), options));
    const stamped = (doc, modified) => ({ ...doc, srvModified: modified, srvCreated: modified });
    const sgv = (id, value, date) => ({ _id: id, type: 'sgv', sgv: value, date, dateString: iso(date), direction: 'Flat', device: 'synthetic-cgm', noise: 1 });
    const insert = (tenant, logical, doc, set) => write(tenant, (w, m) => w[logical].insertOne(stamped(doc, m()), { normalize: false }), undefined, set);
    const replace = (tenant, logical, doc, set) => write(tenant, (w, m) => w[logical].replaceOne(doc._id, stamped(doc, m()), doc._id), undefined, set);
    const remove = (tenant, logical, id, set) => write(tenant, w => w[logical].deleteOne(id), { history: false }, set);

    // A window like a looping tenant's: two days of readings, a day of loop
    // statuses, temp basals and boluses, an old profile switch and device
    // age events inside and outside their look-backs, one profile.
    async function seed (tenant, tag, at = T0) {
      const entries = [], statuses = [], treatments = [];
      for (let t = at - 2 * DAY - 30 * MIN; t <= at - 5 * MIN; t += 5 * MIN) entries.push(sgv(tag + '-sgv-' + t, 100 + ((t / (5 * MIN)) % 40), t));
      for (let t = at - DAY - 30 * MIN; t <= at - 5 * MIN; t += 5 * MIN) {
        statuses.push({ _id: tag + '-ds-' + t, created_at: iso(t), device: 'loop://synthetic', uploaderBattery: 80,
          loop: { timestamp: iso(t), iob: { iob: 1.2, timestamp: iso(t) }, cob: { cob: 10, timestamp: iso(t) }, predicted: { startDate: iso(t), values: [110, 112, 115, 118] } },
          pump: { clock: iso(t), reservoir: 120, battery: { percent: 70 } } });
      }
      for (let t = at - 60 * HOUR - HOUR; t <= at - 30 * MIN; t += 30 * MIN) {
        treatments.push({ _id: tag + '-tb-' + t, eventType: 'Temp Basal', created_at: iso(t), duration: 30, absolute: 0.8, enteredBy: 'synthetic' });
      }
      for (let t = at - 50 * HOUR; t <= at - 2 * HOUR; t += 6 * HOUR) {
        treatments.push({ _id: tag + '-bolus-' + t, eventType: 'Meal Bolus', created_at: iso(t), insulin: 2.5, carbs: 30, enteredBy: 'synthetic' });
      }
      treatments.push({ _id: tag + '-switch', eventType: 'Profile Switch', created_at: iso(at - 10 * DAY), duration: 0, profile: 'Default' });
      treatments.push({ _id: tag + '-site', eventType: 'Site Change', created_at: iso(at - 20 * DAY) });
      treatments.push({ _id: tag + '-sensor-old', eventType: 'Sensor Start', created_at: iso(at - 100 * DAY) });
      const profile = [{ _id: tag + '-profile', defaultProfile: 'Default', startDate: iso(at - 30 * DAY), mills: at - 30 * DAY, units: 'mg/dl',
        store: { Default: { dia: 4, timezone: 'UTC', units: 'mg/dl', carbratio: [{ time: '00:00', value: 10 }], sens: [{ time: '00:00', value: 40 }],
          basal: [{ time: '00:00', value: 1 }], target_low: [{ time: '00:00', value: 90 }], target_high: [{ time: '00:00', value: 120 }] } } }];
      for (const [logical, docs] of [['entries', entries], ['devicestatus', statuses], ['treatments', treatments], ['profile', profile]]) {
        for (let i = 0; i < docs.length; i += 200) await lab.writeDocs(tenant, logical, docs.slice(i, i + 200));
      }
      return { entries: entries.length, devicestatus: statuses.length, treatments: treatments.length };
    }

    // ---- the two readers
    const SIZE = { maxRows: 10000, maxBytes: 16777216 };
    function replays ({ factory = require('../lib/storage/postgres-durable-replay'), checkMs = 86400000 } = {}) {
      const common = { connection, checkpointTable: lab.base.replayNamespace + '.tenant_consumer_checkpoint',
        clockTable: lab.base.namespaces.clock + '.tenant_write_clock', domains: lab.base.tables, consumer: 'clinical-level',
        projectionVersion: 'clinical-current-rows-v1', pageSize: 100, maxRows: SIZE.maxRows };
      const lifecycleTable = lab.base.name + '_control.tenant_lifecycle_windows';
      return {
        resident: factory({ ...common, level: { lifecycleTable, checkMs,
          work: { table: lab.base.name + '_work.tenant_consumer_checkpoint', consumer: lab.COMPLETED } } }),
        full: require('../lib/storage/postgres-durable-replay')({ ...common, level: { lifecycleTable, resident: false } })
      };
    }
    function pair (tenant, pairReplays, { residentLevers, fullLevers } = {}) {
      const make = (replay, levers) => { const c = require('../lib/data/tenant-projection-evaluator')({ tenant, replay, levers, connection, env: lab.base.env,
        language: lab.base.language, dbstats: lab.base.stats, ...SIZE, includeFrame: true }); open.push(c); return c; };
      return { tenant, replays: pairReplays, resident: make(pairReplays.resident, residentLevers), full: make(pairReplays.full, fullLevers) };
    }
    const text = result => JSON.stringify(result);
    // One cycle of both, at one pinned instant. `between` runs after the
    // resident component read its window and before its completion.
    async function cycle (p, at, { time = false, between, complete = true, label = '' } = {}) {
      const before = p.replays.resident.residentStats();
      const observed = await store.begin(p.tenant);
      const [mine, reference] = await lab.base.at(at, async () => {
        const call = component => scope.withTenant(p.tenant, () => time ? component.evaluateTime({ at }) : component.evaluate({ at }));
        const a = await call(p.resident);
        return [a, await call(p.full)];
      });
      assert.equal(text(mine), text(reference), label + ': the resident cycle result is the full read\'s, byte for byte');
      if (between) await between();
      let completed = null, refused = null;
      if (complete) {
        try { completed = await store.complete(p.tenant, { observed, identity: IDENTITY, result: mine, restoreGeneration: mine.generation }); }
        catch (error) { refused = error; }
      }
      const after = p.replays.resident.residentStats();
      const reasons = Object.fromEntries(Object.keys(after.reasons).map(key => [key, after.reasons[key] - (before.reasons[key] || 0)]).filter(([, n]) => n));
      return { result: mine, completed, refused, read: after.rowsRead - before.rowsRead, full: after.full - before.full,
        tail: after.tail - before.tail, unchanged: after.unchanged - before.unchanged, reasons, differences: after.differences - before.differences };
    }
    async function warm (tenant, tag, options) {
      const counts = await seed(tenant, tag);
      const p = pair(tenant, replays(options));
      const first = await cycle(p, T0, { label: 'first' });
      assert.equal(first.full, 1); assert.deepEqual(first.reasons, { 'no-resident': 1 });
      // The seed was raw SQL inside the clock transaction: an unbounded mark, completed by the first cycle.
      return { p, counts, rows: first.read };
    }
    // An unsupported writer: one row changed by raw SQL, with no clock transaction and no mark.
    async function unmarked (tenant, id) {
      await lab.admin.query('BEGIN');
      try {
        await lab.admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
        const changed = await lab.admin.query(`UPDATE "${lab.base.namespaces.entries}".entries SET doc = jsonb_set(doc, '{sgv}', '55') WHERE tenant_id=$1 AND "_id"=$2`, [tenant, id]);
        assert.equal(changed.rowCount, 1);
        await lab.admin.query('COMMIT');
      } catch (error) { await lab.admin.query('ROLLBACK'); throw error; }
    }
    const mode = (step, expected, label) => assert.deepEqual({ full: step.full, tail: step.tail, unchanged: step.unchanged }, { full: 0, tail: 0, unchanged: 0, ...expected }, label);

    it('ordinary uploads read only the new tail; an idle cycle and a time-only expiry read nothing', async function () {
      const { p, rows } = await warm(lab.tenants[0], 'a');
      assert.ok(rows > 800, 'a full window of ' + rows + ' rows');
      await insert(p.tenant, 'entries', sgv('a-new-1', 123, T0 + MIN));
      let step = await cycle(p, T0 + 2 * MIN, { label: 'new reading' });
      mode(step, { tail: 1 }, 'a new reading is a tail read'); assert.equal(step.read, 1, 'one row read for one row written');
      assert.equal(step.result.properties.bgnow.mills, T0 + MIN);
      await insert(p.tenant, 'devicestatus', { _id: 'a-ds-new', created_at: iso(T0 + 2 * MIN), device: 'loop://synthetic', loop: { timestamp: iso(T0 + 2 * MIN), iob: { iob: 0.9, timestamp: iso(T0 + 2 * MIN) } } });
      await insert(p.tenant, 'treatments', { _id: 'a-tb-new', eventType: 'Temp Basal', created_at: iso(T0 + 2 * MIN), duration: 30, absolute: 0.3 });
      step = await cycle(p, T0 + 3 * MIN, { label: 'status and treatment' });
      mode(step, { tail: 1 }); assert.equal(step.read, 2, 'two domains, one row each');
      step = await cycle(p, T0 + 4 * MIN, { label: 'no write' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
      // Time alone: readings and statuses leave their windows; no row is read.
      step = await cycle(p, T0 + 40 * MIN, { time: true, label: 'time-only expiry' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
      // A write outside the window's domains (food) marks the tenant pending and changes no window row.
      await insert(p.tenant, 'food', { _id: 'a-food', name: 'synthetic', carbs: 10 });
      step = await cycle(p, T0 + 41 * MIN, { label: 'food' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
    });

    it('late and backdated writes, inside the window and at its edge', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      // Backdated 30 h: the tail from there is replaced.
      await insert(p.tenant, 'entries', sgv('a-late', 250, T0 - 30 * HOUR + 1000));
      let step = await cycle(p, T0 + MIN, { label: 'backdated reading' });
      mode(step, { tail: 1 }); assert.ok(step.read > 300 && step.read < 400, 'the tail after the backdated reading: ' + step.read);
      // At the edge of the two-day reading window, one millisecond either side.
      const edge = T0 + 2 * MIN - 2 * DAY;
      await insert(p.tenant, 'entries', sgv('a-edge-in', 77, edge));
      await insert(p.tenant, 'entries', sgv('a-edge-out', 78, edge - 1));
      step = await cycle(p, T0 + 2 * MIN, { label: 'edge readings' });
      mode(step, { tail: 1 });
      // A treatment older than the 60 h window that an event look-back still holds, and one it does not.
      await insert(p.tenant, 'treatments', { _id: 'a-sensor', eventType: 'Sensor Start', created_at: iso(T0 - 40 * DAY) });
      await insert(p.tenant, 'treatments', { _id: 'a-note-old', eventType: 'Note', created_at: iso(T0 - 40 * DAY + 1), notes: 'outside' });
      step = await cycle(p, T0 + 3 * MIN, { label: 'old event treatments' });
      mode(step, { tail: 1 });
      // Two writes before one cycle, the older one first: the mark is the lower of the two.
      await insert(p.tenant, 'entries', sgv('a-late-2', 240, T0 - 20 * HOUR + 500));
      await insert(p.tenant, 'entries', sgv('a-new-2', 131, T0 + 3 * MIN));
      step = await cycle(p, T0 + 4 * MIN, { label: 'late then new' });
      mode(step, { tail: 1 }); assert.ok(step.read > 200, 'read from the older mark: ' + step.read);
      // A reading dated in the future.
      await insert(p.tenant, 'entries', sgv('a-future', 99, T0 + 30 * MIN));
      step = await cycle(p, T0 + 5 * MIN, { label: 'future reading' });
      mode(step, { tail: 1 });
    });

    it('same-id edits, including an edit that moves the record in time, and updates by filter', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      const newest = T0 - 5 * MIN;
      await replace(p.tenant, 'entries', sgv('a-sgv-' + newest, 45, newest));
      let step = await cycle(p, T0 + MIN, { label: 'edit newest reading' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1); assert.equal(step.result.properties.bgnow.mean, 45);
      // The same edit again changes nothing: pending, no window change.
      await replace(p.tenant, 'entries', sgv('a-sgv-' + newest, 45, newest));
      // (srvModified differs, so the row does change; the tail is still one row.)
      step = await cycle(p, T0 + 2 * MIN, { label: 'edit again' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      // Moved earlier: the mark is the new time. Moved later: the mark is the old time.
      await replace(p.tenant, 'treatments', { _id: 'a-bolus-' + (T0 - 2 * HOUR), eventType: 'Meal Bolus', created_at: iso(T0 - 9 * HOUR), insulin: 2.5, carbs: 30 });
      step = await cycle(p, T0 + 3 * MIN, { label: 'treatment moved earlier' });
      mode(step, { tail: 1 });
      await replace(p.tenant, 'treatments', { _id: 'a-bolus-' + (T0 - 2 * HOUR), eventType: 'Meal Bolus', created_at: iso(T0 - HOUR), insulin: 1.5, carbs: 30 });
      step = await cycle(p, T0 + 4 * MIN, { label: 'treatment moved later' });
      mode(step, { tail: 1 }); assert.ok(step.read >= 18, 'read from the earlier of old and new time: ' + step.read);
      // Update by filter (soft delete marks isValid false): the rows leave the window.
      await write(p.tenant, (w, m) => w.entries.updateMany(fromMongo({ date: { $gte: T0 - HOUR, $lt: T0 - 30 * MIN } }), { set: { isValid: false, srvModified: m() } }, {}));
      step = await cycle(p, T0 + 5 * MIN, { label: 'soft delete by filter' });
      mode(step, { tail: 1 });
      // An update that matches nothing: pending, nothing read.
      await write(p.tenant, w => w.entries.updateMany(fromMongo({ date: { $gte: T0 + DAY } }), { set: { sgv: 1 } }, {}));
      step = await cycle(p, T0 + 6 * MIN, { label: 'update matching nothing' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
      // An insert refused as a duplicate (its savepoint rolled back) in a transaction that still commits and marks.
      await write(p.tenant, (w, m) => w.entries.insertOne(stamped(sgv('a-sgv-' + (T0 - 10 * MIN), 1, T0 - 10 * MIN), m()), { normalize: false })
        .then(() => assert.fail('a duplicate must be refused'), error => assert.equal(error.code, 11000)));
      step = await cycle(p, T0 + 7 * MIN, { label: 'duplicate insert' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
    });

    it('restores the whole older device status to the frame after a newer status is deleted', async function () {
      const tenant = lab.tenants[0];
      const statuses = Array.from({ length: 11 }, (_, i) => ({
        _id: 'quiet-status-' + i, device: 'quiet-uploader', created_at: iso(T0 - 12 * HOUR + i * MIN),
        uploader: { name: 'synthetic uploader', battery: 60 + i }
      }));
      await lab.writeDocs(tenant, 'devicestatus', statuses);
      const p = pair(tenant, replays(), { residentLevers: 'all', fullLevers: 'off' });
      const first = await cycle(p, T0, { label: 'initial ten statuses' });
      assert.equal(first.result.frame.devicestatus.length, 10);
      assert.ok(first.result.frame.devicestatus.every(status => status._id !== statuses[0]._id));

      await remove(tenant, 'devicestatus', statuses[10]._id);
      const after = await cycle(p, T0 + MIN, { label: 'older status re-enters frame' });
      mode(after, { tail: 1 });
      const restored = after.result.frame.devicestatus.find(status => status._id === statuses[0]._id);
      assert.deepEqual(restored.uploader, statuses[0].uploader);
    });

    it('deletion of the newest qualifying record and of an old one, and deletion by filter', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      await insert(p.tenant, 'treatments', { _id: 'a-site-new', eventType: 'Site Change', created_at: iso(T0 - HOUR) });
      let step = await cycle(p, T0 + MIN, { label: 'newest site change' });
      mode(step, { tail: 1 });
      // Deleting the newest qualifying event exposes the older one (20 days), already resident.
      await remove(p.tenant, 'treatments', 'a-site-new');
      step = await cycle(p, T0 + 2 * MIN, { label: 'newest site change deleted' });
      mode(step, { tail: 1 });
      // An old record inside the window.
      await remove(p.tenant, 'entries', 'a-sgv-' + (T0 - 36 * HOUR));
      step = await cycle(p, T0 + 3 * MIN, { label: 'old reading deleted' });
      mode(step, { tail: 1 });
      // The newest reading.
      await remove(p.tenant, 'entries', 'a-sgv-' + (T0 - 5 * MIN));
      step = await cycle(p, T0 + 4 * MIN, { label: 'newest reading deleted' });
      mode(step, { tail: 1 }); assert.equal(step.result.properties.bgnow.mills, T0 - 10 * MIN);
      // By filter: the mark is the lowest time actually deleted.
      await write(p.tenant, w => w.devicestatus.deleteMany(fromMongo({ created_at: { $gte: iso(T0 - 3 * HOUR), $lt: iso(T0 - 2 * HOUR) } }), {}), { history: false });
      step = await cycle(p, T0 + 5 * MIN, { label: 'statuses deleted by filter' });
      mode(step, { tail: 1 });
      // A delete that removes nothing.
      await remove(p.tenant, 'entries', 'a-no-such-reading');
      step = await cycle(p, T0 + 6 * MIN, { label: 'delete of nothing' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
    });

    it('profile and settings changes, eviction and restart return to the right read', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      // A newer profile wins: only the profile domain is read again.
      await insert(p.tenant, 'profile', { _id: 'a-profile-2', defaultProfile: 'Default', startDate: iso(T0 - DAY), mills: T0 - DAY, units: 'mg/dl',
        store: { Default: { dia: 5, timezone: 'UTC', units: 'mg/dl', carbratio: [{ time: '00:00', value: 12 }], sens: [{ time: '00:00', value: 50 }],
          basal: [{ time: '00:00', value: 0.7 }], target_low: [{ time: '00:00', value: 90 }], target_high: [{ time: '00:00', value: 120 }] } } });
      let step = await cycle(p, T0 + MIN, { label: 'profile added' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1, 'the profile winner only');
      // A settings mark (source settings) is unbounded.
      await lab.admin.query('BEGIN');
      await require('../lib/writer-driven').mark((sql, values) => lab.admin.query(sql, values), { table: lab.workTable, consumer: lab.COMPLETED }, p.tenant, { source: 'settings' });
      await lab.admin.query('COMMIT');
      step = await cycle(p, T0 + 2 * MIN, { label: 'settings mark' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'unbounded-change': 1 });
      // A settings change of the component (the runtime's reconfigure): the window policy may differ.
      const environment = require('../lib/server/tenant-app/environment');
      const changed = environment({ settings: { enable: ['bgnow', 'delta', 'direction', 'rawbg', 'iob', 'cob', 'profile', 'basal', 'pump', 'openaps', 'loop', 'timeago', 'simplealarms', 'devicestatus'],
        thresholds: { bgHigh: 220, bgTargetTop: 170, bgTargetBottom: 85, bgLow: 60 } } });
      for (const component of [p.resident, p.full]) await scope.withTenant(p.tenant, async () => component.reconfigure({ env: changed }));
      step = await cycle(p, T0 + 3 * MIN, { label: 'settings change' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'no-resident': 1 });
      await insert(p.tenant, 'entries', sgv('a-after-settings', 140, T0 + 3 * MIN));
      step = await cycle(p, T0 + 4 * MIN, { label: 'after settings change' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      // Eviction releases the resident; the next cycle reads in full.
      for (const component of [p.resident, p.full]) await scope.withTenant(p.tenant, async () => component.evict());
      step = await cycle(p, T0 + 5 * MIN, { label: 'after eviction' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'no-resident': 1 });
      // Restart: a new process has new components and no resident.
      const restarted = pair(p.tenant, replays());
      await insert(p.tenant, 'entries', sgv('a-after-restart', 150, T0 + 5 * MIN));
      step = await cycle(restarted, T0 + 6 * MIN, { label: 'after restart' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'no-resident': 1 });
      await insert(p.tenant, 'entries', sgv('a-after-restart-2', 151, T0 + 6 * MIN));
      step = await cycle(restarted, T0 + 7 * MIN, { label: 'restarted, next write' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      // The process that was replaced completed nothing since: its resident is behind what was completed.
      step = await cycle(p, T0 + 8 * MIN, { label: 'the replaced process' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'completed-beyond-resident': 1 });
    });

    it('a write committed while a cycle runs keeps its mark; an unbounded or unmarked change reads in full', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      await insert(p.tenant, 'entries', sgv('a-w1', 111, T0 + MIN));
      // W2 commits after the cycle read its window and before it completes.
      let step = await cycle(p, T0 + 2 * MIN, { label: 'cycle with a write in flight',
        between: () => insert(p.tenant, 'entries', sgv('a-w2-late', 222, T0 - 12 * HOUR + 7)) });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      assert.ok(Number.isSafeInteger(step.completed.pendingAt), 'the write in flight stays pending');
      step = await cycle(p, T0 + 3 * MIN, { label: 'the next cycle reads the write in flight' });
      mode(step, { tail: 1 }); assert.ok(step.read > 100, 'from the lower of both marks: ' + step.read);
      // A failed completion: the marks stay and the next cycle reads them again.
      await insert(p.tenant, 'entries', sgv('a-w3', 133, T0 + 3 * MIN));
      step = await cycle(p, T0 + 4 * MIN, { label: 'cycle that does not complete', complete: false });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      step = await cycle(p, T0 + 5 * MIN, { label: 'retry after a lost completion' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      // Raw SQL inside the clock transaction notes nothing: unbounded.
      await lab.writeDocs(p.tenant, 'entries', [sgv('a-raw', 144, T0 + 5 * MIN)]);
      step = await cycle(p, T0 + 6 * MIN, { label: 'unnoted write' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'unbounded-change': 1 });
      // A writer without the switch marks pending and does not maintain the window columns.
      process.env[windowMark.SWITCH] = '0';
      try { await lab.writeDocs(p.tenant, 'entries', [sgv('a-off', 155, T0 + 6 * MIN)]); } finally { process.env[windowMark.SWITCH] = '1'; }
      step = await cycle(p, T0 + 7 * MIN, { label: 'writer without the switch' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { 'marks-not-current': 1 });
      // The next marked write finds everything completed and starts the marks afresh.
      await insert(p.tenant, 'entries', sgv('a-resync', 166, T0 + 7 * MIN));
      step = await cycle(p, T0 + 8 * MIN, { label: 'first marked write after resynchronizing' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
    });

    it('a restore generation change while work is in flight refuses the completion and the next read is full', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      await insert(p.tenant, 'entries', sgv('a-before-restore', 111, T0 + MIN));
      let step = await cycle(p, T0 + 2 * MIN, { label: 'cycle crossed by a restore',
        between: () => lab.restore(p.tenant, { removeEntriesAfter: T0 - HOUR }) });
      assert.equal(step.refused?.code, 'EVALUATOR_COMPLETION_RESTORE_REFUSED');
      step = await cycle(p, T0 + 3 * MIN, { label: 'after the restore' });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { generation: 1 });
      assert.equal(step.result.generation, '2');
      assert.ok(step.result.properties.bgnow.mills <= T0 - HOUR, 'the restored data, not the resident rows');
    });

    it('two tenants in one slice keep separate residents', async function () {
      const shared = replays();
      await seed(lab.tenants[0], 'a'); await seed(lab.tenants[1], 'b');
      const a = pair(lab.tenants[0], shared), b = pair(lab.tenants[1], shared);
      await cycle(a, T0, { label: 'a first' }); await cycle(b, T0, { label: 'b first' });
      await insert(a.tenant, 'entries', sgv('a-only', 201, T0 + MIN));
      let step = await cycle(b, T0 + 2 * MIN, { label: 'b after a wrote' });
      mode(step, { unchanged: 1 }); assert.equal(step.read, 0);
      assert.ok(step.result.frame.sgvs.every(row => row.mgdl !== 201), 'b holds none of a');
      step = await cycle(a, T0 + 2 * MIN, { label: 'a after a wrote' });
      mode(step, { tail: 1 }); assert.equal(step.read, 1);
      assert.equal(step.result.properties.bgnow.mean, 201);
      // A resident handed to another tenant's read is refused, not used.
      const policy = require('../lib/storage/clinical-working-set-policy').create(lab.base.env, T0 + 3 * MIN);
      const mine = await scope.withTenant(a.tenant, () => shared.resident.window({ ...SIZE, policy }));
      const crossed = await scope.withTenant(b.tenant, () => shared.resident.window({ ...SIZE, policy, resident: mine.resident }));
      const expected = await scope.withTenant(b.tenant, () => shared.full.window({ ...SIZE, policy }));
      assert.equal(crossed.residentMode, 'full');
      assert.equal(JSON.stringify(crossed.rows), JSON.stringify(expected.rows), 'b\'s read with a\'s resident is b\'s window');
    });

    it('the self-check finds nothing on a run of ordinary changes, and repairs an unmarked change', async function () {
      const { p } = await warm(lab.tenants[0], 'a', { checkMs: 0 });
      const steps = [
        () => insert(p.tenant, 'entries', sgv('a-c1', 120, T0 + MIN)),
        () => insert(p.tenant, 'entries', sgv('a-c2', 121, T0 - 26 * HOUR + 3)),
        () => replace(p.tenant, 'entries', sgv('a-c1', 99, T0 + MIN)),
        () => remove(p.tenant, 'entries', 'a-c2'),
        () => insert(p.tenant, 'treatments', { _id: 'a-c3', eventType: 'Correction Bolus', created_at: iso(T0 + MIN), insulin: 1 }),
        () => remove(p.tenant, 'treatments', 'a-c3'),
        () => Promise.resolve()
      ];
      let at = T0 + MIN, checks = 0;
      for (const [i, step] of steps.entries()) {
        await step(); at += MIN;
        const done = await cycle(p, at, { label: 'checked step ' + i });
        assert.equal(done.differences, 0, 'step ' + i + ': the resident equals the full read');
        assert.equal(done.full, 0, 'step ' + i + ': not a full read');
        checks++;
      }
      assert.equal(p.replays.resident.residentStats().checks, checks);
      // An unsupported writer changes a row without any mark (raw SQL, no clock transaction).
      await unmarked(p.tenant, 'a-sgv-' + (T0 - 5 * MIN));
      const repaired = await cycle(p, at + MIN, { label: 'unmarked change with the self-check' });
      assert.equal(repaired.differences, 1, 'the self-check counts the difference'); assert.equal(repaired.full, 1, 'and repairs from the full read');
    });

    it('through the scheduler: writes racing with cycles all reach durable output, every tail read checked against a full read', async function () {
      // The lab's evaluator (activity scheduler, typed checkpoint, shipping component) with the self-check on every read.
      lab.residentCheckMs = 0;
      await store.close(); // one owner per work consumer: the lab's evaluator takes it
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        for (const [i, tenant] of lab.tenants.entries()) await seed(tenant, 'e' + i, Math.floor(Date.now() / MIN) * MIN - 10 * MIN);
        const evaluator = await lab.startEvaluator({ sweepMs: 500, concurrency: 2 });
        const expected = new Map();
        for (let i = 0; i < 40; i++) {
          for (const [n, tenant] of lab.tenants.entries()) {
            const date = Date.now() - 1000 + n; // rising per tenant
            await insert(tenant, 'entries', sgv('race-' + n + '-' + i, 100 + i, date));
            if (i % 5 === 2) await insert(tenant, 'entries', sgv('race-late-' + n + '-' + i, 90, date - 6 * HOUR - i)); // backdated, lowers the mark
            if (i % 5 === 3) await remove(tenant, 'entries', 'race-late-' + n + '-' + (i - 1)); // and a deletion of an old row
            expected.set(tenant, date);
          }
          await sleep(i % 3 ? 5 : 60); // some writes land inside a running cycle, some between cycles
        }
        const deadline = Date.now() + 60000;
        let rows;
        do { await sleep(200); rows = await lab.outputs(); }
        while (Date.now() < deadline && !rows.every(row => row.pending === null && Number(row.last) >= expected.get(row.tenant)));
        for (const row of rows) { assert.equal(row.pending, null, 'nothing pending'); assert.ok(Number(row.last) >= expected.get(row.tenant), 'the newest reading reached durable output'); }
        const stats = lab.replay.residentStats();
        assert.deepEqual(evaluator.stats.errors, []);
        assert.ok(stats.tail >= 20, 'tail reads: ' + JSON.stringify(stats));
        assert.ok(stats.checks >= stats.tail, 'every tail read was checked');
        assert.equal(stats.differences, 0, 'no resident differed from its snapshot\'s full read');
        assert.deepEqual(Object.keys(stats.reasons).filter(reason => !['no-resident', 'unbounded-change'].includes(reason)), [], JSON.stringify(stats.reasons));
        await lab.evaluator.close(); lab.evaluator = null;
      } finally { lab.residentCheckMs = undefined; }
    });

    it('a database built from the previous work catalogue is brought forward by migration 0009 and the pending-writer grants', async function () {
      const { run: migrate } = require('../lib/migrations/postgres');
      const { check } = require('../lib/writer-driven/schema');
      const writerDriven = require('../lib/writer-driven');
      const current = require('../migrations/candidates/postgres-evaluator-work-v2.json');
      const previous = { ...current, migrations: current.migrations.filter(m => !['0009_evaluator_window_mark', '0010_evaluator_completion_lag'].includes(m.name)) };
      assert.equal(previous.migrations.length, current.migrations.length - 2);
      const namespace = lab.base.name + '_seed', table = '"' + namespace + '".tenant_consumer_checkpoint', admin = lab.admin, writer = lab.base.role;
      const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI, tenant = lab.tenants[0], selected = { table, consumer: lab.COMPLETED };
      const exact = { touched: true, full: false, profile: false, entries: '1700000000000', devicestatus: null, treatments: null };
      // As the writer role, bound to its tenant, in one transaction that is rolled back or committed.
      async function asWriter (fn, commit = true) {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE "' + writer + '"');
          await admin.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant]);
          const value = await fn((text, values) => admin.query(text, values));
          await admin.query(commit ? 'COMMIT' : 'ROLLBACK');
          return value;
        } catch (error) { await admin.query('ROLLBACK'); throw error; }
      }
      const row = async () => (await admin.query('SELECT work_observed, window_mark_version::text AS version, window_mark_full AS full, window_mark_entries::text AS entries FROM ' + table + ' WHERE tenant_id=$1', [tenant])).rows[0];
      await admin.query('CREATE SCHEMA "' + namespace + '"');
      try {
        // The seed: the previous catalogue, a provisioned and completed work row, the previous grants.
        await migrate('up', { direct: true, connectionString: uri, namespace, catalogue: previous });
        await admin.query(`INSERT INTO ${table} (tenant_id,consumer,contract_digest,checkpoint,projection,work_version,work_observed,work_completed,work_observed_at)
          VALUES ($1,$2,$3,0,'[{"kind":"evaluator-work-v2","output":null}]'::jsonb,2,'{4,NULL,NULL,NULL,NULL,1}','{4,NULL,NULL,NULL,NULL,1}','{1,NULL,NULL,NULL,NULL,1}')`, [tenant, lab.COMPLETED, 'a'.repeat(64)]);
        await admin.query(`GRANT USAGE ON SCHEMA "${namespace}" TO "${writer}"`);
        await admin.query(`GRANT SELECT(tenant_id,consumer,work_version,work_observed,work_pending_at), UPDATE(work_observed,work_observed_at,work_pending_at) ON ${table} TO "${writer}"`);
        // This build's evaluator refuses to start on it: one migration is pending.
        await assert.rejects(check([{ connectionString: uri, namespace, catalogue: current }]), { code: 'EVALUATOR_SCHEMA_REFUSED' });
        // Brought forward: only 0009 and 0010 run, and existing rows take the defaults.
        await migrate('up', { direct: true, connectionString: uri, namespace, catalogue: current });
        await check([{ connectionString: uri, namespace, catalogue: current }]);
        assert.deepEqual(await row(), { work_observed: ['4', null, null, null, null, '1'], version: null, full: false, entries: null });
        // With the previous grants: the mark without the switch is the unchanged statement and still works;
        // the mark with the switch needs the new column grants.
        process.env[windowMark.SWITCH] = '0';
        try { await asWriter(query => writerDriven.mark(query, selected, tenant, { floor: 0, at: 5 })); } finally { process.env[windowMark.SWITCH] = '1'; }
        assert.deepEqual((await row()).work_observed, ['5', null, null, null, null, '1']);
        await assert.rejects(asWriter(query => writerDriven.mark(query, selected, tenant, { floor: 0, at: 6, window: exact })), { code: '42501' });
        for (const sql of writerDriven.grants({ namespace, roles: [writer] })) await admin.query(sql);
        // The row is pending (the mark above) and was never synchronized: this mark accumulates, the version stays unknown, the evaluator reads in full.
        await asWriter(query => writerDriven.mark(query, selected, tenant, { floor: 0, at: 6, window: exact }));
        assert.deepEqual(await row(), { work_observed: ['6', null, null, null, null, '1'], version: null, full: false, entries: '1700000000000' });
        // Once everything observed is completed, the next mark starts afresh and the row is synchronized.
        await admin.query("UPDATE " + table + " SET work_completed=work_observed, work_pending_at=NULL WHERE tenant_id=$1", [tenant]);
        await asWriter(query => writerDriven.mark(query, selected, tenant, { floor: 0, at: 7, window: { ...exact, entries: '1700000300000' } }));
        assert.deepEqual(await row(), { work_observed: ['7', null, null, null, null, '1'], version: '8', full: false, entries: '1700000300000' });
      } finally { await admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE'); }
    });

    // ---- controls: each wrong build must fail the scenario that guards it
    // A replay factory over a resident-window module with one line replaced.
    const PLAN = '  const selected = plan({ resident, tenant, generation, policy, mark, membership });';
    function brokenReplay (replacement) {
      globalThis.__residentWindowBroken = brokenModule('../lib/storage/resident-window', PLAN, replacement);
      try {
        return brokenModule('../lib/storage/postgres-durable-replay', "const residentWindow = require('./resident-window');", 'const residentWindow = globalThis.__residentWindowBroken;');
      } finally { delete globalThis.__residentWindowBroken; }
    }
    async function refused (run, label) {
      await assert.rejects(run, error => error instanceof assert.AssertionError && /byte for byte|b's window/.test(error.message), label + ' must be detected');
    }

    it('control: an ignored affected time leaves a stale tail (detected)', async function () {
      const broken = brokenReplay(PLAN.replace('const selected =', 'const planned =') +
        '\n  const selected = planned.full ? planned : { ...planned, from: {}, profile: false };');
      const { p } = await warm(lab.tenants[0], 'a', { factory: broken });
      await insert(p.tenant, 'entries', sgv('a-new-1', 123, T0 + MIN));
      await refused(() => cycle(p, T0 + 2 * MIN, { label: 'new reading' }), 'a stale tail');
    });

    it('control: a generation change that does not invalidate the resident (detected)', async function () {
      const broken = brokenReplay(PLAN.replace('tenant, generation,', 'tenant, generation: resident ? resident.generation : generation,'));
      const { p } = await warm(lab.tenants[0], 'a', { factory: broken });
      // A restore in flight: data replaced and generation moved, its activation mark not yet written.
      await lab.admin.query('UPDATE ' + lab.lifecycleTable + ' SET generation=generation+1 WHERE tenant_id=$1', [p.tenant]);
      await lab.admin.query(`DELETE FROM "${lab.base.namespaces.entries}".entries WHERE tenant_id=$1 AND (doc->>'date')::bigint > $2`, [p.tenant, T0 - HOUR]);
      await refused(() => cycle(p, T0 + 2 * MIN, { label: 'after the restore', complete: false }), 'rows of the previous generation');
    });

    it('control (green): the same restore in flight with the generation check reads in full', async function () {
      const { p } = await warm(lab.tenants[0], 'a');
      await lab.admin.query('UPDATE ' + lab.lifecycleTable + ' SET generation=generation+1 WHERE tenant_id=$1', [p.tenant]);
      await lab.admin.query(`DELETE FROM "${lab.base.namespaces.entries}".entries WHERE tenant_id=$1 AND (doc->>'date')::bigint > $2`, [p.tenant, T0 - HOUR]);
      const step = await cycle(p, T0 + 2 * MIN, { label: 'after the restore', complete: false });
      mode(step, { full: 1 }); assert.deepEqual(step.reasons, { generation: 1 });
    });

    it('control: marks cleared without the version fence lose a write (detected)', async function () {
      // Every mark starts afresh, whether or not earlier marks were completed.
      const fresh = '(' + windowMark.total('work_completed') + '=' + windowMark.total('work_observed') + ')';
      globalThis.__residentWindowBrokenMark = { ...require('../lib/writer-driven'), ...brokenModule('../lib/writer-driven/index.js',
        'return base.slice(0, at) + windowMark.assignments(i + 1) + base.slice(at);',
        'return base.slice(0, at) + windowMark.assignments(i + 1).split(' + JSON.stringify(fresh) + ").join('true') + base.slice(at);") };
      try {
        const brokenClock = brokenModule('../lib/storage/postgres-write-clock', "const writerDriven = require('../writer-driven');", 'const writerDriven = globalThis.__residentWindowBrokenMark;');
        const clock = brokenClock(lab.base.raw[0], lab.base.namespaces.clock, { pending: { table: lab.workTable, consumer: lab.COMPLETED } });
        const set = storageWriters(clock);
        const { p } = await warm(lab.tenants[0], 'a');
        // Two writes before one cycle, the older first: the second mark must not clear the first.
        await insert(p.tenant, 'entries', sgv('a-late', 240, T0 - 20 * HOUR + 500), set);
        await insert(p.tenant, 'entries', sgv('a-new', 131, T0 + MIN), set);
        await refused(() => cycle(p, T0 + 2 * MIN, { label: 'late then new' }), 'a mark lost without its fence');
      } finally { delete globalThis.__residentWindowBrokenMark; }
    });

    it('control: an unmarked change with the self-check disabled stays stale (detected)', async function () {
      const { p } = await warm(lab.tenants[0], 'a'); // checkMs: one day
      await unmarked(p.tenant, 'a-sgv-' + (T0 - 5 * MIN));
      await refused(() => cycle(p, T0 + 2 * MIN, { label: 'unmarked change without the self-check' }), 'an unmarked change');
    });

    it('control: a resident used for another tenant puts its rows in that tenant\'s window (detected)', async function () {
      // The plan's refusals removed: a resident that is handed in is used as it is.
      const broken = brokenReplay(PLAN.replace('const selected = plan(',
        'const selected = resident ? { full: false, from: {}, profile: false, consumed: true } : plan('));
      const shared = replays({ factory: broken });
      await seed(lab.tenants[0], 'a'); await seed(lab.tenants[1], 'b');
      const a = pair(lab.tenants[0], shared), b = pair(lab.tenants[1], shared);
      await cycle(a, T0, { label: 'a first' }); await cycle(b, T0, { label: 'b first' });
      const policy = require('../lib/storage/clinical-working-set-policy').create(lab.base.env, T0 + MIN);
      const mine = await scope.withTenant(a.tenant, () => shared.resident.window({ ...SIZE, policy }));
      await refused(async () => {
        const crossed = await scope.withTenant(b.tenant, () => shared.resident.window({ ...SIZE, policy, resident: mine.resident }));
        const expected = await scope.withTenant(b.tenant, () => shared.full.window({ ...SIZE, policy }));
        assert.equal(JSON.stringify(crossed.rows), JSON.stringify(expected.rows), 'b\'s read with a\'s resident is b\'s window');
      }, 'a cross-tenant row');
    });
  });
