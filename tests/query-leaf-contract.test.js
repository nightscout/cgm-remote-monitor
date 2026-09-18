'use strict';
const assert = require('node:assert/strict');
const {ObjectId} = require('mongodb');
const implementations = [['current', require('../lib/server/query')]];
if (process.env.NIGHTSCOUT_QUERY_ORACLE) implementations.unshift(['legacy', require(process.env.NIGHTSCOUT_QUERY_ORACLE)]);
for (const [name, query] of implementations) {
  describe(name + ' query leaf contracts', function () {
    it('mutates nested operators and arrays in place without touching other fields', function () {
      const values = ['90', '120'];
      const params = {find: {sgv: {$not: {$in: values}, $gte: '70'}, note: '123'}};
      const result = query(params, {noDateFilter: true});
      assert.equal(result, params.find);
      assert.equal(result.sgv.$not.$in, values);
      assert.deepEqual(result, {sgv: {$not: {$in: [90, 120]}, $gte: 70}, note: '123'});
    });
    it('preserves the scalar truthiness and root replacement contracts', function () {
      for (const value of [0, false, null, undefined, '', 42]) {
        const params = {find: {sgv: value}};
        query(params, {noDateFilter: true});
        assert.equal(params.find.sgv, value);
      }
      assert.equal(query({find: {sgv: '42'}}, {noDateFilter: true}).sgv, 42);
      const root = {};
      const params = {find: {sgv: root}};
      query(params, {noDateFilter: true});
      assert.equal(params.find.sgv, root);
    });
    it('converts nested empty containers and null leaves using the configured typer', function () {
      const params = {find: {sgv: {$in: [null, {}, [], 'bad', '0']}}};
      query(params, {noDateFilter: true});
      assert.ok(params.find.sgv.$in.slice(0, 4).every(Number.isNaN));
      assert.equal(params.find.sgv.$in[4], 0);
    });
    it('retains sparse arrays, aliases and cycles without cloning', function () {
      const shared = {value: '12'};
      const sparse = [];
      sparse[3] = shared;
      const tree = {sparse, shared};
      tree.self = tree;
      query({find: {sgv: tree}}, {noDateFilter: true});
      assert.equal(tree.self, tree);
      assert.equal(sparse[3], shared);
      assert.equal(shared.value, 12);
      assert.equal(sparse.length, 4);
      assert.equal(0 in sparse, false);
    });
    it('only visits own string keys and leaves inherited and symbol values alone', function () {
      const inherited = {hidden: '7'};
      const value = Object.create(inherited);
      const symbol = Symbol('owned');
      value.own = '8'; value[symbol] = '9';
      query({find: {sgv: value}}, {noDateFilter: true});
      assert.equal(value.own, 8);
      assert.equal(value.hidden, '7');
      assert.equal(inherited.hidden, '7');
      assert.equal(value[symbol], '9');
    });
    it('preserves null prototypes and own prototype-like data keys', function () {
      const value = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"ownedQueryLeaf":"9"},"constructor":{"prototype":{"ownedQueryLeaf":"8"}}}'));
      query({find: {sgv: value}}, {noDateFilter: true});
      assert.equal(Object.getPrototypeOf(value), null);
      assert.equal(value.__proto__.ownedQueryLeaf, 9);
      assert.equal(value.constructor.prototype.ownedQueryLeaf, 8);
      assert.equal(Object.prototype.ownedQueryLeaf, undefined);
    });
    it('normalizes nested ObjectId strings without corrupting existing BSON, dates or regex values', function () {
      const hex = '55cbd4e47e726599048a3f91';
      const id = new ObjectId(hex), date = new Date(0), regex = /owned/i;
      const result = query({find: {_id: {$in: [hex, id, date, regex, null, 'not an id']}}}, {noDateFilter: true});
      assert.equal(result._id.$in[0]._bsontype, 'ObjectId');
      assert.equal(result._id.$in[0].toHexString(), hex);
      assert.equal(result._id.$in[1], id);
      assert.equal(id.toHexString(), hex);
      assert.equal(result._id.$in[2], date);
      assert.equal(result._id.$in[3], regex);
      assert.deepEqual(result._id.$in.slice(4), [null, 'not an id']);
    });
    it('retains UUID equality rewriting while leaving complex UUID operators unchanged', function () {
      const uuid = '69F15FD2-8075-4DEB-AEA3-4352F455840D';
      assert.deepEqual(query({find: {_id: uuid}}, {uuidHandling: true}), {$or: [{identifier: uuid}, {_id: uuid}]});
      assert.deepEqual(query({find: {_id: {$in: [uuid]}}}, {uuidHandling: true}), {_id: {$in: [uuid]}});
    });
    it('propagates conversion and non-writable property errors', function () {
      const error = new Error('owned conversion error');
      assert.throws(() => query({find: {sgv: {$gt: '2'}}}, {walker: {sgv: () => {throw error;}}}), e => e === error);
      const value = Object.freeze({$gt: '2'});
      assert.throws(() => query({find: {sgv: value}}, {noDateFilter: true}), TypeError);
    });
  });
}
