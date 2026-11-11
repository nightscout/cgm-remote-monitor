'use strict';

// lib/data/json-copy.js must give exactly JSON.parse(JSON.stringify(value)),
// and a copy that shares nothing with its source (evaluator cost lane, C).
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const { jsonCopy, roundTrip, deepFreeze } = require('../lib/data/json-copy');

// Compare as JSON.parse would leave them: same text, same own keys in the same
// order (deepStrictEqual alone does not check key order), same prototypes.
function same (actual, expected, where = '$') {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), where + ' text');
  assert.deepStrictEqual(actual, expected, where);
  if (actual && typeof actual === 'object') {
    assert.deepEqual(Object.keys(actual), Object.keys(expected), where + ' key order');
    assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected), where + ' prototype');
    for (const key of Object.keys(actual)) same(actual[key], expected[key], where + '.' + key);
  }
}

function sharesNothing (copy, source, where = '$', seen = new Set()) {
  if (!copy || typeof copy !== 'object') return;
  assert.notEqual(copy, source, where + ' is shared with the source');
  if (seen.has(copy)) return;
  seen.add(copy);
  for (const key of Object.keys(copy)) {
    if (source && typeof source === 'object') sharesNothing(copy[key], source[key], where + '.' + key, seen);
  }
}

function random (seed, plain = false) {
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const leaves = [() => null, () => true, () => false, () => 0, () => -0, () => NaN, () => Infinity, () => -Infinity,
    () => undefined, () => function fn () {}, () => Symbol('s'), () => Math.round(next() * 1e6) / 1e3, () => 1e21, () => 5e-324, () => 'text',
    () => '\ud800 lone', () => 'quote " and \\ and \n', () => new Date(1700000000000 + Math.round(next() * 1e9)),
    () => new ObjectId('0123456789abcdef01234567'),
    () => ({ toJSON () { return { converted: true }; } })].slice(0, plain ? -3 : undefined);
  const keys = ['_id', 'a', 'b', '10', '2', 'created_at', '__proto__', 'mills', 'nested', ''];
  function value (depth) {
    const r = next();
    if (depth > 4 || r < 0.45) return leaves[Math.floor(next() * leaves.length)]();
    if (r < 0.7) {
      const n = Math.floor(next() * 5);
      const out = new Array(n);
      for (let i = 0; i < n; i++) if (next() > 0.15) out[i] = value(depth + 1); // holes
      return out;
    }
    const out = next() < 0.1 ? Object.create(null) : {};
    const n = Math.floor(next() * 6);
    for (let i = 0; i < n; i++) {
      const key = keys[Math.floor(next() * keys.length)];
      Object.defineProperty(out, key, { value: value(depth + 1), enumerable: next() > 0.1, writable: true, configurable: true });
    }
    return out;
  }
  return value(0);
}

describe('json-copy: the JSON round trip without the text', function () {
  it('equals JSON.parse(JSON.stringify()) on the special cases', function () {
    const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}');
    const cases = [
      null, true, 0, -0, NaN, 'x', [], {}, [undefined, () => 1, Symbol('s'), -0, NaN, Infinity],
      { a: undefined, b: () => 1, c: Symbol('s'), d: -0, e: NaN, f: null },
      { 10: 'ten', b: 'b', 2: 'two', a: 'a' }, // integer-like keys first, as JSON.parse orders them
      withProto,
      Object.assign(Object.create(null), { a: 1 }),
      [1, , 3], // eslint-disable-line no-sparse-arrays
      { when: new Date(0), id: new ObjectId('0123456789abcdef01234567') },
      { custom: { toJSON (key) { return 'key:' + key; } } },
      { boxed: [Object('s'), Object(1), Object(true)] },
      { map: new Map([[1, 2]]), set: new Set([1]), typed: new Uint8Array([1, 2]) },
      Object.defineProperty({ visible: 1 }, 'hidden', { value: 2, enumerable: false }),
      { get computed () { return 'got'; } },
      { ok: [{ deep: [{ deeper: [1, { deepest: 'x' }] }] }] }
    ];
    for (const value of cases) same(jsonCopy(value), roundTrip(value), JSON.stringify(value));
    assert.equal(jsonCopy(undefined), undefined);
    assert.equal(Object.getPrototypeOf(jsonCopy(withProto)), Object.prototype, '__proto__ stays a member, not the prototype');
  });

  it('throws as JSON does on a cycle and on a bigint', function () {
    const cycle = { a: {} }; cycle.a.b = cycle;
    assert.throws(() => jsonCopy(cycle), TypeError);
    assert.throws(() => jsonCopy({ n: 10n }), TypeError);
  });

  it('equals the round trip on 2,000 random structures and shares nothing with them', function () {
    // Half without Date/ObjectId/toJSON leaves, so the direct path is taken.
    for (let seed = 1; seed <= 2000; seed++) {
      const value = random(seed, seed % 2 === 0);
      const copy = jsonCopy(value);
      same(copy, roundTrip(value), 'seed ' + seed);
      sharesNothing(copy, value, 'seed ' + seed);
    }
  });

  it('gives copies independent of their source and of each other (mutation)', function () {
    const source = { _id: 'a', loop: { timestamp: '2026-11-10T00:00:00Z', predicted: { values: [1, 2, 3] } }, list: [{ v: 1 }] };
    const first = jsonCopy(source), second = jsonCopy(source);
    first.loop.timestamp = 'changed'; first.loop.predicted.values.push(4); first.list[0].v = 99; first.added = true;
    assert.deepEqual(source, { _id: 'a', loop: { timestamp: '2026-11-10T00:00:00Z', predicted: { values: [1, 2, 3] } }, list: [{ v: 1 }] });
    assert.deepEqual(second, source);
    source.loop.predicted.values[0] = -1;
    assert.equal(second.loop.predicted.values[0], 1);
  });

  it('deepFreeze freezes every level', function () {
    const value = deepFreeze({ a: { b: [{ c: 1 }] } });
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.a) && Object.isFrozen(value.a.b) && Object.isFrozen(value.a.b[0]));
    assert.throws(() => { 'use strict'; value.a.b[0].c = 2; }, TypeError);
  });
});
