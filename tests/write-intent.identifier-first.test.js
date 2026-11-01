'use strict';

// ID-FIRST-MATCH slices 6 and 6a in the rule table (lib/storage/write-intent.js):
// every create path that is new to identifier matching names an identifier-match
// rule, picks by P4 (ID-Q5), and keeps a deleted record deleted when an
// identifier reaches it (ID-Q4).
//
// Written test-first, before slice 6 is built: on slice 3 (c9b74404) the
// "names an identifier rule" tests fail because the rows have no `identifier`
// entry. The property names follow the rows slices 1 to 5 already use
// (`identifier: { also, pick }`, `deleted`); adapt them if slice 6 names its
// entries otherwise. The behaviour itself is pinned by
// tests/websocket.identifier-first.test.js and tests/api.identifier-first.test.js.
//
// Synthetic values only.

const assert = require('node:assert/strict');
const writeIntent = require('../lib/storage/write-intent');

describe('write(intent): slices 6 and 6a, identifier first where it is new (rule table)', function ( ) {
  const rules = writeIntent.COLLECTION_RULES;

  const socketCreates = {
    treatments: '6', devicestatus: '6', profile: '6', entries: '6', food: '6', activity: '6a'
  };
  const v1Creates = { profile: '6', food: '6', activity: '6a' };

  for (const [name, slice] of Object.entries(socketCreates)) {
    // Red on c9b74404: rules[name].socket.create.identifier is undefined.
    it(`slice ${slice}: socket dbAdd of ${name} names an identifier-match rule that picks by P4`, function ( ) {
      const rule = rules[name].socket.create;
      assert(rule.identifier, `socket ${name} create has no identifier rule`);
      // identifierMatch throws on an `also` it does not know.
      writeIntent.identifierMatch({ $eq: 'x' }, rule.identifier.also, { });
      assert.equal(rule.identifier.pick, 'p4');
    });
  }

  for (const name of ['entries', 'food', 'activity']) {
    // Red on c9b74404: socketInsert has no `deleted` entry.
    it(`socket dbAdd of ${name}: an identifier that reaches a deleted record leaves it deleted`, function ( ) {
      const rule = rules[name].socket.create;
      assert.equal(rule.deleted, 'stays-deleted');
    });
  }

  for (const [name, slice] of Object.entries(v1Creates)) {
    // Red on c9b74404: rules[name]['v1/internal'].create.identifier is undefined.
    it(`slice ${slice}: v1 / in-process create of ${name} names an identifier-match rule that picks by P4`, function ( ) {
      const rule = rules[name]['v1/internal'].create;
      assert(rule.identifier, `v1 ${name} create has no identifier rule`);
      assert.equal(rule.identifier.pick, 'p4');
      // Already so on c9b74404 (slice 3); kept in the row with the new key.
      assert.equal(rule.deleted, 'stays-deleted');
    });
  }

  // Guard, green before and after: identifier matching runs only on a valid
  // identifier (slice 2), and a JSON number is never one. AndroidAPS's numeric
  // `pumpId` is not an identifier field and no row reads it.
  it('guard: a number is not an identifier (identifier-format treats it as absent)', function ( ) {
    assert.equal(writeIntent.identifierClass(1234567890), 'not-a-string');
    assert.equal(writeIntent.identifierClass('1234567890'), 'valid');
  });

  it('guard: no rule row names pumpId', function ( ) {
    const seen = [ ];
    (function walk (value, at) {
      if (value === null || value === undefined) return;
      if (typeof value === 'string') { if (/pumpId/.test(value)) seen.push(at); return; }
      if (typeof value === 'function') { if (/pumpId/.test(String(value))) seen.push(at); return; }
      if (typeof value !== 'object') return;
      Object.keys(value).forEach(function (key) { walk(value[key], at + '.' + key); });
    })(rules, 'COLLECTION_RULES');
    assert.deepEqual(seen, [ ]);
  });
});
