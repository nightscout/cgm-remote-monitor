'use strict';

// identifier-held (ID-RULE1-EDIT, decided by the maintainer 2026-10-30) at the
// write step: which rules name it, when its one read runs, and that a held
// identifier stops the write before any storage write. End to end against
// MongoDB: tests/api.identifier-held.test.js (API v1, in-process, socket) and
// tests/api3.identifier-held.test.js (API v3 PATCH). Synthetic values only.

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const idForms = require('../lib/server/object-id-forms');

const X_ID = new ObjectId('5f00000000000000000000e1');
const Y_ID = new ObjectId('5f00000000000000000000e2');
const ID_X = 'f1d2c3b4-0000-4000-8000-00000000e001';
const ID_Y = 'f1d2c3b4-0000-4000-8000-00000000e002';
const WRITES = ['replaceFiltered', 'bulkUpsert', 'updateMany', 'deleteMany', 'insertOne', 'updateOne', 'replaceOne'];

// Storage that answers the identifier-held read (a filter on `identifier`)
// with the holders that read does not exclude, and every other read (the
// server-date read by _id) with X; it records every call.
function storage (x, holders) {
  const calls = [ ];
  const s = {
    calls,
    findFiltered: async function (ast, opts) {
      const text = JSON.stringify(ast);
      if (text.indexOf('"field":"identifier"') === -1) { calls.push(['read-x']); return x ? [Object.assign({ }, x)] : [ ]; }
      calls.push(['read-held', ast]);
      const nin = text.indexOf('"op":"nin"') !== -1 ? idForms.idForms(X_ID).map(String) : [ ];
      return holders.filter(function (h) { return nin.indexOf(String(h._id)) === -1; });
    }
  };
  WRITES.forEach(function (name) {
    s[name] = async function ( ) { calls.push([name]); return { matchedCount: 1, upsertedCount: 0, upsertedIds: { }, deletedCount: 0 }; };
  });
  return s;
}

const names = function (st) { return st.calls.map(function (c) { return c[0]; }); };
const wrote = function (st) { return st.calls.some(function (c) { return WRITES.indexOf(c[0]) !== -1; }); };

const X = { _id: X_ID, identifier: ID_X, name: 'x' };
const Y = { _id: Y_ID, identifier: ID_Y, name: 'y' };

async function v1Update (name, x, holders, doc) {
  const st = storage(x, holders);
  let error = null;
  try {
    await writeIntent.forCollection(st, name, 'v1/internal', { env: { } }).write({ op: 'update', docs: [doc] });
  } catch (err) {
    error = err;
  }
  return { st, error };
}

async function socketUpdate (x, holders, fields) {
  const st = storage(x, holders);
  const step = writeIntent.forCollection(st, 'treatments', 'socket', { env: { } });
  let error = null;
  try {
    await step.write(step.plan({ op: 'update', form: 'merge', target: { _id: String(X_ID) }, fields: fields }));
  } catch (err) {
    error = err;
  }
  return { st, error };
}

describe('write(intent): identifier-held, an edit by _id carrying another record\'s identifier (ID-RULE1-EDIT)', function ( ) {

  it('the rules: v1 / in-process update of food, activity and profile, every socket dbUpdate, API v3 PATCH', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    for (const name of ['food', 'activity', 'profile']) {
      assert.equal(rules[name]['v1/internal'].update.identifierHeld, 'refuse', name);
      assert.equal(rules[name]['v1/internal'].create.identifierHeld, undefined, name + ' create (slices 6/6a)');
    }
    assert.equal(rules.treatments['v1/internal'].update.identifierHeld, undefined, 'treatments PUT: identifier routing (ID-Q10)');
    for (const name of ['treatments', 'devicestatus', 'profile', 'entries', 'food', 'activity']) {
      assert.equal(rules[name].socket.update.forms.merge.identifierHeld, 'refuse', name);
      assert.equal(rules[name].socket.update.forms.unset.identifierHeld, undefined, name + ': an unset sets no identifier');
    }
    for (const name of ['treatments', 'devicestatus', 'profile', 'entries', 'food', 'settings']) {
      assert.equal(rules[name].v3.patch.identifierHeld, 'refuse', name);
      assert.equal(rules[name].v3.update.identifierHeld, undefined, name + ': a PUT stores the route\'s identifier');
    }
    assert.deepStrictEqual(writeIntent.IDENTIFIER_HELD, ['ignore', 'refuse']);
  });

  it('the error: IdentifierConflictError, 409, one message that names no value', function ( ) {
    const err = new writeIntent.IdentifierConflictError();
    assert.equal(err.name, 'IdentifierConflictError');
    assert.equal(err.status, 409);
    assert.equal(err.message, 'identifier is held by another record');
    assert.equal(writeIntent.isIdentifierConflict(err), true);
    assert.equal(writeIntent.isIdentifierConflict(new Error('x')), false);
  });

  describe('food (server-date read first): the held read only when the identifier is not X\'s own', function ( ) {
    it('Y\'s identifier: one read more, then IdentifierConflictError; nothing written', async function ( ) {
      const { st, error } = await v1Update('food', X, [Y], { _id: String(X_ID), identifier: ID_Y, name: 'x2' });
      assert.ok(writeIntent.isIdentifierConflict(error), String(error));
      assert.deepStrictEqual(names(st), ['read-x', 'read-held']);
      assert.equal(wrote(st), false);
    });
    it('X\'s own identifier: no held read, written', async function ( ) {
      const { st, error } = await v1Update('food', X, [X], { _id: String(X_ID), identifier: ID_X, name: 'x2' });
      assert.equal(error, null);
      assert.deepStrictEqual(names(st), ['read-x', 'bulkUpsert']);
    });
    it('no identifier: no held read, written', async function ( ) {
      const { st, error } = await v1Update('food', X, [Y], { _id: String(X_ID), name: 'x2' });
      assert.equal(error, null);
      assert.deepStrictEqual(names(st), ['read-x', 'bulkUpsert']);
    });
    it('a new identifier nobody holds: one read more, written', async function ( ) {
      const { st, error } = await v1Update('food', X, [ ], { _id: String(X_ID), identifier: 'nobody-holds-it', name: 'x2' });
      assert.equal(error, null);
      assert.deepStrictEqual(names(st), ['read-x', 'read-held', 'bulkUpsert']);
    });
    it('no _id (a create through save): not checked', async function ( ) {
      const { st, error } = await v1Update('food', null, [Y], { identifier: ID_Y, name: 'new' });
      assert.equal(error, null);
      assert.equal(names(st).indexOf('read-held'), -1);
    });
  });

  describe('activity and the socket (no record read before the write): the held read leaves X out', function ( ) {
    it('activity with Y\'s identifier: refused, nothing written', async function ( ) {
      const { st, error } = await v1Update('activity', X, [Y], { _id: String(X_ID), identifier: ID_Y });
      assert.ok(writeIntent.isIdentifierConflict(error), String(error));
      assert.deepStrictEqual(names(st), ['read-held']);
    });
    it('activity with X\'s own identifier: the read excludes X\'s forms, written', async function ( ) {
      const { st, error } = await v1Update('activity', X, [X], { _id: String(X_ID), identifier: ID_X });
      assert.equal(error, null);
      assert.deepStrictEqual(names(st), ['read-held', 'replaceFiltered', 'deleteMany']);
    });
    it('activity with no identifier: no read', async function ( ) {
      const { st, error } = await v1Update('activity', X, [Y], { _id: String(X_ID), steps: 1 });
      assert.equal(error, null);
      assert.equal(names(st).indexOf('read-held'), -1);
    });
    it('socket dbUpdate with Y\'s identifier: refused before the update', async function ( ) {
      const { st, error } = await socketUpdate(X, [Y], { identifier: ID_Y, notes: 'n' });
      assert.ok(writeIntent.isIdentifierConflict(error), String(error));
      assert.deepStrictEqual(names(st), ['read-held']);
    });
    it('socket dbUpdate with X\'s own identifier, or none: written', async function ( ) {
      const own = await socketUpdate(X, [X], { identifier: ID_X, notes: 'n' });
      assert.equal(own.error, null);
      assert.deepStrictEqual(names(own.st), ['read-held', 'updateMany']);
      const none = await socketUpdate(X, [Y], { notes: 'n' });
      assert.equal(none.error, null);
      assert.deepStrictEqual(names(none.st), ['updateMany']);
    });
    it('a placeholder identifier is not checked (identifier-format treats it as absent)', async function ( ) {
      const { st, error } = await socketUpdate(X, [Y], { identifier: 'undefined', notes: 'n' });
      assert.equal(error, null);
      assert.equal(names(st).indexOf('read-held'), -1);
    });
  });

  describe('API v3 PATCH (identifierHeld): the read only when the body\'s identifier is not the record\'s', function ( ) {
    const shown = { identifier: ID_X, notes: 'x' };
    async function held (holders, doc) {
      const st = storage(null, holders);
      const answer = await writeIntent.forCollection(st, 'treatments', 'v3', { env: { } })
        .identifierHeld({ op: 'patch', docs: [doc], target: { identifier: ID_X, stored: shown } });
      return { st, answer };
    }
    it('Y\'s identifier: true, after one read', async function ( ) {
      const { st, answer } = await held([Y], { identifier: ID_Y });
      assert.equal(answer, true);
      assert.deepStrictEqual(names(st), ['read-held']);
    });
    it('an identifier nobody holds: false, after one read (the route keeps its 400)', async function ( ) {
      const { answer } = await held([ ], { identifier: 'nobody-holds-it' });
      assert.equal(answer, false);
    });
    it('its own identifier, none, or a placeholder: false, no read', async function ( ) {
      for (const doc of [{ identifier: ID_X }, { notes: 'n' }, { identifier: 'null' }]) {
        const { st, answer } = await held([Y], doc);
        assert.equal(answer, false, JSON.stringify(doc));
        assert.deepStrictEqual(names(st), [ ]);
      }
    });
  });
});
