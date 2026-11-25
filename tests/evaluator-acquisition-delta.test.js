'use strict';

// Differential check of the acquisition switch
// (lib/data/acquisition-delta.js): NS_EVAL_ENCODE_DELTA.
//
// Two shipping level components read identical stores through the resident
// window stand-in (tests/lib/resident-window/differential.js), one with the
// switch on and one with it off; every cycle result must be the same text.
// The replay is the resident working set's: 1,201 minutes with edited,
// deleted, back-dated and re-timed statuses, back-dated, edited and deleted
// treatments and readings, a profile change, a restore (new generation), a
// settings change and an eviction.
//
// Control, detected by the same comparison: a changed row is handed the row
// prepared from the document it replaced (the lookup goes by typed identity,
// not by the document).
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

// Every arm states the switch, so the suite gives the same result whatever the environment sets.
const NONE = { encodeDelta: false };
const ON = { residentWorkingSet: true, encodeDelta: true };
const RWS = { residentWorkingSet: true, ...NONE };
const what = 'the acquisition switch gives the unswitched cycle result';

describe('acquisition delta switch (differential against the switch off)', function () {
  this.timeout(600000);
  let previous, before;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); clock.install(); before = { ...acquisitionDelta.counters }; });
  afterEach(() => { clock.uninstall(); scope.setTenancyMode(previous); });
  const since = () => Object.fromEntries(Object.keys(before).map(key => [key, acquisitionDelta.counters[key] - before[key]]));

  it('reads its switch strictly, and it is off by default', function () {
    const name = acquisitionDelta.ENCODE;
    assert.equal(name, 'NS_EVAL_ENCODE_DELTA');
    for (const off of [undefined, null, '', '0', 'off', false]) assert.equal(acquisitionDelta.parse(name, off), false);
    for (const on of ['1', 'on', true]) assert.equal(acquisitionDelta.parse(name, on), true);
    assert.throws(() => acquisitionDelta.parse(name, 'yes'), new RegExp(name + ' is 1 or 0'));
    const make = extra => evaluator({ tenant: TENANT, replay: memory({ tenant: TENANT }).replay, env: ENVS.loop(), language: require('../lib/language')(), includeFrame: true, ...extra,
      connection: { async query () {} }, dbstats: async () => ({}), maxRows: 10, maxBytes: 1000 });
    assert.throws(() => make({ encodeDelta: 'true' }), /NS_EVAL_ENCODE_DELTA is 1 or 0/);
  });

  it('with the switch off nothing is carried or asked for in stored form', async function () {
    assert.equal(await replay({ minutes: 30, levers: 'all', on: RWS, off: RWS, what }), 31);
    assert.deepEqual(since(), { carried: 0, prepared: 0 });
  });

  it('gives the unswitched result on every minute of the replay, beside the resident working set and the window levers', async function () {
    assert.equal(await replay({ minutes: 1200, levers: 'all', on: ON, off: RWS, what }), 1201);
    const did = since();
    assert.ok(did.carried > 50 * did.prepared && did.prepared > 1000, 'unchanged rows were handed their prepared row: ' + JSON.stringify(did));
  });

  it('gives the unswitched result over the mutations, window levers and resident working set off', async function () {
    assert.equal(await replay({ minutes: 620, levers: '0', on: { residentWorkingSet: false, encodeDelta: true }, off: { residentWorkingSet: false, ...NONE }, what }), 621);
    assert.ok(since().carried > 0, JSON.stringify(since()));
  });

  it('gives the unswitched result against the whole base (levers and resident working set off in the other arm)', async function () {
    assert.equal(await replay({ minutes: 620, levers: 'all', on: ON, off: { residentWorkingSet: false, ...NONE }, what }), 621);
  });

  // ---- The restore fence and what may be carried.
  it('carries nothing across a restore generation, a settings change or an eviction', async function () {
    const now = Math.floor(clock.RealDate.now() / MIN) * MIN;
    const pair = arms(ENVS.loop, 'all', { on: ON, off: RWS, what });
    const step = async (at, changes, options) => { if (changes) pair.write(changes, { at, ...options }); const from = { ...acquisitionDelta.counters }; await cycle(pair, at, { label: 'at ' + (at - now) / MIN });
      return { carried: acquisitionDelta.counters.carried - from.carried, prepared: acquisitionDelta.counters.prepared - from.prepared }; };
    try {
      const seed = [];
      for (let i = 0; i < 40; i++) seed.push(reading('e-' + i, 100 + i, now - (40 - i) * 5 * MIN), status('s-' + i, now - (40 - i) * 5 * MIN));
      seed.push(row('treatments', { _id: 't-1', eventType: 'Temp Basal', created_at: iso(now - HOUR), duration: 30, absolute: 0.7 }));
      const first = await step(now, seed, { exact: false });
      assert.deepEqual([first.carried, first.prepared], [0, 81], 'the first acquisition prepares every row');
      const second = await step(now + MIN, [reading('e-new', 150, now + MIN - 5000)]);
      assert.deepEqual([second.carried, second.prepared], [81, 1], 'the next prepares the new row only');
      // A restore: the generation moves and the data is replaced without a window mark.
      pair.each(arm => { arm.db.state.generation = '2'; arm.db.write([gone('entries', 'e-3'), status('s-5', now - 35 * 5 * MIN, 31)], { at: now + 2 * MIN, aware: false });
        arm.db.work.version = String(BigInt(arm.db.work.version || 0) + 1n); });
      const restored = await step(now + 2 * MIN);
      assert.deepEqual([restored.carried, restored.prepared], [0, 81], 'after a restore every row is prepared again');
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

  // ---- Control: the deliberately wrong step must be detected by the comparison above.
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
});
