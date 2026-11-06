'use strict';

// ID-RESEND-SWITCH at the step (lib/storage/write-intent.js), over a live
// mongod: what WRITE_RESEND=acknowledge and refuse make write(intent) answer.
// Nothing is written, so the WriteResult has no `updated` (absent or [ ]); the
// one item names the stored record with the outcome ('unchanged' or
// 'refused') and the reason 'resend'; and the D-EVENT record carries that
// outcome. API v3's answers without a write go through settle(), which gives
// them the same WriteResult and event. Also the table: every re-send rule is
// marked, and no edit is. Per-path behaviour over HTTP and the socket is
// tests/write-resend.modes.test.js.
//
// Skipped without a database. Synthetic values only.

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');

const writeIntent = require('../lib/storage/write-intent');
const writeSettings = require('../lib/server/write-settings');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');

const mongoUrl = process.env.CUSTOMCONNSTR_mongo;
const OLD = 1557000000000;
const NOW = Date.now();
const iso = (t) => new Date(t).toISOString();

describe('ID-RESEND-SWITCH: the rule table', function ( ) {

  it('every create rule that matches a stored record is a re-send rule; no edit is', function ( ) {
    const resend = [ ];
    const notResend = [ ];
    Object.keys(writeIntent.COLLECTION_RULES).forEach(function (name) {
      const bySource = writeIntent.COLLECTION_RULES[name];
      Object.keys(bySource).forEach(function (source) {
        Object.keys(bySource[source]).forEach(function (op) {
          const rule = bySource[source][op];
          const rules = rule && rule.forms ? Object.keys(rule.forms).map((form) => [form, rule.forms[form]]) : [[undefined, rule]];
          rules.forEach(function ([form, r]) {
            const label = [name, source, op, form].filter(Boolean).join(' ');
            if (r && r.resend) resend.push(label);
            else notResend.push(label);
          });
        });
      });
    });
    assert.deepStrictEqual(resend.sort(), [
      'activity socket create', 'activity v1/internal create',
      'devicestatus socket create', 'devicestatus v1/internal create', 'devicestatus v3 create',
      'entries socket create', 'entries v1/internal create', 'entries v3 create',
      'food socket create', 'food v1/internal create', 'food v3 create',
      'profile socket create', 'profile v1/internal create', 'profile v3 create',
      'settings v3 create',
      'treatments socket create', 'treatments v1/internal create batch', 'treatments v1/internal create one', 'treatments v3 create'
    ].sort());
    // The preBolus record (created_at + eventType) and every edit stay as they are.
    assert(notResend.includes('treatments v1/internal create prebolus'));
    notResend.filter((l) => / (update|patch)$/.test(l)).forEach((l) => assert(!resend.includes(l), l));
  });

  it('resendOutcome: identity keys switch; a time key keeps the table, except mergeTime under merge', function ( ) {
    const env = (resend) => ({ write: { resend } });
    const MERGE = writeSettings.RESEND_MERGE;
    assert.equal(writeIntent.resendOutcome(env('replace'), 'food', 'identifier', 'replaced'), 'replaced');
    assert.equal(writeIntent.resendOutcome(env(MERGE), 'food', 'identifier', 'replaced'), 'merged');
    assert.equal(writeIntent.resendOutcome(env(MERGE), 'treatments', 'identifier', 'replaced'), 'replaced');
    assert.equal(writeIntent.resendOutcome(env(MERGE), 'food', 'time', 'replaced'), 'replaced');
    assert.equal(writeIntent.resendOutcome(env(MERGE), 'profile', 'time', 'replaced', { mergeTime: true }), 'merged');
    assert.equal(writeIntent.resendOutcome(env('acknowledge'), 'food', 'identity', 'replaced'), 'unchanged');
    assert.equal(writeIntent.resendOutcome(env('acknowledge'), 'profile', 'time', 'replaced', { mergeTime: true }), 'replaced');
    assert.equal(writeIntent.resendOutcome(env('refuse'), 'entries', 'computed', 'merged'), 'refused');
    assert.equal(writeIntent.resendOutcome(env('refuse'), 'entries', 'time', 'merged'), 'merged');
    assert.equal(writeIntent.resendOutcome({ }, 'food', 'identifier', 'replaced'), 'replaced');
  });

  it('deletedResendAction: revive only on an identity key, never under acknowledge or refuse', function ( ) {
    const rule = { deleted: 'stays-deleted', resend: true };
    const env = (resend, deletedResend) => ({ write: { resend, deletedResend } });
    assert.equal(writeIntent.deletedResendAction(rule, 'identifier', 'food', env('replace', 'stay')), 'acknowledged');
    assert.equal(writeIntent.deletedResendAction(rule, 'identifier', 'food', env('replace', 'revive')), 'revive');
    assert.equal(writeIntent.deletedResendAction(rule, 'identity', 'food', env(writeSettings.RESEND_MERGE, 'revive')), 'revive');
    assert.equal(writeIntent.deletedResendAction(rule, 'computed', 'entries', env('replace', 'revive')), 'revive');
    assert.equal(writeIntent.deletedResendAction(rule, 'time', 'entries', env('replace', 'revive')), 'hidden');
    assert.equal(writeIntent.deletedResendAction(rule, 'identifier', 'food', env('acknowledge', 'revive')), 'acknowledged');
    assert.equal(writeIntent.deletedResendAction(rule, 'identifier', 'food', env('refuse', 'revive')), 'acknowledged');
    // an edit's rule is not a re-send's
    assert.equal(writeIntent.deletedResendAction({ deleted: 'stays-deleted-edit' }, 'identifier', 'food', env('replace', 'revive')), 'edit');
    assert.equal(writeIntent.deletedResendAction({ deleted: 'stays-deleted' }, 'identifier', 'food', env('replace', 'revive')), 'acknowledged');
  });
});

(mongoUrl ? describe : describe.skip)('ID-RESEND-SWITCH at the step: acknowledge and refuse write nothing', function ( ) {
  this.timeout(60000);
  const physical = 'resend_' + randomUUID().replace(/-/g, '');
  let client, db;

  function storage (name, source, bus) {
    const ctx = { store: { collection: (n) => db.collection(n), db, ensureIndexes: ( ) => { } }, bus
      , cache: { treatments: [ ], entries: [ ], devicestatus: [ ] }, ddata: { processRawDataForRuntime: (d) => d } };
    const base = new MongoCollection(ctx, { }, physical, name, [ ], { source: source });
    return source === 'v3' ? new MongoCachedCollection(ctx, { }, name, base) : base;
  }

  // A live record with an identifier, stored straight to MongoDB.
  async function seed (fields) {
    const doc = Object.assign({ srvCreated: OLD, srvModified: OLD, identifier: randomUUID(), keep: 'stored' }, fields);
    const result = await db.collection(physical).insertOne(doc);
    return Object.assign({ _id: result.insertedId }, doc);
  }

  before(async function ( ) {
    const { MongoClient } = require('mongodb');
    client = await MongoClient.connect(mongoUrl);
    db = client.db();
  });

  after(async function ( ) {
    if (db) await db.collection(physical).drop().catch(( ) => { });
    if (client) await client.close();
  });

  // [name, source, a re-send body for the seeded record]
  const CASES = [
    ['food', 'v1/internal', (s) => ({ type: 'food', name: s.name, carbs: 99, identifier: s.identifier }), { type: 'food', name: 'f', carbs: 1 }],
    ['activity', 'v1/internal', (s) => ({ created_at: s.created_at, steps: 9, identifier: s.identifier }), { created_at: iso(NOW - 60000), steps: 1 }],
    ['devicestatus', 'v1/internal', (s) => ({ device: s.device, created_at: s.created_at, uploaderBattery: 9, identifier: s.identifier })
      , { device: 'resend-switch', created_at: iso(NOW - 120000), uploaderBattery: 1 }],
    ['profile', 'v1/internal', (s) => ({ defaultProfile: 'D', startDate: s.startDate, store: { D: { dia: 9 } }, identifier: s.identifier })
      , { defaultProfile: 'D', startDate: iso(NOW - 180000), store: { D: { dia: 3 } } }],
    ['entries', 'v1/internal', (s) => ({ type: 'sgv', sgv: 199, date: s.date, dateString: s.dateString, identifier: s.identifier })
      , { type: 'sgv', sgv: 100, date: NOW - 240000, dateString: iso(NOW - 240000), sysTime: iso(NOW - 240000) }],
    ['treatments', 'v1/internal', (s) => ({ eventType: 'Note', created_at: s.created_at, notes: 'resent', identifier: s.identifier })
      , { eventType: 'Note', created_at: iso(NOW - 300000), notes: 'stored' }],
    ['food', 'socket', (s) => ({ type: 'food', name: s.name, carbs: 99, identifier: s.identifier }), { type: 'food', name: 'g', carbs: 1 }],
    ['treatments', 'socket', (s) => ({ eventType: 'Note', created_at: s.created_at, notes: 'resent', identifier: s.identifier })
      , { eventType: 'Note', created_at: iso(NOW - 360000), notes: 'stored' }]
  ];

  ['acknowledge', 'refuse'].forEach(function (mode) {
    const outcome = mode === 'acknowledge' ? 'unchanged' : 'refused';
    CASES.forEach(function ([name, source, body, fields]) {
      it(mode + ': ' + name + ' from ' + source + ' answers ' + outcome + ', writes nothing, updated absent or [ ], one event record', async function ( ) {
        const seeded = await seed(fields);
        const bus = new EventEmitter();
        const events = [ ];
        bus.on(writeIntent.INTENT_EVENT, (e) => events.push(e));
        const env = { write: Object.freeze({ resend: mode, deletedResend: 'stay' }) };
        const step = writeIntent.forCollectionIntent(storage(name, source, bus), name, source, { env, bus });
        const intent = { op: 'create', docs: [body(seeded)] };
        if (name === 'treatments' && source === 'v1/internal') intent.form = 'batch';
        const written = await step.write(intent);
        assert.equal(written.items.length, 1);
        const it0 = written.items[0];
        assert.equal(it0.outcome, outcome);
        assert.equal(it0.reason, writeIntent.RESEND_REASON);
        assert.equal(String(it0._id), String(seeded._id));
        assert(written.updated === undefined || (Array.isArray(written.updated) && written.updated.length === 0)
          , 'updated: ' + JSON.stringify(written.updated));
        assert.equal(writeIntent.isNotWritten(it0), true);
        const now = await db.collection(physical).findOne({ _id: seeded._id });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(now)), JSON.parse(JSON.stringify(seeded)));
        assert.equal(await db.collection(physical).countDocuments({ identifier: seeded.identifier }), 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].records.length, 1);
        assert.equal(events[0].records[0].outcome, outcome);
        assert.equal(String(events[0].records[0]._id), String(seeded._id));
      });
    });
  });

  it('API v3 settle: an answer without a write is one item and one event; no updated', async function ( ) {
    const seeded = await seed({ date: NOW - 420000, app: 'resend-switch', device: 'resend-switch' });
    const bus = new EventEmitter();
    const events = [ ];
    bus.on(writeIntent.INTENT_EVENT, (e) => events.push(e));
    const env = { write: Object.freeze({ resend: 'refuse', deletedResend: 'stay' }) };
    const step = writeIntent.forCollectionIntent(storage('food', 'v3', bus), 'food', 'v3', { env, bus });
    const doc = { date: seeded.date, app: seeded.app, device: seeded.device, identifier: seeded.identifier };
    const stored = await step.match({ op: 'create', docs: [doc], fallbackFields: ['created_at'] });
    assert.equal(step.resendAction({ op: 'create', docs: [doc] }, stored), 'refused');
    const written = step.settle({ op: 'create', docs: [doc] }, stored, 'refused', writeIntent.RESEND_REASON);
    assert.equal(written.items[0].outcome, 'refused');
    assert.equal(written.items[0].identifier, seeded.identifier);
    assert.equal(written.updated, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].records[0].outcome, 'refused');
    assert.throws(( ) => step.settle({ op: 'create', docs: [doc] }, stored, 'replaced'), TypeError);
  });

  // settle()'s shape (release 2's owner, 2026-11-01): one item, outcome
  // `unchanged` or `refused`, `removed` and `updated` absent, and exactly one
  // D-EVENT per answer, so a consumer can tell from either alone that nothing
  // changed.
  [
    ['a v3 acknowledgement (WRITE_RESEND=acknowledge)', 'acknowledge', false, 'unchanged', writeIntent.RESEND_REASON],
    ['a v3 refusal (WRITE_RESEND=refuse)', 'refuse', false, 'refused', writeIntent.RESEND_REASON],
    ['the on-deleted acknowledgement (WRITE_DELETED_RESEND=stay)', 'replace', true, 'unchanged', writeIntent.DELETED_REASON]
  ].forEach(function ([label, mode, deleted, outcome, reason]) {
    it('settle() shape: ' + label, async function ( ) {
      const seeded = await seed(Object.assign({ date: NOW - 480000 - (deleted ? 1 : 0), app: 'resend-switch', device: 'resend-switch' }
        , deleted ? { isValid: false } : { }));
      const bus = new EventEmitter();
      const events = [ ];
      bus.on(writeIntent.INTENT_EVENT, (e) => events.push(e));
      const env = { write: Object.freeze({ resend: mode, deletedResend: 'stay' }) };
      const step = writeIntent.forCollectionIntent(storage('food', 'v3', bus), 'food', 'v3', { env, bus });
      const doc = { date: seeded.date, app: seeded.app, device: seeded.device, identifier: seeded.identifier };
      const intent = { op: 'create', docs: [doc] };
      const stored = await step.match(Object.assign({ fallbackFields: ['created_at'] }, intent));
      // the route's own decision (lib/api3/generic/create/operation.js)
      const action = step.onDeleted(intent, stored) === 'acknowledged' ? 'acknowledged' : step.resendAction(intent, stored);
      assert.equal(action, outcome === 'refused' ? 'refused' : 'acknowledged');
      const written = step.settle(intent, stored, outcome, reason);
      assert.deepStrictEqual(Object.keys(written).sort(), ['adapter', 'event', 'items']);
      assert.equal(written.event, null);
      assert.equal(written.adapter, null);
      assert.equal('updated' in written, false);
      assert.equal('removed' in written, false);
      assert.equal(written.items.length, 1);
      assert.deepStrictEqual(Object.assign({ }, written.items[0], { _id: undefined }), { index: 0, outcome, _id: undefined
        , identifier: seeded.identifier, reason });
      assert.equal(events.length, 1);
      const e = JSON.parse(JSON.stringify(events[0]));
      assert.deepStrictEqual(e, { collection: 'food', source: 'v3', op: 'create', collapsed: false
        , records: [{ _id: e.records[0]._id, identifier: seeded.identifier, outcome, problems: [reason] }]
        , counts: { records: 1, outcomes: { [outcome]: 1 } } });
      assert(Object.isFrozen(events[0]));
      const now = await db.collection(physical).findOne({ _id: seeded._id });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(now)), JSON.parse(JSON.stringify(seeded)));
    });
  });

  it('replace (the default): the step writes as the compatibility head does', async function ( ) {
    const seeded = await seed({ type: 'food', name: 'h', carbs: 1 });
    const env = { write: Object.freeze({ resend: 'replace', deletedResend: 'stay' }) };
    const step = writeIntent.forCollectionIntent(storage('food', 'v1/internal'), 'food', 'v1/internal', { env });
    const written = await step.write({ op: 'create', docs: [{ type: 'food', name: 'h', carbs: 2, identifier: seeded.identifier }] });
    assert.equal(written.items[0].outcome, 'replaced');
    const now = await db.collection(physical).findOne({ _id: seeded._id });
    assert.equal(now.carbs, 2);
    assert.equal(now.keep, undefined);
  });
});
