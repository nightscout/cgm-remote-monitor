'use strict';

// lib/utils/query-leaves.js replaces the traverse package in lib/server/query.js.
// Its contract, as the query builder relies on it: visit every own enumerable
// string-keyed leaf, give convert(value, path) the key path from the root to
// that leaf, write the result back in place, and leave identity, holes,
// inherited and symbol keys and cycles alone. It has no depth or size bound of
// its own; the operator allowlist limits which shapes reach it.

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const queryLeaves = require('../lib/utils/query-leaves');

function visits (root) {
  const seen = [];
  queryLeaves(root, function (value, path) {
    seen.push([path.join('/'), value]);
    return value;
  });
  return seen;
}

describe('query leaves walker', function () {
  it('gives each leaf its key path through nested $and and $or', function () {
    const root = {$and: [{sgv: {$gte: '70'}}, {$or: [{type: 'sgv'}, {type: {$in: ['mbg', 'cal']}}]}]};
    assert.deepEqual(visits(root), [
      ['$and/0/sgv/$gte', '70'],
      ['$and/1/$or/0/type', 'sgv'],
      ['$and/1/$or/1/type/$in/0', 'mbg'],
      ['$and/1/$or/1/type/$in/1', 'cal']
    ]);
  });

  it('names array members by index and keeps a dotted key as one path step', function () {
    const root = {'boluscalc.bg': {$in: ['100', '120']}, 'a.b.c': '1'};
    assert.deepEqual(visits(root), [
      ['boluscalc.bg/$in/0', '100'],
      ['boluscalc.bg/$in/1', '120'],
      ['a.b.c', '1']
    ]);
  });

  it('separates $in and $nin members from operands such as $exists and $regex', function () {
    const paths = visits({$in: ['1', '2'], $nin: ['3'], $exists: 'false', $regex: '^a', $options: 'i'})
      .map(function (entry) { return entry[0]; });
    assert.deepEqual(paths, ['$in/0', '$in/1', '$nin/0', '$exists', '$regex', '$options']);
  });

  it('writes converted values back in place and keeps object identity', function () {
    const list = ['90', '120'];
    const root = {sgv: {$in: list, $gte: '70'}};
    const operand = root.sgv;
    const result = queryLeaves(root, function (value) { return Number(value); });
    assert.equal(result, root);
    assert.equal(root.sgv, operand);
    assert.equal(root.sgv.$in, list);
    assert.deepEqual(root, {sgv: {$in: [90, 120], $gte: 70}});
  });

  it('hands a fresh path to every call', function () {
    const kept = [];
    queryLeaves({a: {b: '1'}, c: '2'}, function (value, path) { kept.push(path); return value; });
    assert.deepEqual(kept, [['a', 'b'], ['c']]);
    kept[0].push('mutated');
    assert.notEqual(kept[0], kept[1]);
  });

  it('treats the root, empty containers and BSON values as leaves', function () {
    const id = new ObjectId();
    const date = new Date(0);
    assert.deepEqual(visits('5'), [['', '5']]);
    assert.deepEqual(queryLeaves('5', function (value) { return Number(value); }), 5);
    const seen = visits({o: {}, a: [], id: id, d: date});
    assert.deepEqual(seen.map(function (entry) { return entry[0]; }), ['o', 'a', 'id', 'd']);
    assert.equal(seen[2][1], id);
    assert.equal(seen[3][1], date);
  });

  it('skips holes, inherited keys and symbol keys', function () {
    const sparse = [];
    sparse[2] = '7';
    const value = Object.create({hidden: '1'});
    value.own = '2';
    value[Symbol('s')] = '3';
    assert.deepEqual(visits({sparse: sparse, value: value}), [['sparse/2', '7'], ['value/own', '2']]);
    assert.equal(0 in sparse, false);
  });

  it('stops at a cycle instead of recursing without end', function () {
    const root = {v: '12'};
    root.self = root;
    assert.deepEqual(visits(root), [['v', '12']]);
  });

  it('visits a value shared by two branches once per branch', function () {
    const shared = {v: '1'};
    assert.deepEqual(visits({a: shared, b: shared}).map(function (entry) { return entry[0]; }), ['a/v', 'b/v']);
  });
});
