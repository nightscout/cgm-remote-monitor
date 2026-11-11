'use strict';

// Evaluator cost lane: what one evaluation shares with the next.
//
// A plugin may change anything it is handed: the working set's documents,
// the moments the device-status helpers attach to them, the properties
// object. Nothing it changes may reach a later cycle. The hostile plugin
// below (the real bgnow, wrapped) changes everything it can reach during one
// cycle; the next cycles of that component must equal, field for field, those
// of a component that never met it. A hostile cycle that changes nothing
// would make this vacuous, so it must itself differ from the clean output.
const assert = require('node:assert/strict');
const createLab = require('./fixtures/tenant-projection-evaluator');
const scope = require('../lib/storage/tenant-scope');
const { SCENARIOS } = require('./lib/views-equality/fixtures');
const { optInSuite } = require('./support/opt-in');

const BGNOW = require.resolve('../lib/plugins/bgnow');

function vandalise (value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (typeof value.add === 'function' && typeof value.isValid === 'function') { // a moment
    if (value.isValid()) value.add(7, 'hours');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) vandalise(item, seen);
    value.push({ _id: 'vandal', mills: 1, created_at: '1970-01-01T00:00:00Z', sgv: 400, mgdl: 400, insulin: 9, carbs: 90 });
    value.reverse();
    return;
  }
  if (Object.isFrozen(value)) return;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v === 'number') value[key] = v + 1000;
    else if (typeof v === 'string' && key !== '_id') value[key] = 'MUTATED';
    else vandalise(v, seen);
  }
  value.vandalised = true;
}

function hostileBgnow () {
  const original = require.cache[BGNOW].exports;
  const hostile = { active: false, cycles: 0 };
  require.cache[BGNOW].exports = function wrapped (ctx) {
    const plugin = original(ctx);
    const setProperties = plugin.setProperties, check = plugin.checkNotifications;
    plugin.setProperties = function (sbx) {
      const out = setProperties.call(this, sbx);
      if (hostile.active) { hostile.cycles++; vandalise(sbx.data); }
      return out;
    };
    // after every plugin's setProperties: the moments and properties they made
    plugin.checkNotifications = function (sbx) {
      if (hostile.active) { vandalise(sbx.data); vandalise(sbx.properties); }
      return check ? check.call(this, sbx) : undefined;
    };
    return plugin;
  };
  return { hostile, restore () { require.cache[BGNOW].exports = original; } };
}

const output = result => JSON.parse(JSON.stringify({ emitted: result.emitted, requested: result.requested,
  properties: result.properties, due: result.due }));

optInSuite(process.env.NS_TENANT_PROJECTION_EVALUATOR_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_PROJECTION_EVALUATOR_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'evaluator cost lane: no change made during one cycle reaches the next', function () {
    this.timeout(60000);
    const lab = createLab();
    const at = Date.UTC(2026, 10, 6, 12);
    before(() => lab.open());
    beforeEach(() => lab.reset());
    after(() => lab.close());

    // Candidate E: an acquisition keeps its retained rows only for the same
    // change signature. A hard delete leaves the clock floor (the checkpoint)
    // where it was; only the signature's row count and digest move.
    it('EV_COST_E_SAME_CHECKPOINT an acquisition after a hard delete at the same checkpoint sees the delete', async function () {
      const reading = (id, value, minutes) => ({ _id: id, type: 'sgv', sgv: value, date: at - minutes * 60000,
        dateString: new Date(at - minutes * 60000).toISOString(), direction: 'Flat' });
      await lab.persistDomains({ entries: [reading('older', 111, 7), reading('newer', 222, 2)] });
      await lab.provisionView();
      await lab.at(at, async () => {
        const v = lab.evaluator();
        const first = await v.evaluate({ at });
        assert.equal(first.properties.bgnow.last, 222);
        const unchanged = await v.evaluate({ at: at + 1000 });
        assert.deepEqual(unchanged.signature, first.signature);
        assert.equal(unchanged.properties.bgnow.last, 222);
        await lab.admin.query(`DELETE FROM "${lab.namespaces.entries}".entries WHERE tenant_id=$1 AND doc->>'_id'='newer'`, [lab.A]);
        const after = await v.evaluate({ at: at + 2000 });
        assert.equal(after.checkpoint, first.checkpoint, 'the delete did not move the checkpoint');
        assert.notDeepEqual(after.signature, first.signature, 'the delete moved the signature');
        assert.equal(after.properties.bgnow.last, 111, 'the evaluation sees the delete');
      });
    });

    // Decision view-reads-total-order: the evaluator's snapshot carries each
    // row's insertion ordinal from the tables whose catalogue has one.
    it('EV_COST_A_ORDINALS the evaluator snapshot carries insertion ordinals in insertion order', async function () {
      const reading = (id, minutes) => ({ _id: id, type: 'sgv', sgv: 100, date: at - minutes * 60000, dateString: new Date(at - minutes * 60000).toISOString() });
      await lab.persistDomains({ entries: [reading('z-first', 2)] });
      await lab.persistDomains({ entries: [reading('a-second', 2)] });
      await lab.provisionView();
      const recovered = await scope.withTenant(lab.A, () => lab.consumer().reconcile({ maxRows: 100, maxBytes: 1e6, signature: true }));
      const entries = recovered.rows.filter(row => row.domain === 'entries');
      const byId = Object.fromEntries(entries.map(row => [row.document._id, row.ordinal]));
      assert.ok(Number.isSafeInteger(byId['z-first']) && Number.isSafeInteger(byId['a-second']), JSON.stringify(byId));
      assert.ok(byId['z-first'] < byId['a-second'], 'insertion order, not identity order');
      const plain = await scope.withTenant(lab.A, () => lab.consumer().reconcile({ maxRows: 100, maxBytes: 1e6 }));
      assert.equal(plain.rows.some(row => 'ordinal' in row), false, 'other consumers see the rows as before');
    });

    // Candidate A: the views' reads are answered in process. A time-only
    // cycle sends no statement; an acquisition sends only the replay's.
    it('EV_COST_A_NO_STATEMENTS a time-only cycle sends no statement to PostgreSQL', async function () {
      const records = SCENARIOS.steady(at);
      for (const [logical, docs] of Object.entries(records)) records[logical] = docs.map((doc, i) => ({ ...doc, _id: logical + '-' + i }));
      await lab.persistDomains(records);
      await lab.provisionView();
      const counted = { evaluator: 0, replay: 0 };
      const counting = (name, connection) => new Proxy(connection, { get (target, key) {
        const value = Reflect.get(target, key);
        if (key === 'query') return (...args) => { counted[name]++; return value.apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const v = lab.evaluator(lab.A, { connection: counting('evaluator', lab.reader), replay: lab.consumer('clinical-view', counting('replay', lab.reader)) });
      await lab.at(at, async () => {
        const first = await v.evaluate({ at });
        assert.ok(counted.replay > 0, 'the acquisition read the replay');
        assert.equal(counted.evaluator, 0, 'the views read nothing through PostgreSQL');
        const before = { ...counted };
        for (let i = 1; i <= 5; i++) await v.evaluateTime({ at: at + i * 1000 });
        assert.deepEqual(counted, before, 'five time-only cycles sent no statement');
        assert.ok(first.properties.bgnow, 'the cycle computed');
      });
    });

    for (const name of ['steady', 'urgentLow', 'recentTreatment', 'loopFailing', 'crowdedStatus', 'aapsLoopStopped', 'openapsEnactedOnly', 'pumpRepost'].filter(n => SCENARIOS[n])) {
      it('EV_COST_MUTATION_GUARD ' + name + ': a plugin that changes everything changes no later cycle', async function () {
        const records = SCENARIOS[name](at);
        for (const [logical, docs] of Object.entries(records)) records[logical] = docs.map((doc, i) => ({ ...doc, _id: logical + '-' + i }));
        await lab.persistDomains(records);
        await lab.provisionView();
        await lab.at(at, async () => {
          require(BGNOW);
          const patch = hostileBgnow();
          let vandal;
          try { vandal = lab.evaluator(); } finally { patch.restore(); }
          const clean = lab.evaluator();
          const step = 60000;
          const pair = async (when, kind) => [output(await vandal[kind]({ at: when })), output(await clean[kind]({ at: when }))];
          let [v, c] = await pair(at, 'evaluate');
          assert.deepStrictEqual(v, c, 'inactive hostile plugin: same output');
          patch.hostile.active = true;
          const spoiled = output(await vandal.evaluateTime({ at: at + step }));
          patch.hostile.active = false;
          assert.ok(patch.hostile.cycles > 0, 'the hostile plugin ran');
          assert.notDeepStrictEqual(spoiled, output(await clean.evaluateTime({ at: at + step })),
            'the hostile cycle changed its own output (non-vacuity)');
          for (let i = 2; i < 6; i++) {
            [v, c] = await pair(at + i * step, 'evaluateTime');
            assert.deepStrictEqual(v, c, 'time-only cycle ' + i + ' after the hostile cycle');
          }
          [v, c] = await pair(at + 6 * step, 'evaluate');
          assert.deepStrictEqual(v, c, 'acquisition after the hostile cycle');
          [v, c] = await pair(at + 7 * step, 'evaluateTime');
          assert.deepStrictEqual(v, c, 'time-only cycle after that acquisition');
        });
      });
    }
  });
