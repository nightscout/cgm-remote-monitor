'use strict';

// lib/server/merge-patch: JSON Merge Patch (RFC 7386), the rule every merge
// path uses for a null (write-contract Q1b, decided 2026-10-26). The paths
// themselves are tested in tests/api.null-removes.test.js.

var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var mergePatch = require('../lib/server/merge-patch');

describe('merge-patch (RFC 7386)', function () {

  describe('apply', function () {

    // RFC 7386 Appendix A, every example.
    [
      [{ a: 'b' }, { a: 'c' }, { a: 'c' }]
      , [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }]
      , [{ a: 'b' }, { a: null }, {}]
      , [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }]
      , [{ a: ['b'] }, { a: 'c' }, { a: 'c' }]
      , [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }]
      , [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }]
      , [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }]
      , [['a', 'b'], ['c', 'd'], ['c', 'd']]
      , [{ a: 'b' }, ['c'], ['c']]
      , [{ a: 'foo' }, null, null]
      , [{ a: 'foo' }, 'bar', 'bar']
      , [{ e: null }, { a: 1 }, { e: null, a: 1 }]
      , [[1, 2], { a: 'b', c: null }, { a: 'b' }]
      , [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }]
    ].forEach(function (example, index) {
      it('Appendix A example ' + (index + 1) + ': ' + JSON.stringify(example[1]), function () {
        should.deepEqual(mergePatch.apply(example[0], example[1]), example[2]);
      });
    });

    it('removes a nested member sent as null and keeps its siblings', function () {
      var stored = { store: { Default: { dia: 5 }, Alt: { dia: 4 } } };
      mergePatch.apply(stored, { store: { Alt: null } }).should.eql({ store: { Default: { dia: 5 } } });
    });

    it('replaces an array whole, keeping a null inside it', function () {
      mergePatch.apply({ a: [1, 2, 3] }, { a: [null, 4] }).should.eql({ a: [null, 4] });
    });

    it('a patch that is not an object replaces the target', function () {
      mergePatch.apply({ a: 1 }, 5).should.equal(5);
      mergePatch.apply({ a: 1 }, 'x').should.equal('x');
      var when = new Date(0);
      mergePatch.apply({ a: 1 }, when).should.equal(when);
    });

    it('a Date or an ObjectId is a value, not an object to merge into', function () {
      var id = new ObjectID();
      var out = mergePatch.apply({ at: new Date(0), id: new ObjectID() }, { at: new Date(1), id: id });
      out.at.getTime().should.equal(1);
      out.id.should.equal(id);
    });

    it('changes neither the target nor the patch', function () {
      var target = { a: { b: 1, c: 2 } };
      var patch = { a: { b: null, d: 3 } };
      mergePatch.apply(target, patch);
      target.should.eql({ a: { b: 1, c: 2 } });
      patch.should.eql({ a: { b: null, d: 3 } });
    });
  });

  describe('update', function () {

    it('sets each member to its merged value and unsets each null member', function () {
      var parts = mergePatch.update({ a: 1, n: { x: 1, y: 2 }, gone: 'v' }, { a: 2, n: { x: null }, gone: null });
      parts.set.should.eql({ a: 2, n: { y: 2 } });
      parts.unset.should.eql({ gone: '' });
      parts.changed.should.equal(true);
    });

    it('is unchanged when the merge leaves the stored document as it is', function () {
      mergePatch.update({ a: 1, n: { x: 1 } }, { a: 1, n: { x: 1 }, absent: null }).changed.should.equal(false);
      mergePatch.update({ a: 1, n: { x: 1, y: 2 } }, { n: { y: 2 } }).changed.should.equal(false);
    });

    it('is changed when a null names a stored member, even one stored as null', function () {
      mergePatch.update({ a: null }, { a: null }).changed.should.equal(true);
    });

    it('treats a key with a dot as a key, not a path', function () {
      var parts = mergePatch.update({ store: { 'Profile 1.5': { dia: 3 }, Other: { dia: 4 } } }, { store: { 'Profile 1.5': null } });
      parts.set.should.eql({ store: { Other: { dia: 4 } } });
    });

    it('leaves out the members it is told to skip', function () {
      var parts = mergePatch.update({ a: 1 }, { _id: 'x', srvModified: 2, a: null }, { skip: ['_id', 'srvModified'] });
      parts.set.should.eql({});
      parts.unset.should.eql({ a: '' });
    });

    it('toMongo leaves out an empty operator', function () {
      mergePatch.toMongo({ set: { a: 1 }, unset: {} }).should.eql({ $set: { a: 1 } });
      mergePatch.toMongo({ set: {}, unset: { a: '' } }).should.eql({ $unset: { a: '' } });
    });

    it('assignInto writes the update onto a stored copy', function () {
      var stored = { a: 1, b: 2 };
      mergePatch.assignInto(stored, mergePatch.update(stored, { a: 3, b: null }));
      stored.should.eql({ a: 3 });
    });
  });

  describe('differsFromSet', function () {

    it('is true only for a body with a null or an object member', function () {
      mergePatch.differsFromSet({ a: 1, b: 'x', c: [1, null], d: new Date(0), e: new ObjectID() }).should.equal(false);
      mergePatch.differsFromSet({ a: null }).should.equal(true);
      mergePatch.differsFromSet({ a: { b: 1 } }).should.equal(true);
    });
  });
});
