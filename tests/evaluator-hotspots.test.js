'use strict';

// INC-E2: two CPU hotspots of the level evaluator, each with the same result
// as before. (Its third, NS_EVAL_CACHE_ADOPT, was removed 2026-11-22.)
//
// 1. dataloader mergeProcessSort (no switch): the merge that keeps an old
//    record unless a new record or an old one already kept has its _id, in
//    linear time where every id is a string. Checked against the quadratic
//    loop it replaces, kept here verbatim, over random lists with repeated,
//    numeric, missing and null ids.
// 2. NS_EVAL_CANONICAL_PREPASS (evaluator-runtime canonical): one sorting walk
//    and a plain JSON.stringify instead of a replacer called for every value.
//    Checked against the replacer pass and the recursive definition on edge
//    shapes, random values and every cycle result of the 1,201-minute replay.
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const evaluator = require('../lib/data/tenant-projection-evaluator');
const runtime = require('../lib/server/serve/evaluator-runtime');
const dataloader = require('../lib/data/dataloader');
const { jsonCopy } = require('../lib/data/json-copy');
const clock = require('./lib/views-replay/clock');
const { replay } = require('./lib/resident-window/differential');

// A seeded generator, so a failure names a reproducible case.
function seeded (seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

// ---- 1. mergeProcessSort, as it was (the quadratic loop), for comparison.
function byMillsThenId (a, b) {
  const byMills = a.mills - b.mills;
  if (byMills) return byMills;
  const aId = String(a._id);
  const bId = String(b._id);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}
function referenceMergeProcessSort (oldData, newData, ageLimit) {
  Object.keys(newData).forEach(key => {
    if (typeof newData[key] === 'object' && newData[key]) {
      if (Object.prototype.hasOwnProperty.call(newData[key], '_id') && newData[key]._id != null) newData[key]._id = newData[key]._id.toString();
      if (Object.prototype.hasOwnProperty.call(newData[key], 'created_at') && !Object.prototype.hasOwnProperty.call(newData[key], 'mills')) {
        newData[key].mills = new Date(newData[key].created_at).getTime();
      }
    }
  });
  const filtered = newData.filter(object => object._id != null && ((ageLimit && object.mills >= ageLimit) || !ageLimit));
  let merged;
  if (oldData && filtered) {
    merged = filtered;
    for (let i = 0; i < oldData.length; i++) {
      const oldElement = oldData?.[i];
      let found = false;
      for (let j = 0; j < filtered.length; j++) {
        if (oldElement?._id == filtered[j]._id) { found = true; break; }
      }
      if (!found) merged.push(oldElement);
    }
  } else merged = filtered;
  return merged.sort(byMillsThenId);
}
function outcome (fn) {
  try { return { value: fn() }; } catch (error) { return { error: error.constructor.name }; }
}

// ---- 2. Values for canonical.
class Instance { constructor () { this.b = 1; this.a = 2; } }
function canonicalShapes () {
  const dated = new Date(5); dated.z = 1; dated.a = 2;
  const deep = []; let at = deep; for (let i = 0; i < 300; i++) { const next = { z: i, a: [] }; at.push(next); at = next.a; }
  const holes = [1, , { b: 1, a: 2 }]; // eslint-disable-line no-sparse-arrays
  return [undefined, null, 0, -0, NaN, Infinity, 'x', [], {}, [undefined, () => 1, Symbol('s')], new Date(0), dated, [dated], { d: dated },
    { b: 1, a: { d: [3, { z: 1, y: undefined, x: () => 1 }], c: null } }, { 10: 'a', 2: 'b', x: 1 }, { ['__proto__']: 1, a: 2 },
    JSON.parse('{"z":{"b":1,"a":2},"__proto__":{"b":1,"a":2},"a":0}'), { t: { toJSON () { return { z: 1, a: 2 }; } } }, { s: Symbol('s'), a: 1 },
    { é: 1, e: 2, E: 3, 'a b': 4, '': 5 }, Object.assign(Object.create(null), { b: 1, a: 2 }), { n: new Number(5), b: 1, a: 1 },
    { s: new String('ab') }, { i: new Instance(), b: [new Instance()] }, deep, holes, { f () {}, b: 1, a: 1 }, [function g () {}],
    { toJSON: 5, b: 1, a: 2 }, { b: [{ d: 1, c: [{ f: 1, e: 2 }] }], a: { ordered: true } }];
}
function randomValue (random) {
  const leaves = [1, 'x', null, true, undefined, 1.5, -0, NaN, 'é"\\ ', new Date(0), () => 1, Infinity];
  const names = ['b', 'a', '__proto__', '10', '2', 'z y', 'ä', '01', '-1', 'B', 'toJSON'];
  const make = depth => {
    const r = random();
    if (depth > 4 || r < 0.3) return leaves[Math.floor(random() * leaves.length)];
    if (r < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => make(depth + 1));
    const out = random() < 0.1 ? Object.create(null) : {};
    for (let i = Math.floor(random() * 5); i > 0; i--) {
      Object.defineProperty(out, names[Math.floor(random() * names.length)], { value: make(depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return out;
  };
  return make(0);
}
// The completion digest's value (lib/pgstream/typed-checkpoint.js complete: content).
const contentOf = result => ({ identity: 'e'.repeat(64), properties: result.properties, emitted: result.emitted, requested: result.requested,
  rows: result.encodedRows ?? result.rows, frame: { ...result.frame, lastUpdated: 0 } });

// The on arm's component, checking both canonical passes on each cycle result as made.
function checkingCanonical (seen) {
  return options => {
    const component = evaluator(options);
    const check = async promise => {
      const result = await promise;
      const value = contentOf(result), text = runtime.replacerCanonical(value);
      assert.equal(runtime.prepassCanonical(value), text, 'the prepass gives the replacer pass\'s text for a cycle result');
      // The result's own moments force the fallback; its JSON round trip is plain
      // data with the result's key order, so this takes the sorting walk.
      const plain = JSON.parse(JSON.stringify(value));
      assert.equal(runtime.prepassCanonical(plain), text, 'the sorting walk gives the replacer pass\'s text for the plain copy of a cycle result');
      seen.cycles += 1;
      return result;
    };
    return { ...component, evaluate: args => check(component.evaluate(args)), evaluateTime: args => check(component.evaluateTime(args)), close: () => component.close() };
  };
}

describe('INC-E2 evaluator hotspots, each with the result as before', function () {
  this.timeout(600000);
  let previous;
  beforeEach(() => { previous = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(() => scope.setTenancyMode(previous));

  describe('dataloader mergeProcessSort', function () {
    it('keeps the quadratic loop\'s records in its order, over repeated, numeric, missing and null ids', function () {
      const random = seeded(11);
      const ids = ['a', 'b', 'c', 'd', 'e', '1', 1, 2, null, undefined];
      const record = (k, stringOnly) => {
        const id = stringOnly ? ids[Math.floor(random() * 6)] : ids[Math.floor(random() * ids.length)];
        const out = { k, mills: Math.floor(random() * 4) };
        if (id !== undefined || random() < 0.5) out._id = id;
        if (random() < 0.2) { delete out.mills; out.created_at = new Date(Math.floor(random() * 4)).toISOString(); }
        return out;
      };
      let fast = 0, errors = 0;
      for (let i = 0; i < 4000; i++) {
        const stringOnly = i % 2 === 0;
        let k = 0;
        const old = Array.from({ length: Math.floor(random() * 12) }, () => (stringOnly || random() > 0.05 ? record(k++, stringOnly) : null));
        const fresh = Array.from({ length: Math.floor(random() * 5) }, () => record(k++, stringOnly));
        const age = random() < 0.2 ? 2 : undefined;
        const oldArg = random() < 0.05 ? undefined : old;
        const a = outcome(() => referenceMergeProcessSort(oldArg && jsonCopy(oldArg), jsonCopy(fresh), age));
        const b = outcome(() => dataloader.mergeProcessSort(oldArg && jsonCopy(oldArg), jsonCopy(fresh), age));
        assert.deepStrictEqual(b, a, 'case ' + i);
        if (a.error) errors += 1;
        if (stringOnly && oldArg) fast += 1;
      }
      assert.ok(fast > 1500 && errors > 0, 'both paths ran, and the loop\'s own failures were reproduced: ' + fast + ' ' + errors);
    });

    it('is linear where every id is a string', function () {
      const old = Array.from({ length: 20000 }, (_, i) => ({ _id: 'o' + i, mills: i }));
      const started = process.hrtime.bigint();
      const merged = dataloader.mergeProcessSort(old, [{ _id: 'o5', mills: 5, k: 'new' }]);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.equal(merged.length, 20000);
      assert.equal(merged[5].k, 'new');
      // The loop compares about 2 x 10^8 pairs here (seconds); the set, 20,000 lookups.
      assert.ok(ms < 1000, 'linear: ' + ms + ' ms');
    });
  });

  describe('NS_EVAL_CANONICAL_PREPASS', function () {
    it('reads its switch strictly at load, off by default', function () {
      assert.equal(runtime.CANONICAL_PREPASS, 'NS_EVAL_CANONICAL_PREPASS');
      const expected = ['1', 'on'].includes(String(process.env.NS_EVAL_CANONICAL_PREPASS || '').trim().toLowerCase());
      assert.equal(runtime.canonical, expected ? runtime.prepassCanonical : runtime.replacerCanonical);
      const { execFileSync } = require('node:child_process');
      const load = value => execFileSync(process.execPath, ['-e', 'const r=require("./lib/server/serve/evaluator-runtime");process.stdout.write(r.canonical===r.prepassCanonical?"prepass":"replacer")'],
        { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, NS_EVAL_CANONICAL_PREPASS: value }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.equal(load(''), 'replacer');
      assert.equal(load('0'), 'replacer');
      assert.equal(load('1'), 'prepass');
      assert.throws(() => load('yes'), /NS_EVAL_CANONICAL_PREPASS is 1 or 0/);
    });

    it('gives the replacer pass\'s text and the recursive definition on edge shapes and seeded random values', function () {
      for (const value of canonicalShapes()) {
        assert.equal(runtime.prepassCanonical(value), runtime.replacerCanonical(value), String(runtime.recursiveCanonical(value)));
      }
      const random = seeded(7);
      for (let i = 0; i < 20000; i++) {
        const value = randomValue(random);
        assert.equal(runtime.prepassCanonical(value), runtime.replacerCanonical(value), 'case ' + i);
        assert.equal(runtime.prepassCanonical(value), runtime.recursiveCanonical(value), 'case ' + i);
      }
    });

    it('fails as the replacer pass does', function () {
      const cyclic = { a: 1 }; cyclic.self = cyclic;
      for (const value of [cyclic, { b: 1n }, [1n]]) {
        assert.deepStrictEqual(outcome(() => runtime.prepassCanonical(value)), outcome(() => runtime.replacerCanonical(value)));
      }
    });

    it('does not change or share what it is given', function () {
      const value = { b: [{ d: 1, c: 2 }], a: Object.freeze({ z: 1, y: 2 }) };
      const before = JSON.stringify(value);
      assert.equal(runtime.prepassCanonical(value), '{"a":{"y":2,"z":1},"b":[{"c":2,"d":1}]}');
      assert.equal(JSON.stringify(value), before);
    });

    // The prepass on every cycle result of the 1,201-minute replay through the
    // resident window stand-in (the on arm keeps the working set and the encoded
    // rows, the off arm rebuilds), window levers on and off. The replay runs the
    // loop plugin set, whose properties hold moments (toJSON), so both passes
    // take the replacer's text here: this checks the fallback on real results;
    // the sorting walk runs on each result's plain JSON copy (see checkingCanonical)
    // and on the edge shapes and random values above.
    const LEVEL = { residentWorkingSet: true, encodeDelta: true };
    for (const [name, levers] of [['window levers on', 'all'], ['window levers off', '0']]) {
      it('gives the replacer pass\'s text on every cycle result of the replay (' + name + ')', async function () {
        clock.install();
        const seen = { cycles: 0 };
        try {
          const cycles = await replay({ minutes: 1200, levers, on: LEVEL, off: { residentWorkingSet: false, encodeDelta: false },
            what: 'the resident window gives the full rebuild\'s cycle result', factory: checkingCanonical(seen) });
          assert.equal(cycles, 1201);
          assert.equal(seen.cycles, 1201);
        } finally { clock.uninstall(); }
      });
    }
  });
});
