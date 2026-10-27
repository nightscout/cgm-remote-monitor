'use strict';

const assert = require('node:assert/strict');
const create = require('../lib/server/query');
const { fromMongo } = require('../lib/storage/filter');

// The entries walker, verbatim from lib/server/entries.js query_for.
const ENTRIES = {
  walker: { date: parseInt, sgv: parseInt, filtered: parseInt, unfiltered: parseInt
    , rssi: parseInt, noise: parseInt, mbg: parseInt }
  , useEpoch: true
};

function find (predicate) {
  return create({ find: predicate }, ENTRIES);
}

describe('$exists takes a boolean, not a value of the field type', function () {

  // The defect this covers had two independent halves, and both had to be fixed
  // for either to be right.
  //
  // Half one: the field-type walker ran over the operator's argument, so
  // ?find[mbg][$exists]=true became {$exists: parseInt('true')} = {$exists: NaN}.
  // Measured against a live mongod, {$exists: NaN} matches documents that HAVE
  // the field -- so the answer was accidentally right, for a reason that did not
  // survive the seam's first fromMongo, where !!NaN is false and the query
  // INVERTED. (lib/storage/filter.js now reads the operand as mongod does.)
  //
  // Half two: over HTTP the argument is a string, and 'false' is truthy.
  // Measured against the same mongod, {$exists: 'false'} also matches documents
  // that HAVE the field. So ?find[mbg][$exists]=false asked for documents
  // LACKING mbg and returned documents having it, before the seam and after.
  //
  // Both halves are why this coerces rather than passing the value through: the
  // driver's own reading of a raw string disagrees with what the caller asked.

  it('does not let a field-type walker touch the argument', function () {
    // parseInt('true') is NaN. If the walker reaches this, the value is not a
    // boolean and the assertion below fails whichever way it lands.
    assert.equal(find({ mbg: { $exists: 'true' } }).mbg.$exists, true);
  });

  // The seam's own "false"/"anything else" reader tests were dropped in the
  // replay: dev reads the operand in lib/server/query.js (#8737), leaves
  // unrecognised spellings as sent, and tests/query.operands.test.js pins that.

  it('still coerces the field values beside it', function () {
    // The walker must keep doing its job on everything that IS a field value --
    // the fix is targeted at one operator, not a retreat from coercion.
    const q = find({ sgv: { $gte: '100', $exists: 'true' } });
    assert.equal(q.sgv.$gte, 100);
    assert.equal(q.sgv.$exists, true);
  });

  it('leaves a field with no walker entry alone, as before', function () {
    assert.equal(find({ pump: { $exists: 'true' } }).pump.$exists, true);
    assert.equal(find({ pump: { $exists: 'false' } }).pump.$exists, false);
  });

  it('survives the AST conversion with the caller\'s meaning intact', function () {
    // The end of the path that actually broke: the seam's first fromMongo did
    // !!value, so a non-boolean here was wrong by the time it was a node.
    // `and` because query.js adds its own date bound.
    const present = fromMongo(find({ mbg: { $exists: 'true' } }));
    const absent = fromMongo(find({ mbg: { $exists: 'false' } }));
    const existsNode = ast => ast.nodes.find(n => n.op === 'exists');
    assert.equal(existsNode(present).value, true);
    assert.equal(existsNode(absent).value, false);
  });
});

describe('$exists coercion over a hostile find', function () {

  // lib/utils/query-leaves.js guards cycles and aliases and
  // tests/query-leaf-contract.test.js asserts it; the $exists passes walk the
  // same object and need the same guard. Without it a cyclic find is a stack
  // overflow -- and the filter comes from the URL, so that is a denial of
  // service rather than a crash in a corner.
  it('terminates on a cycle instead of overflowing the stack', function () {
    // The cycle is built out of ALLOWED structure -- an $and branch pointing
    // back at its own document -- so it reaches the coercion passes instead of
    // being refused by the allowlist for an unrelated reason.
    const cyclic = { a: { $exists: 'false' } };
    cyclic.$and = [ cyclic ];
    const q = create({ find: cyclic }, ENTRIES);
    assert.equal(q.a.$exists, false);
  });

  it('visits a shared subtree once per reference without corrupting it', function () {
    const shared = { $exists: 'true' };
    const q = create({ find: { a: shared, b: shared } }, ENTRIES);
    assert.equal(q.a.$exists, true);
    assert.equal(q.b.$exists, true);
  });
});
