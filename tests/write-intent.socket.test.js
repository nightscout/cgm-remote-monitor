'use strict';

const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const BEFORE = require('./fixtures/write-intent/websocket-795a0751');

// write(intent) for the rest of the socket (WC-STEP-PATCH slice 6): the dbAdd
// of treatments, devicestatus and profile (the _id form, the exact match, the
// +-2 s similar match, the insert, the WRITE_VALIDATION and BF-194 preflight)
// and dbUpdate and dbUpdateUnset of every collection. websocket.js's rules as
// they were at 795a0751 (tests/fixtures/write-intent/websocket-795a0751.js)
// and the step run over the same recording storage interface, answered from
// the same scripted reads: the calls (method, filter, document, options), the
// branch taken, the record answered with, the document as left, and the rule
// an error is reported under must be equal. tests/websocket.dedupe-gate.test.js
// pins the same rules end to end against MongoDB; this file sees what that
// cannot: the exact calls, and storage failing under each rule.
//
// Synthetic values only.

const HEX = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HEX2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const NEW_ID = new ObjectId('5f00000000000000000000b2');
const T = '2019-05-10T07:40:00.000Z';
const T1 = '2019-05-10T07:40:01.000Z';

// Values made comparable: an ObjectId and a string _id stay apart, and the
// server clock (srvModified, a new srvCreated) is a placeholder.
function norm (value, key) {
  if (value instanceof ObjectId) return 'OID(' + value.toHexString() + ')';
  if (value instanceof Date) return 'DATE(' + value.toISOString() + ')';
  if ((key === 'srvModified' || key === 'srvCreated') && typeof value === 'number' && value > 1e12) return 'T';
  if (Array.isArray(value)) return value.map(v => norm(v));
  if (value && typeof value === 'object') {
    const out = { };
    Object.keys(value).forEach(k => { out[k] = norm(value[k], k); });
    return out;
  }
  return value;
}

function copy (value) {
  if (value instanceof ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') {
    const out = { };
    Object.keys(value).forEach(k => { out[k] = copy(value[k]); });
    return out;
  }
  return value;
}

// The storage interface (lib/api3/storage/mongoCollection) as the socket's
// rules use it, recording every call. Each read answers the next of `reads`
// (a fresh copy); `failAt` makes the call with that index throw `failure`.
function recorder (reads, failAt, failure, matchedCount) {
  const calls = [ ];
  const queue = reads.map(copy);
  const step = function (name, args) {
    calls.push(norm([name].concat(args)));
    if (calls.length - 1 === failAt) throw failure;
  };
  const storage = {
    findFiltered: async function (ast, opts) { step('findFiltered', [ast, opts]); return copy(queue.shift() || [ ]); },
    insertOne: async function (doc, opts) {
      step('insertOne', [doc, opts]);
      if (doc._id === undefined || doc._id === null) doc._id = NEW_ID;
      return NEW_ID;
    },
    updateMany: async function (ast, changes, opts) {
      step('updateMany', [ast, changes, opts]);
      return { acknowledged: true, matchedCount: matchedCount === undefined ? 1 : matchedCount };
    },
    replaceFiltered: async function (ast, doc, opts) {
      step('replaceFiltered', [ast, doc, opts]);
      return { acknowledged: true, matchedCount: 1 };
    }
  };
  return { storage, calls };
}

const KIND_OF = { unchanged: 'exact', merged: 'similar', replaced: 'replaced', inserted: 'inserted' };

async function settle (promise) {
  try {
    return { value: await promise };
  } catch (err) {
    return { error: err };
  }
}

// dbAdd of one record, before and after, over the same scripted reads.
async function compareAdd (collection, sent, reads, failAt, failure) {
  const before = recorder(reads, failAt, failure);
  const legacyDoc = copy(sent);
  const legacy = await settle(BEFORE.processSingleDbAdd(before.storage, { collection, data: legacyDoc }, 2000));

  const after = recorder(reads, failAt, failure);
  const doc = copy(sent);
  const step = writeIntent.forCollection(after.storage, collection, 'socket', { env: { } });
  const now = await settle(step.write({ op: 'create', docs: [doc] }));

  assert.deepEqual(after.calls, before.calls, 'the same storage calls');
  assert.deepEqual(norm(doc), norm(legacyDoc), 'the document left as it was');
  if (legacy.error) {
    assert(now.error, 'the step fails where the handler failed');
    if (legacy.error.rule) {
      assert(now.error instanceof writeIntent.WriteRuleError, String(now.error));
      assert.equal(now.error.rule, legacy.error.rule);
      assert.equal(now.error.cause, legacy.error.cause);
    } else {
      assert(!(now.error instanceof writeIntent.WriteRuleError), 'thrown as it was, not under a rule');
      assert.equal(now.error.name, legacy.error.name);
      assert.equal(now.error.message, legacy.error.message);
    }
    return { legacy, now, calls: after.calls };
  }
  assert(!now.error, String(now.error));
  const written = now.value.items[0];
  assert.equal(KIND_OF[written.outcome], legacy.value.kind);
  if (written.outcome === 'inserted') {
    assert.deepEqual(norm(written._id), norm(legacy.value.record._id));
    assert.equal(written.record, undefined);
  } else {
    assert.deepEqual(norm(written.record), norm(legacy.value.record));
  }
  return { legacy, now, calls: after.calls };
}

function treatment (fields) {
  return Object.assign({ eventType: 'Meal Bolus', created_at: T, enteredBy: 'wc-socket' }, fields);
}

const STORED = { _id: new ObjectId(HEX2), eventType: 'Meal Bolus', created_at: T, carbs: 20, srvCreated: 1000, srvModified: 1000 };

describe('write(intent): the socket\'s dbAdd of treatments, devicestatus and profile', function ( ) {
  const ADD = [
    ['treatments', 'an exact match on NSCLIENT_ID', treatment({ NSCLIENT_ID: 'n-1', carbs: 20 }), [[STORED]]],
    ['treatments', 'an exact match on the fallback key with an identity', treatment({ syncIdentifier: 's-1', carbs: 20 }), [[STORED]]],
    ['treatments', 'an exact match on the fallback key without one', treatment({ carbs: 20 }), [[STORED]]],
    ['treatments', 'a similar match', treatment({ created_at: T1, carbs: 20, insulin: 1 }), [[ ], [STORED]]],
    ['treatments', 'a similar match on NSCLIENT_ID', treatment({ created_at: T1, NSCLIENT_ID: 'n-2' }), [[ ], [STORED]]],
    ['treatments', 'zeros (insulin, carbs, percent, absolute, duration)'
      , treatment({ eventType: 'Temp Basal', insulin: 0, carbs: 0, percent: 0, absolute: 0, duration: 0 }), [[ ], [ ]]],
    ['treatments', 'no match: an insert', treatment({ carbs: 5 }), [[ ], [ ]]],
    ['treatments', 'a 24-hex _id stored as a string', treatment({ _id: HEX.toUpperCase() }), [[{ _id: HEX }], [ ], [ ]]],
    ['treatments', 'a new 24-hex _id', treatment({ _id: HEX }), [[ ], [ ], [ ]]],
    ['treatments', 'a custom _id', treatment({ _id: 'custom-id' }), [[ ], [ ]]],
    ['devicestatus', 'an exact match on NSCLIENT_ID', { NSCLIENT_ID: 'd-1', created_at: T }, [[{ _id: 's1', created_at: T1 }]]],
    ['devicestatus', 'an exact match on created_at', { created_at: T, device: 'x' }, [[{ _id: 's1', created_at: T }]]],
    ['devicestatus', 'no match: an insert', { created_at: T, device: 'x' }, [[ ]]],
    ['devicestatus', 'a 24-hex _id', { _id: HEX, created_at: T }, [[ ], [ ]]],
    ['profile', 'a match on NSCLIENT_ID: a replace', { NSCLIENT_ID: 'p-1', startDate: T, defaultProfile: 'A' }
      , [[{ _id: new ObjectId(HEX2), NSCLIENT_ID: 'p-1', srvCreated: 1000, srvModified: 1000, identifier: 'id-p' }]]],
    ['profile', 'a match on startDate: a replace', { startDate: T, defaultProfile: 'A', created_at: T }
      , [[{ _id: 'p-stored', startDate: T }]]],
    ['profile', 'neither NSCLIENT_ID nor startDate: an insert, no read', { defaultProfile: 'A', created_at: T }, [ ]],
    ['profile', 'no match: an insert', { startDate: T, created_at: T }, [[ ]]]
  ];

  for (const [collection, label, sent, reads] of ADD) {
    it(collection + ': ' + label + ' makes the calls dbAdd made and takes the same branch', async function ( ) {
      await compareAdd(collection, sent, reads);
    });
  }

  it('reads the stored records it may answer with through softDeleted.visible, except a profile (Q-R)', async function ( ) {
    const t = await compareAdd('treatments', treatment({ carbs: 20 }), [[ ], [ ]]);
    assert.equal(t.calls.filter(c => c[0] === 'findFiltered').length, 2);
    t.calls.filter(c => c[0] === 'findFiltered')
      .forEach(c => assert(JSON.stringify(c[1]).includes('isValid'), 'treatments: ' + JSON.stringify(c[1])));
    const p = await compareAdd('profile', { NSCLIENT_ID: 'p-1' }, [[ ]]);
    assert(!JSON.stringify(p.calls[0][1]).includes('isValid'), 'profile matches a soft-deleted profile, as today');
  });

  const FAIL = [
    ['treatments', 'the _id-form read', treatment({ _id: HEX }), [[ ]], 0, 'id-form'],
    ['treatments', 'the exact match', treatment({ carbs: 20 }), [ ], 0, 'exact-match'],
    ['treatments', 'the similar read', treatment({ carbs: 20 }), [[ ]], 1, 'similar-match'],
    ['treatments', 'the similar update', treatment({ created_at: T1, carbs: 20 }), [[ ], [STORED]], 2, 'similar-match'],
    ['treatments', 'the insert', treatment({ carbs: 20 }), [[ ], [ ]], 2, 'insert'],
    ['devicestatus', 'the exact match', { created_at: T }, [ ], 0, 'exact-match'],
    ['devicestatus', 'the insert', { created_at: T }, [[ ]], 1, 'insert'],
    ['profile', 'the match', { startDate: T }, [ ], 0, 'exact-match'],
    ['profile', 'the replace', { startDate: T }, [[{ _id: 'p-stored', startDate: T }]], 1, 'exact-match'],
    ['profile', 'the insert', { created_at: T }, [ ], 0, 'insert']
  ];

  for (const [collection, label, sent, reads, failAt, rule] of FAIL) {
    it(collection + ': a storage error in ' + label + ' is reported under ' + rule + ', with the error as cause', async function ( ) {
      const failure = Object.assign(new Error('storage failed: ' + label), { code: 1 });
      const { legacy, now } = await compareAdd(collection, sent, reads, failAt, failure);
      assert.equal(legacy.error.rule, rule);
      assert.equal(now.error.cause, failure);
    });
  }

  it('throws an error in building the similar query as it is, under no rule', async function ( ) {
    const { now } = await compareAdd('treatments', treatment({ created_at: 'not a date' }), [[ ]]);
    assert.equal(now.error.name, 'RangeError');
  });

  it('writes one document per create: a batch is refused before any write', async function ( ) {
    for (const collection of ['treatments', 'devicestatus', 'profile']) {
      const after = recorder([ ]);
      await assert.rejects(writeIntent.forCollection(after.storage, collection, 'socket').write({ op: 'create', docs: [{ }, { }] })
        , /writes one document, not 2/);
      assert.deepEqual(after.calls, [ ]);
    }
  });
});

describe('write(intent): the socket\'s dbAdd preflight of treatments (WRITE_VALIDATION, then BF-194)', function ( ) {
  const DOCS = [
    ['a plain bolus', { eventType: 'Meal Bolus', created_at: T, insulin: 1 }],
    ['a Temporary Target in mmol/L', { eventType: 'Temporary Target', created_at: T, duration: 30, targetTop: 6, targetBottom: 5, units: 'mmol' }],
    ['a Temporary Target with no units', { eventType: 'Temporary Target', created_at: T, duration: 30, targetTop: 6, targetBottom: 5 }],
    ['a Temporary Target below the floor', { eventType: 'Temporary Target', created_at: T, duration: 30, targetTop: 20, targetBottom: 10, units: 'mg/dl' }]
  ];
  for (const mode of ['off', 'log', 'reject']) {
    for (const [label, sent] of DOCS) {
      it(mode + ': ' + label + ' is refused, or converted, as dbAdd did', function ( ) {
        const env = { writeValidation: mode };
        const legacyDoc = copy(sent);
        let legacyProblems;
        try { legacyProblems = BEFORE.preflight(env, legacyDoc); } catch (err) { legacyProblems = err; }
        const doc = copy(sent);
        let refused;
        try { refused = writeIntent.forCollection({ }, 'treatments', 'socket', { env }).check([doc]); } catch (err) { refused = err; }
        assert.deepEqual(doc, legacyDoc);
        if (legacyProblems instanceof Error) {
          assert.equal(refused.message, legacyProblems.message);
        } else if (legacyProblems) {
          assert.deepEqual(refused, [{ index: 0, problems: legacyProblems }]);
        } else {
          assert.deepEqual(refused, [ ]);
        }
      });
    }
  }
});

describe('write(intent): the socket\'s dbUpdate and dbUpdateUnset', function ( ) {
  const TT = { _id: new ObjectId(HEX), eventType: 'Temporary Target', created_at: T, duration: 30, targetTop: 110, targetBottom: 100, units: 'mg/dl' };
  const TT_STRING = Object.assign({ }, TT, { _id: HEX, targetTop: 120 });

  // [collection, label, _id, fields, reads, env]
  const UPDATE = [
    ['treatments', 'a 24-hex _id, plain $set (every stored form)', HEX.toUpperCase(), { notes: 'n' }, [ ]],
    ['treatments', 'an ObjectId', new ObjectId(HEX), { notes: 'n' }, [ ]],
    ['treatments', 'a custom _id (one record)', 'custom-id', { notes: 'n' }, [ ]],
    ['treatments', 'a number _id', 7, { notes: 'n' }, [ ]],
    ['treatments', 'a merge patch with a null (each record read and merged)', HEX, { notes: null, nested: { a: 1 } }
      , [[{ _id: new ObjectId(HEX), nested: { b: 2 }, notes: 'x' }, { _id: HEX, notes: 'y' }]]],
    ['treatments', 'a merge patch of a custom _id (findOne)', 'custom-id', { notes: null }, [[{ _id: 'custom-id', notes: 'x' }]]],
    ['treatments', 'a Temporary Target in mmol/L on one record', 'custom-id', { targetTop: 7, targetBottom: 6, units: 'mmol' }
      , [[Object.assign({ }, TT, { _id: 'custom-id' })]]],
    ['treatments', 'a Temporary Target on twins that differ (each)', HEX, { units: 'mmol' }, [[TT, TT_STRING]]],
    ['treatments', 'a Temporary Target on twins alike (one update)', HEX, { targetTop: 7, targetBottom: 6, units: 'mmol' }
      , [[TT, Object.assign({ }, TT, { _id: HEX })]]],
    ['treatments', 'an eventType change that names no target', HEX, { eventType: 'Note' }, [[{ _id: HEX, eventType: 'Meal Bolus' }]]],
    ['treatments', 'a Temporary Target, WRITE_VALIDATION=log', HEX, { targetTop: 7, targetBottom: 6, units: 'mmol' }, [[TT]], { writeValidation: 'log' }],
    ['devicestatus', 'a 24-hex _id', HEX, { notes: 'n' }, [ ]],
    ['profile', 'a custom _id', 'p-1', { defaultProfile: 'B' }, [ ]],
    ['entries', 'a 24-hex _id', HEX, { sgv: 100 }, [ ]],
    ['food', 'a 24-hex _id', HEX, { name: 'f' }, [ ]],
    ['activity', 'a 24-hex _id (no server dates)', HEX, { notes: 'a' }, [ ]],
    ['activity', 'a merge patch (no server dates)', 'a-1', { notes: null }, [[{ _id: 'a-1', notes: 'x' }]]]
  ];

  for (const [collection, label, id, fields, reads, env] of UPDATE) {
    it(collection + ' dbUpdate of ' + label + ' makes the calls dbUpdate made, by the same match', async function ( ) {
      const before = recorder(reads);
      const legacyFields = copy(fields);
      const legacyMatch = await BEFORE.dbUpdate(env || { }, before.storage, { collection, _id: id, data: legacyFields });

      const after = recorder(reads);
      const nowFields = copy(fields);
      const step = writeIntent.forCollection(after.storage, collection, 'socket', { env: env || { } });
      const planned = step.plan({ op: 'update', form: 'merge', target: { _id: id }, fields: nowFields });
      assert.deepEqual(norm(planned.match), norm(legacyMatch), 'the same _id match (it was idMatch)');
      const result = await step.write(planned);

      assert.deepEqual(after.calls, before.calls);
      assert(after.calls.length > 0);
      assert.deepEqual(nowFields, legacyFields, 'the sent fields are not changed');
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].outcome, 'merged');
    });
  }

  it('a dbUpdate that names nothing is not-found and writes only what dbUpdate wrote', async function ( ) {
    const before = recorder([ ], undefined, undefined, 0);
    await BEFORE.dbUpdate({ }, before.storage, { collection: 'treatments', _id: HEX, data: { notes: 'n' } });
    const after = recorder([ ], undefined, undefined, 0);
    const result = await writeIntent.forCollection(after.storage, 'treatments', 'socket')
      .write({ op: 'update', form: 'merge', target: { _id: HEX }, fields: { notes: 'n' } });
    assert.deepEqual(after.calls, before.calls);
    assert.equal(result.items[0].outcome, 'not-found');
  });

  it('a validation error in the conversion of a Temporary Target is thrown before any write, as it was', async function ( ) {
    const env = { writeValidation: 'reject' };
    const fields = { targetTop: 80, targetBottom: 120 };
    const before = recorder([[TT]]);
    const legacy = await settle(BEFORE.dbUpdate(env, before.storage, { collection: 'treatments', _id: HEX, data: copy(fields) }));
    const after = recorder([[TT]]);
    const now = await settle(writeIntent.forCollection(after.storage, 'treatments', 'socket', { env })
      .write({ op: 'update', form: 'merge', target: { _id: HEX }, fields: copy(fields) }));
    assert(legacy.error && now.error);
    assert.equal(now.error.name, legacy.error.name);
    assert.deepEqual(now.error.problems, legacy.error.problems);
    assert.deepEqual(after.calls, before.calls);
    assert.deepEqual(after.calls.map(c => c[0]), ['findFiltered']);
  });

  const UNSET = [
    ['treatments', HEX, { notes: 1, srvModified: 1, srvCreated: 1 }],
    ['treatments', 'custom-id', { srvModified: 1 }],
    ['devicestatus', new ObjectId(HEX), { notes: 1 }],
    ['activity', HEX, { notes: 1, srvModified: 1 }]
  ];
  for (const [collection, id, fields] of UNSET) {
    it(collection + ' dbUpdateUnset of ' + JSON.stringify(Object.keys(fields)) + ' by ' + String(id) + ' makes the call dbUpdateUnset made', async function ( ) {
      const before = recorder([ ]);
      const legacyMatch = await BEFORE.dbUpdateUnset({ }, before.storage, { collection, _id: id, data: copy(fields) });
      const after = recorder([ ]);
      const step = writeIntent.forCollection(after.storage, collection, 'socket');
      const planned = step.plan({ op: 'update', form: 'unset', target: { _id: id }, fields: copy(fields) });
      assert.deepEqual(norm(planned.match), norm(legacyMatch));
      const result = await step.write(planned);
      assert.deepEqual(after.calls, before.calls);
      assert.deepEqual(after.calls.map(c => c[0]), ['updateMany']);
      assert.equal(result.items[0].outcome, 'merged');
    });
  }

  it('plan() resolves the _id match synchronously, without touching storage', function ( ) {
    const step = writeIntent.forCollection(function ( ) { throw new Error('no storage at plan time'); }, 'treatments', 'socket');
    const planned = step.plan({ op: 'update', form: 'merge', target: { _id: HEX }, fields: { } });
    assert.equal(planned.match.many, true);
    assert.deepEqual(norm(planned.match.filter), { _id: { $in: norm(require('../lib/server/object-id-forms').idForms(HEX)) } });
    assert.throws(() => step.plan({ op: 'update', form: 'merge', fields: { } }), /update needs target._id/);
  });
});
