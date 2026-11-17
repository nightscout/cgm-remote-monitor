'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ObjectId } = require('mongodb');

const writeIntent = require('../lib/storage/write-intent');
const MongoCollection = require('../lib/api3/storage/mongoCollection');
const MongoCachedCollection = require('../lib/api3/storage/mongoCachedCollection');

// D-EVENT (maintainer 2026-10-31): one internal event per write(intent), equal
// to its WriteResult, over a live mongod. The paths are the step's own: every
// collection, source, op and form in COLLECTION_RULES, and API v3's autoPrune.
// For each, the event must name every stored record the write changed, and
// every record it refused, once, with the outcome word items[] gave it, and
// carry no document field and no filter. Above the resolve cap it lists no
// records (collapsed). It costs nothing without a listener.
//
// Skipped without a database. Synthetic values only.

const mongoUrl = process.env.CUSTOMCONNSTR_mongo;
const EVENT = writeIntent.INTENT_EVENT;
const SECRET = 'd-event-document-content';
const MARK = 'd-event-filter-mark';
const NOW = Date.now();
const iso = t => new Date(t).toISOString();

const RECORD_KEYS = ['_id', 'identifier', 'outcome', 'problems'];
const EVENT_KEYS = ['collection', 'source', 'op', 'collapsed', 'records', 'counts'];

// A document of each collection, carrying a field whose value must never
// reach the event.
function doc (name, n) {
  const t = NOW - 3600000 + n * 1000;
  const base = {
    treatments: { eventType: 'Note', created_at: iso(t) },
    entries: { type: 'sgv', sgv: 100 + n, date: t, dateString: iso(t) },
    devicestatus: { device: 'd-event', created_at: iso(t) },
    profile: { defaultProfile: 'D', startDate: iso(t), store: { D: { dia: 3 } } },
    food: { type: 'food', name: 'f' + n, created_at: iso(t) },
    activity: { name: 'a' + n, created_at: iso(t) },
    settings: { key: 'k' + n }
  }[name];
  return Object.assign({ notes: SECRET, mark: MARK }, base);
}

// Every path of the rule table: [name, source, op, form].
function paths ( ) {
  const out = [ ];
  Object.keys(writeIntent.COLLECTION_RULES).forEach(function (name) {
    const bySource = writeIntent.COLLECTION_RULES[name];
    Object.keys(bySource).forEach(function (source) {
      Object.keys(bySource[source]).forEach(function (op) {
        const rule = bySource[source][op];
        if (!rule || typeof rule !== 'object') return;
        if (rule.forms) Object.keys(rule.forms).forEach(function (form) { out.push([name, source, op, form]); });
        else out.push([name, source, op, undefined]);
      });
    });
  });
  return out;
}

const typedKey = id => (id instanceof ObjectId ? 'oid:' : typeof id + ':') + String(id);

(mongoUrl ? describe : describe.skip)('write(intent) D-EVENT: one event per write, its WriteResult', function ( ) {
  this.timeout(60000);
  const physical = 'wide_' + randomUUID().replace(/-/g, '');
  let client, db, raw;

  function storage (name, source, bus) {
    const ctx = { store: { collection: n => db.collection(n), db, ensureIndexes: ( ) => { } }, bus
      , cache: { treatments: [ ], entries: [ ], devicestatus: [ ] }, ddata: { processRawDataForRuntime: d => d } };
    const base = new MongoCollection(ctx, { }, physical, name, [ ], { source: source });
    return source === 'v3' ? new MongoCachedCollection(ctx, { }, name, base) : base;
  }

  // The seeded record: an ObjectId and its string twin, with an identifier.
  async function seed (name) {
    const id = new ObjectId();
    const stored = Object.assign(doc(name, 1), { _id: id, identifier: 'de-' + id.toHexString(), srvCreated: NOW - 7200000 });
    await raw.insertMany([stored, Object.assign({ }, stored, { _id: id.toHexString(), identifier: undefined })]);
    return { id, hex: id.toHexString(), identifier: stored.identifier, stored };
  }

  // The intent each path takes, from its source, op and form.
  function intentFor (name, source, op, form, s) {
    const fresh = Object.assign(doc(name, 2), source === 'v3' ? { identifier: 'de-new-' + randomUUID() } : { });
    if (op === 'create') {
      const d = form === 'prebolus' ? Object.assign(fresh, { carbs: 10, preBolus: 15 }) : fresh;
      return { op, form, docs: [d] };
    }
    if (source === 'v3') {
      if (op === 'delete') return { op, form, target: { identifier: s.hex } };
      if (op === 'patch') return { op, docs: [{ notes: SECRET + '-patched' }], target: { identifier: s.identifier, stored: s.stored } };
      return { op, docs: [Object.assign(fresh, { identifier: s.identifier })], target: { identifier: s.identifier, stored: s.stored } };
    }
    if (source === 'socket') {
      if (op === 'update') return { op, form, target: { _id: s.hex }, fields: form === 'unset' ? { notes: 1 } : { notes: SECRET + '-u' } };
      return { op, target: { _id: s.hex } };
    }
    const rule = writeIntent.COLLECTION_RULES[name][source][op];
    if (op === 'delete' || op === 'prune') return { op, target: rule.target === 'query' ? { filter: { mark: MARK } } : { _id: s.hex } };
    return { op, form, docs: [Object.assign(fresh, { _id: s.hex })] };
  }

  async function snapshot ( ) {
    return new Map((await raw.find({ }).toArray()).map(d => [typedKey(d._id), JSON.stringify(d)]));
  }

  async function run (name, source, intent, s) {
    const bus = new EventEmitter();
    const events = [ ];
    bus.on(EVENT, e => events.push(e));
    const before = await snapshot();
    const step = writeIntent.forCollectionIntent(storage(name, source, bus), name, source, { env: { }, bus });
    const planned = source === 'socket' && intent.op === 'update' ? step.plan(intent) : intent;
    const written = await step.write(planned);
    const after = await snapshot();
    const changed = new Set();
    for (const [k, v] of before) if (after.get(k) !== v) changed.add(k);
    for (const k of after.keys()) if (!before.has(k)) changed.add(k);
    return { written, events, changed, s, after };
  }

  function check (label, out) {
    assert.equal(out.events.length, 1, label + ': one event per write(intent)');
    const e = out.events[0];
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.records) && Object.isFrozen(e.counts), label + ': frozen');
    assert.deepEqual(Object.keys(e).filter(k => EVENT_KEYS.indexOf(k) === -1), [ ], label + ': event keys');
    e.records.forEach(r => assert.deepEqual(Object.keys(r).filter(k => RECORD_KEYS.indexOf(k) === -1), [ ], label + ': record keys'));
    assert.equal(JSON.stringify(e).indexOf(SECRET), -1, label + ': no document content');
    assert.equal(JSON.stringify(e).indexOf(MARK), -1, label + ': no filter');
    if (e.collapsed) return e;
    const keys = e.records.filter(r => r._id !== null).map(r => typedKey(r._id));
    assert.equal(new Set(keys).size, keys.length, label + ': each record once');
    // every stored record the write changed is named, by its _id
    out.changed.forEach(k => assert.ok(keys.indexOf(k) !== -1, label + ': changed record ' + k + ' named; event ' + JSON.stringify(e.records)));
    // every refused record is named, with its problems
    out.written.items.filter(it => it.outcome === 'refused').forEach(function (it) {
      assert.ok(e.records.some(r => r.outcome === it.outcome && String(r._id) === String(it._id) && r.problems !== undefined)
        , label + ': refused record named');
    });
    // the words are items[]'s, unchanged, and the identifiers too
    const words = new Set(out.written.items.map(it => it.outcome));
    e.records.forEach(r => assert.ok(words.has(r.outcome), label + ': outcome word ' + r.outcome + ' is an item\'s'));
    e.records.forEach(r => assert.ok(out.written.items.some(it => (it.identifier === undefined ? null : it.identifier) === r.identifier), label + ': identifier as items[] gave it'));
    assert.equal(e.counts.records, e.records.length, label + ': counts');
    return e;
  }

  before(async function ( ) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(mongoUrl);
    await client.connect();
    db = client.db();
    raw = db.collection(physical);
  });
  beforeEach(async function ( ) { await raw.deleteMany({ }); });
  after(async function ( ) {
    try { if (raw) await raw.drop(); } finally { if (client) await client.close(); }
  });

  it('the rule table has paths to follow', function ( ) {
    assert.ok(paths().length > 20, String(paths().length));
  });

  paths().forEach(function ([name, source, op, form]) {
    const label = [name, source, op, form].filter(Boolean).join(' ');
    it(label + ': names every record it stored or refused, once, with items[]\'s words', async function ( ) {
      const s = await seed(name);
      const out = await run(name, source, intentFor(name, source, op, form, s), s);
      check(label, out);
    });
  });

  // A create of every path that re-sends the stored record's identifier at the
  // stored time: identifier first (ID-FIRST-MATCH 6/6a) answers it with
  // whatever word that path's rule gives (merged, replaced, unchanged, ...);
  // the event carries the word items[] has, whichever it is.
  paths().filter(function (p) { return p[2] === 'create'; }).forEach(function ([name, source, op, form]) {
    const label = [name, source, op, form, 're-send by identifier'].filter(Boolean).join(' ');
    it(label + ': the event carries items[]\'s word and identifier', async function ( ) {
      const s = await seed(name);
      const again = Object.assign(doc(name, 1), { identifier: s.identifier, notes: SECRET + '-again' });
      if (form === 'prebolus') Object.assign(again, { carbs: 10, preBolus: 15 });
      const intent = source === 'v3' ? { op, docs: [again], target: { identifier: s.identifier, stored: s.stored } }
        : { op, form, docs: [again] };
      const out = await run(name, source, intent, s);
      const e = check(label, out);
      assert.deepEqual(e.records.map(r => r.outcome).filter((w, i, all) => all.indexOf(w) === i).sort()
        , out.written.items.map(it => it.outcome).filter((w, i, all) => all.indexOf(w) === i).sort(), label + ': the same words');
    });
  });

  it('a v1 profile create naming a stored identifier at another startDate: a new profile, the identifier as items[] gave it', async function ( ) {
    const s = await seed('profile');
    const other = Object.assign(doc('profile', 9), { identifier: s.identifier });
    const out = await run('profile', 'v1/internal', { op: 'create', docs: [other] }, s);
    const e = check('profile other startDate', out);
    const added = (await raw.find({ startDate: other.startDate }).toArray());
    assert.equal(added.length, 1);
    assert.equal(added[0].identifier, undefined, 'stored without the copied identifier');
    assert.equal(e.records.length, 1);
    assert.equal(e.records[0].outcome, out.written.items[0].outcome);
    assert.strictEqual(e.records[0].identifier, out.written.items[0].identifier === undefined ? null : out.written.items[0].identifier);
    assert.notEqual(e.records[0].identifier, s.identifier, 'the dropped identifier is not put back');
  });

  it('a treatments preBolus record that replaces a stored one by created_at + eventType, with no identifier, is named by its _id', async function ( ) {
    const derived = '2026-10-31T10:15:00.000Z';
    const { insertedId } = await raw.insertOne({ eventType: 'Meal Bolus', created_at: derived, carbs: 5 });
    const out = await run('treatments', 'v1/internal', { op: 'create', form: 'prebolus', docs: [{ eventType: 'Meal Bolus', created_at: derived, carbs: 30 }] });
    const e = check('preBolus by fallback key', out);
    assert.deepEqual(e.records.map(r => [String(r._id), r.identifier, r.outcome]), [[String(insertedId), null, 'replaced']]);
  });

  it('API v3 autoPrune (not in the rule table): names each record it removed', async function ( ) {
    await raw.insertMany([Object.assign(doc('treatments', 1), { date: NOW - 40 * 86400000, srvCreated: NOW })
      , Object.assign(doc('treatments', 2), { date: NOW, srvCreated: NOW })]);
    const out = await run('treatments', 'v3', { op: 'prune', target: { filter: [{ field: 'date', operator: 'lt', value: NOW - 30 * 86400000 }] } });
    const e = check('v3 prune', out);
    assert.equal(e.records.length, 1);
  });

  it('a refused record is named with its problems (socket insert of a stored _id)', async function ( ) {
    const s = await seed('entries');
    const out = await run('entries', 'socket', { op: 'create', docs: [Object.assign(doc('entries', 3), { _id: s.id })] }, s);
    assert.equal(out.written.items[0].outcome, 'refused');
    const e = check('socket refused', out);
    assert.equal(e.records.length, 1);
    assert.equal(String(e.records[0]._id), s.hex);
    assert.ok(Array.isArray(e.records[0].problems) && e.records[0].problems.length > 0);
  });

  it('over the resolve cap: no records, collapsed, the outcome counted', async function ( ) {
    const docs = [ ];
    for (let i = 0; i <= writeIntent.RESOLVE_CAP; i += 1) docs.push(Object.assign(doc('entries', i), { date: i }));
    await raw.insertMany(docs);
    const out = await run('entries', 'v1/internal', { op: 'delete', target: { filter: { mark: MARK } } });
    const e = check('over the cap', out);
    assert.equal(e.collapsed, true);
    assert.deepEqual(e.records, [ ]);
    assert.equal(e.counts.records, 0);
  });

  it('the payload carries no document field', async function ( ) {
    const s = await seed('treatments');
    const out = await run('treatments', 'v3', { op: 'update', docs: [Object.assign(doc('treatments', 2), { identifier: s.identifier })]
      , target: { identifier: s.identifier, stored: s.stored } }, s);
    const e = check('payload', out);
    const fields = new Set(Object.keys(doc('treatments', 0)).concat(['date', 'srvModified', 'srvCreated', 'created_at', 'eventType']));
    e.records.forEach(r => Object.keys(r).forEach(k => assert.ok(!fields.has(k), 'document field ' + k + ' in the event')));
    Object.keys(e).forEach(k => assert.ok(!fields.has(k), 'document field ' + k + ' in the event'));
  });

  it('without a listener: no event is built or emitted, and no read is added', async function ( ) {
    async function writes (listen) {
      await raw.deleteMany({ });
      const s = await seed('treatments');
      const bus = new EventEmitter();
      if (listen) bus.on(EVENT, ( ) => { });
      const emitted = [ ];
      const emit = bus.emit;
      bus.emit = function (name, ...args) { emitted.push(name); return emit.call(this, name, ...args); };
      const st = storage('treatments', 'v1/internal', bus);
      let reads = 0;
      const findFiltered = st.findFiltered;
      st.findFiltered = function (...args) { reads += 1; return findFiltered.apply(this, args); };
      const step = writeIntent.forCollectionIntent(st, 'treatments', 'v1/internal', { env: { }, bus });
      await step.write({ op: 'delete', target: { filter: { _id: { $in: [s.id, s.hex] } } } });
      return { reads, intentEmits: emitted.filter(n => n === EVENT).length };
    }
    const quiet = await writes(false);
    const heard = await writes(true);
    assert.equal(quiet.intentEmits, 0, 'no event emitted without a listener');
    assert.equal(heard.intentEmits, 1);
    assert.equal(quiet.reads, heard.reads, 'the event adds no read');
  });

  it('nothing in lib/ listens', function ( ) {
    const { execFileSync } = require('node:child_process');
    let found;
    try { found = execFileSync('git', ['grep', '-n', 'INTENT_EVENT\\|storage-intent-committed', '--', 'lib'], { encoding: 'utf8' }); } catch { found = ''; }
    const listeners = found.split('\n').filter(l => l && !/lib\/storage\/write-intent\.js/.test(l));
    assert.deepEqual(listeners, [ ]);
  });
});
