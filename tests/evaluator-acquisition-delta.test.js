'use strict';

// Differential check of the two acquisition switches
// (lib/data/acquisition-delta.js): NS_EVAL_ENCODE_DELTA and
// NS_EVAL_VIEW_READS_RESIDENT.
//
// Two shipping level components read identical stores through the resident
// window stand-in (tests/lib/resident-window/differential.js), one with the
// switch on and one with it off; every cycle result must be the same text.
// The replay is the resident working set's: 1,201 minutes with edited,
// deleted, back-dated and re-timed statuses, back-dated, edited and deleted
// treatments and readings, a profile change, a restore (new generation), a
// settings change and an eviction.
//
// Controls, each detected by the same comparison:
//   - encode: a changed row is handed the row prepared from the document it
//     replaced (the lookup goes by typed identity, not by the document);
//   - reads: a row that left stays in a carried order; a new row is put at
//     the end of a carried order instead of in its place (seen in a read with
//     a limit: the loader orders the rest itself).
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const acquisitionDelta = require('../lib/data/acquisition-delta');
const projectionRead = require('../lib/storage/postgres-projection-read');
const memoryRead = require('../lib/storage/projection-memory-read');
const windowLevers = require('../lib/data/window-levers');
const memory = require('./lib/resident-window/memory-replay');
const clock = require('./lib/views-replay/clock');
const { TENANT, ENVS, replay, arms, cycle, row, gone, status, reading, iso } = require('./lib/resident-window/differential');
const { MIN, HOUR } = require('./lib/views-equality/fixtures');

// Every arm states both switches, so the suite gives the same result whatever the environment sets.
const NONE = { encodeDelta: false, viewReadsResident: false };
const BOTH = { residentWorkingSet: true, encodeDelta: true, viewReadsResident: true };
const RWS = { residentWorkingSet: true, ...NONE };
const what = 'the acquisition switches give the unswitched cycle result';

describe('acquisition delta switches (differential against the switches off)', function () {
  this.timeout(600000);
  let previous, before;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); clock.install(); before = { ...acquisitionDelta.counters }; });
  afterEach(() => { clock.uninstall(); scope.setTenancyMode(previous); });
  const since = () => Object.fromEntries(Object.keys(before).map(key => [key, acquisitionDelta.counters[key] - before[key]]));

  it('reads its switches strictly, and both are off by default', function () {
    for (const name of [acquisitionDelta.ENCODE, acquisitionDelta.READS]) {
      for (const off of [undefined, null, '', '0', 'off', false]) assert.equal(acquisitionDelta.parse(name, off), false);
      for (const on of ['1', 'on', true]) assert.equal(acquisitionDelta.parse(name, on), true);
      assert.throws(() => acquisitionDelta.parse(name, 'yes'), new RegExp(name + ' is 1 or 0'));
    }
    assert.deepEqual([acquisitionDelta.ENCODE, acquisitionDelta.READS], ['NS_EVAL_ENCODE_DELTA', 'NS_EVAL_VIEW_READS_RESIDENT']);
    const make = extra => evaluator({ tenant: TENANT, replay: memory({ tenant: TENANT }).replay, env: ENVS.loop(), language: require('../lib/language')(), includeFrame: true, ...extra,
      connection: { async query () {} }, dbstats: async () => ({}), maxRows: 10, maxBytes: 1000 });
    assert.throws(() => make({ encodeDelta: 'true' }), /NS_EVAL_ENCODE_DELTA is 1 or 0/);
    assert.throws(() => make({ viewReadsResident: 'true' }), /NS_EVAL_VIEW_READS_RESIDENT is 1 or 0/);
  });

  it('with both switches off nothing is carried, ordered or asked for in stored form', async function () {
    assert.equal(await replay({ minutes: 30, levers: 'all', on: RWS, off: RWS, what }), 31);
    assert.deepEqual(since(), { carried: 0, prepared: 0, orderedReads: 0, ordersSorted: 0, ordersCarried: 0 });
  });

  it('gives the unswitched result on every minute of the replay, both switches on, beside the resident working set and the window levers', async function () {
    assert.equal(await replay({ minutes: 1200, levers: 'all', on: BOTH, off: RWS, what }), 1201);
    const did = since();
    assert.ok(did.carried > 50 * did.prepared && did.prepared > 1000, 'unchanged rows were handed their prepared row: ' + JSON.stringify(did));
    assert.ok(did.orderedReads > 1000 && did.ordersCarried > 500 && did.ordersSorted < did.ordersCarried / 10, 'sorted reads used carried orders: ' + JSON.stringify(did));
  });

  for (const [name, on] of [['the encode switch alone', { ...NONE, encodeDelta: true }], ['the reads switch alone', { ...NONE, viewReadsResident: true }], ['both', { encodeDelta: true, viewReadsResident: true }]]) {
    it('gives the unswitched result over the mutations, window levers and resident working set off: ' + name, async function () {
      assert.equal(await replay({ minutes: 620, levers: '0', on: { residentWorkingSet: false, ...on }, off: { residentWorkingSet: false, ...NONE }, what }), 621);
      const did = since();
      assert.equal(did.carried > 0, on.encodeDelta === true, JSON.stringify(did));
      assert.equal(did.ordersCarried > 0, on.viewReadsResident === true, JSON.stringify(did));
    });
  }

  it('gives the unswitched result against the whole base (levers and resident working set off in the other arm)', async function () {
    assert.equal(await replay({ minutes: 620, levers: 'all', on: BOTH, off: { residentWorkingSet: false, ...NONE }, what }), 621);
  });

  // ---- The restore fence and what may be carried.
  it('carries nothing across a restore generation, a settings change or an eviction', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const pair = arms(ENVS.loop, 'all', { on: BOTH, off: RWS, what });
    const step = async (at, changes, options) => { if (changes) pair.write(changes, { at, ...options }); const from = { ...acquisitionDelta.counters }; await cycle(pair, at, { label: 'at ' + (at - now) / MIN });
      return { carried: acquisitionDelta.counters.carried - from.carried, prepared: acquisitionDelta.counters.prepared - from.prepared, sorted: acquisitionDelta.counters.ordersSorted - from.ordersSorted }; };
    try {
      const seed = [];
      for (let i = 0; i < 40; i++) seed.push(reading('e-' + i, 100 + i, now - (40 - i) * 5 * MIN), status('s-' + i, now - (40 - i) * 5 * MIN));
      seed.push(row('treatments', { _id: 't-1', eventType: 'Temp Basal', created_at: iso(now - HOUR), duration: 30, absolute: 0.7 }));
      const first = await step(now, seed, { exact: false });
      assert.deepEqual([first.carried, first.prepared], [0, 81], 'the first acquisition prepares every row');
      const second = await step(now + MIN, [reading('e-new', 150, now + MIN - 5000)]);
      assert.deepEqual([second.carried, second.prepared, second.sorted], [81, 1, 0], 'the next prepares the new row only, and sorts nothing');
      // A restore: the generation moves and the data is replaced without a window mark.
      pair.each(arm => { arm.db.state.generation = '2'; arm.db.write([gone('entries', 'e-3'), status('s-5', now - 35 * 5 * MIN, 31)], { at: now + 2 * MIN, aware: false });
        arm.db.work.version = String(BigInt(arm.db.work.version || 0) + 1n); });
      const restored = await step(now + 2 * MIN);
      assert.deepEqual([restored.carried, restored.prepared], [0, 81], 'after a restore every row is prepared again');
      assert.ok(restored.sorted > 0, 'and every order is sorted again');
      const after = await step(now + 3 * MIN, [reading('e-newer', 151, now + 3 * MIN - 5000)]);
      assert.deepEqual([after.carried, after.prepared], [81, 1]);
      for (const arm of [pair.on, pair.off]) await scope.withTenant(TENANT, async () => arm.component.reconfigure({ env: ENVS.loop({ bgHigh: 220, bgTargetTop: 180, bgTargetBottom: 80, bgLow: 65 }) }));
      const settings = await step(now + 4 * MIN);
      assert.equal(settings.carried, 0, 'after a settings change every row is prepared again');
      await step(now + 5 * MIN, [reading('e-newest', 152, now + 5 * MIN - 5000)]);
      for (const arm of [pair.on, pair.off]) await scope.withTenant(TENANT, async () => arm.component.evict());
      const evicted = await step(now + 6 * MIN);
      assert.equal(evicted.carried, 0, 'after an eviction every row is prepared again');
    } finally { pair.close(); }
  });

  it('hands over a prepared row only for the same frozen document and kind, and only from its own memo', function () {
    const known = projectionRead.memo();
    const doc = Object.freeze({ _id: 'a', sgv: 100 });
    const one = projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc, ordinal: 1 }], maxRows: 10, maxBytes: 1000, known });
    const two = projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc, ordinal: 1 }], maxRows: 10, maxBytes: 1000, known });
    assert.equal(two.memory[0], one.memory[0], 'the same frozen document: the same prepared row');
    const moved = projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc, ordinal: 2 }], maxRows: 10, maxBytes: 1000, known });
    assert.ok(moved.memory[0] !== one.memory[0] && moved.memory[0].doc === one.memory[0].doc && moved.memory[0].ordinal === 2, 'another ordinal: a new row over the same document');
    const equal = projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc: { _id: 'a', sgv: 100 }, ordinal: 1 }], maxRows: 10, maxBytes: 1000, known });
    assert.ok(equal.memory[0] !== one.memory[0], 'an equal document that is not frozen is prepared, not handed over');
    const loose = { _id: 'b', sgv: 1 };
    projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc: loose, ordinal: 3 }], maxRows: 10, maxBytes: 1000, known });
    loose.sgv = 2;
    assert.equal(projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc: loose, ordinal: 3 }], maxRows: 10, maxBytes: 1000, known }).memory[0].doc.sgv, 2, 'a document that can change is read again');
    assert.throws(() => projectionRead.prepareEncoded({ rows: [], maxRows: 10, maxBytes: 1000, known: { prepared: new WeakMap() } }), /memo must be this module's/);
    for (const rows of [[{ id_kind: 'string', doc, ordinal: 1 }, { id_kind: 'string', doc: Object.freeze({ _id: 'a' }), ordinal: 2 }], [{ id_kind: 'other', doc, ordinal: 1 }], [{ id_kind: 'string', doc, ordinal: 0 }]]) {
      assert.throws(() => projectionRead.prepareEncoded({ rows, maxRows: 10, maxBytes: 1000, known }), TypeError, 'the refusals are the unswitched ones');
      assert.throws(() => projectionRead.prepareEncoded({ rows, maxRows: 10, maxBytes: 1000 }), TypeError);
    }
    assert.equal(projectionRead.prepareEncoded({ rows: [{ id_kind: 'string', doc, ordinal: 1 }, { id_kind: 'objectid', doc: Object.freeze({ _id: 'a' }), ordinal: 2 }], maxRows: 10, maxBytes: 1000, known }).rows, 2, 'one identity under two kinds is two rows');
  });

  it('fits a frozen status once, and a status that can change every time', function () {
    const at = 1800000000000, memo = projectionRead.memo();
    const statuses = n => Array.from({ length: n }, (_, i) => ({ id_kind: 'string', ordinal: i + 1, doc: Object.freeze({ _id: 's' + i, device: 'd', created_at: iso(at - 30 * HOUR - i * MIN), pump: Object.freeze({ clock: 'c', reservoir: 5 }) }) }));
    const rows = statuses(14);
    const plain = windowLevers.fitStatuses(rows, { at, env: ENVS.loop(), now: at });
    const first = windowLevers.fitStatuses(rows, { at, env: ENVS.loop(), now: at, memo });
    const second = windowLevers.fitStatuses(rows, { at, env: ENVS.loop(), now: at, memo });
    assert.deepEqual(first, plain);
    const fitted = first.map((out, i) => out !== rows[i]);
    assert.ok(fitted.includes(true) && fitted.includes(false), 'some are fitted and some whole');
    first.forEach((out, i) => { if (fitted[i]) assert.ok(out.doc === second[i].doc && Object.isFrozen(out.doc) && plain[i].doc !== out.doc); });
  });

  // ---- Controls: each deliberately wrong step must be detected by the comparison above.
  it('control (encode): a changed row handed the row its identity had before is detected', async function () {
    const real = memoryRead.delta.lookup, byIdentity = new Map();
    memoryRead.delta.lookup = (known, given) => {
      const name = given.id_kind + ':' + given.doc._id, hit = real(known, given) || byIdentity.get(name);
      if (hit) byIdentity.set(name, hit);
      return hit;
    };
    try {
      await assert.rejects(replay({ minutes: 620, levers: 'all', on: { ...RWS, encodeDelta: true }, off: RWS, what }), assert.AssertionError);
    } finally { memoryRead.delta.lookup = real; }
  });
  it('control (reads): a row that left stays in a carried order is detected', async function () {
    const real = memoryRead.orderSteps.keep;
    memoryRead.orderSteps.keep = sorted => sorted.slice();
    try {
      await assert.rejects(replay({ minutes: 620, levers: 'all', on: { ...RWS, viewReadsResident: true }, off: RWS, what }), assert.AssertionError);
    } finally { memoryRead.orderSteps.keep = real; }
  });

  // The loader orders what it is given, so a misplaced row shows only in a
  // read with a limit: the newest record of an event type (count 1). A site
  // change newer than the one resident, both older than the 60 h treatment
  // window, must become the one the read returns.
  async function newerSiteChange () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const pair = arms(ENVS.loop, 'all', { on: { ...RWS, viewReadsResident: true }, off: RWS, what });
    try {
      const seed = [row('treatments', { _id: 'site-old', eventType: 'Site Change', created_at: iso(now - 100 * HOUR) })];
      for (let i = 0; i < 12; i++) seed.push(reading('e-' + i, 100 + i, now - (12 - i) * 5 * MIN), status('s-' + i, now - (12 - i) * 5 * MIN));
      pair.write(seed, { exact: false, at: now });
      const first = await cycle(pair, now, { label: 'acquisition' });
      pair.write([row('treatments', { _id: 'site-new', eventType: 'Site Change', created_at: iso(now - 70 * HOUR) })], { at: now + MIN });
      const second = await cycle(pair, now + MIN, { label: 'acquisition with a newer site change' });
      return [first.properties.cage.age, second.properties.cage.age];
    } finally { pair.close(); }
  }
  it('returns the newest record of a limited read from a carried order', async function () {
    assert.deepEqual(await newerSiteChange(), [100, 70]);
    assert.ok(since().ordersCarried > 0);
  });
  it('control (reads): a new row put at the end of a carried order is detected', async function () {
    const real = memoryRead.orderSteps.place;
    memoryRead.orderSteps.place = (sorted, added) => { sorted.push(added); };
    try {
      await assert.rejects(newerSiteChange(), assert.AssertionError);
    } finally { memoryRead.orderSteps.place = real; }
  });
});
