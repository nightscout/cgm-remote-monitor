'use strict';

// ID-FIRST-MATCH slice 4, "merge on match" (lib/storage/write-intent.js), as
// the maintainer decided it:
// - ID-Q8, one rule: a re-send (a create) that matches a stored record is
//   merged into it as a JSON Merge Patch (RFC 7386, lib/server/merge-patch.js):
//   a member it sends replaces the stored one, an object merges member by
//   member, an array is a value, a null removes the member, and a member it
//   leaves out is kept. Only PUT (API v1, API v3) and in-process save replace;
//   API v3 PATCH was a merge already.
// - Treatments keep the replace, on API v1, in-process and API v3 (decided
//   2026-10-30): Loop ends an indefinite override by re-sending it whole with
//   a duration and without durationType, and a merge would keep durationType.
// - ID-Q7: a matched profile re-send replaces `store` as a whole; its other
//   fields merge.
// - ID-Q2: device status merges on an identifier match (it was answered
//   without a write); API v3's created_at + device fallback keeps its replace
//   (ID-NATURAL-KEY).
// The outcome each path reports becomes `merged` where it was `replaced`; the
// replies are otherwise as before.
//
// CHANGED EXPECTATIONS (maintainer 2026-10-31, compat card B, `c1-replace`):
// a matched re-send REPLACES again on API v3 POST (every collection), the
// socket's profile dbAdd, and an API v1 / in-process food or activity create
// by a stored _id, as on 15.0.9. ID-Q8's merge stays for an API v1 /
// in-process / socket create that identifier first sent to a stored record,
// for API v1 entries, device status and profile creates, and for PATCH and
// dbUpdate. ID-Q7 (`store` whole) is moot where the record is replaced. Each
// test below that changed says so; tests/write-intent.resend-replace.test.js
// holds card B's own tests. Every seed carries a field the re-send
// leaves out (`kept`), so a merge and a replace differ on the stored record.
// Synthetic values only.

require('should');
const assert = require('node:assert/strict');
const mergePatch = require('../lib/server/merge-patch');
const writeIntent = require('../lib/storage/write-intent');

describe('merge on match: the rule (RFC 7386, ID-Q8, ID-Q7)', function ( ) {

  const stored = { _id: 'a', carbs: 20, notes: 'n', kept: 1, nested: { a: 1, b: { c: 2, d: 3 } }, list: [1, 2, 3] };

  it('a member left out is kept; a member sent replaces it', function ( ) {
    const parts = mergePatch.update(stored, { carbs: 30 }, { skip: ['_id'] });
    mergePatch.assignInto(Object.assign({ }, stored), parts).should.eql(Object.assign({ }, stored, { carbs: 30 }));
  });

  it('a null removes the member, at any depth', function ( ) {
    const parts = mergePatch.update(stored, { notes: null, nested: { b: { c: null } } });
    parts.unset.should.eql({ notes: '' });
    const after = mergePatch.assignInto(Object.assign({ }, stored), parts);
    assert.equal(Object.prototype.hasOwnProperty.call(after, 'notes'), false);
    after.nested.should.eql({ a: 1, b: { d: 3 } });
  });

  it('an object merges member by member', function ( ) {
    const parts = mergePatch.update(stored, { nested: { b: { e: 4 }, f: 5 } });
    parts.set.nested.should.eql({ a: 1, b: { c: 2, d: 3, e: 4 }, f: 5 });
  });

  it('an array is a value: replaced whole', function ( ) {
    mergePatch.update(stored, { list: [9] }).set.list.should.eql([9]);
  });

  it('`whole` takes a member as sent, without a member-by-member merge (a null still removes it)', function ( ) {
    const profile = { store: { Default: { dia: 3 }, Alt: { dia: 4 } }, units: 'mg/dl', kept: 1 };
    const parts = mergePatch.update(profile, { store: { Default: { dia: 5 } } }, { whole: ['store'] });
    parts.set.store.should.eql({ Default: { dia: 5 } });
    mergePatch.update(profile, { store: { Default: { dia: 5 } } }).set.store
      .should.eql({ Default: { dia: 5 }, Alt: { dia: 4 } });
    mergePatch.update(profile, { store: null }, { whole: ['store'] }).unset.should.eql({ store: '' });
    // a null inside a member taken whole is not stored: RFC 7386 on an absent target
    mergePatch.update(profile, { store: { Default: { dia: 5, gone: null }, Alt: null } }, { whole: ['store'] }).set.store
      .should.eql({ Default: { dia: 5 } });
  });

  // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): food and
  // activity creates by _id, the socket's profile dbAdd and every API v3 POST
  // replace; it said `merged` for each.
  it('a create that matches merges where card B left the merge; only PUT and save replace', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    rules.treatments['v1/internal'].create.forms.batch.onMatch.should.equal('replaced');
    rules.treatments['v1/internal'].create.forms.one.onMatch.should.equal('replaced');
    rules.treatments['v1/internal'].update.onMatch.should.equal('replaced');
    // the preBolus record is one the server derives, not a client re-send (Q-H)
    rules.treatments['v1/internal'].create.forms.prebolus.onMatch.should.equal('replaced');
    rules.food['v1/internal'].create.onMatch.should.equal('replaced');
    rules.food['v1/internal'].create.onIdentifierMatch.should.equal('merged');
    rules.food['v1/internal'].update.onMatch.should.equal('replaced');
    rules.activity['v1/internal'].create.onMatch.should.equal('replaced');
    rules.activity['v1/internal'].create.onIdentifierMatch.should.equal('merged');
    rules.activity['v1/internal'].update.onMatch.should.equal('replaced');
    rules.devicestatus['v1/internal'].create.onMatch.should.equal('merged');
    rules.profile.socket.create.onExact.should.equal('replaced');
    rules.profile.socket.create.onIdentifier.should.equal('replaced');
    rules.treatments.v3.create.onMatch.should.equal('replaced');
    ['entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      rules[name].v3.create.onMatch.should.equal('replaced');
    });
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      rules[name].v3.update.write.should.equal('v3-replace');
      rules[name].v3.patch.write.should.equal('v3-merge');
    });
    rules.devicestatus.v3.create.onTimeMatch.should.equal('replaced');
  });

  // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): the socket's
  // profile dbAdd and API v3 POST replace the whole record, so they name no
  // merge; ID-Q7 holds where a profile re-send still merges (API v1,
  // in-process).
  it('a profile re-send that merges takes `store` whole (ID-Q7); where it replaces, no merge is named', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    rules.profile['v1/internal'].create.merge.should.equal('rfc7386-store-whole');
    assert.equal(rules.profile.socket.create.merge, undefined);
    assert.equal(rules.profile.v3.create.merge, undefined);
    writeIntent.MERGES['rfc7386-store-whole'].whole.should.eql(['store']);
    writeIntent.MERGES.rfc7386.whole.should.eql([ ]);
  });

  it('every rule that names a merge names an entry of MERGES', function ( ) {
    const named = [ ];
    (function walk (value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.merge === 'string') named.push(value.merge);
      Object.keys(value).forEach(function (key) { walk(value[key]); });
    })(writeIntent.COLLECTION_RULES);
    assert(named.length > 0);
    named.forEach(function (name) { assert(Object.prototype.hasOwnProperty.call(writeIntent.MERGES, name), name); });
  });
});

describe('ID-FIRST-MATCH slice 4: a matched re-send merges where compat card B left the merge', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'merge-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const v1 = (method, url) => self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  const uuid = ( ) => require('crypto').randomUUID();
  const has = (doc, field) => Object.prototype.hasOwnProperty.call(doc, field);
  const v3 = (method, url) => self.instance[method]('/api/v3' + url, self.jwt.all);

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  const mine = (name, field, value) => col(name).find({ [field]: value }).toArray();
  async function only (name, field, value) {
    const docs = await mine(name, field, value);
    docs.length.should.equal(1);
    return docs[0];
  }
  const cached = (name, id) => (self.instance.ctx.cache.getData(name) || []).filter((d) => String(d._id) === String(id));

  function treatment (note, fields) {
    return Object.assign({ eventType: 'Carb Correction', created_at: iso(Date.now() - 600000), carbs: 20, notes: note, enteredBy: TAG }, fields);
  }

  // data-update events while `run` runs: a cache flush is a `remove` with no
  // changes (lib/server/cache.js).
  async function events (run) {
    const seen = [ ];
    const listener = (ev) => seen.push(ev);
    self.instance.ctx.bus.on('data-update', listener);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      self.instance.ctx.bus.removeListener('data-update', listener);
    }
    return seen;
  }
  const flushes = (seen) => seen.filter((ev) => ev.op === 'remove' && !ev.changes);

  before(async ( ) => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;
    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function ( ) {
        self.socket.emit('authorize', { client: 'test', secret: HASH }, function (auth) {
          if (!auth || !auth.write || !auth.write_treatment) return reject(new Error('socket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  after(async ( ) => {
    if (self.socket) self.socket.close();
    await Promise.all(['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'].map((name) =>
      col(name).deleteMany({ $or: [{ notes: { $regex: '^' + TAG } }, { device: { $regex: '^' + TAG } }
        , { enteredBy: TAG }
        , { name: { $regex: '^' + TAG } }, { defaultProfile: { $regex: '^' + TAG } }] })));
    self.instance.ctx.bus.teardown();
  });

  describe('API v1 and in-process treatments: a matched re-send replaces', function ( ) {

    it('Loop ends an indefinite override by re-sending it with a duration: durationType is gone, the duration stored', async ( ) => {
      // As NightscoutKit's OverrideTreatment uploads it: the sync UUID as _id
      // (stored as identifier, REQ-SYNC-072), the start time unchanged, and
      // either durationType 'indefinite' or a duration in minutes, never both;
      // a value Loop has none for is left out, not sent as null.
      const note = tag();
      const syncId = uuid().toUpperCase();
      const start = iso(Date.now() - 45 * 60000);
      const override = (fields) => Object.assign({ _id: syncId, eventType: 'Temporary Override', created_at: start
        , timestamp: start, enteredBy: TAG, reason: note, insulinNeedsScaleFactor: 1.2, correctionRange: [90, 110] }, fields);
      const first = await v1('post', '/treatments/').send([override({ durationType: 'indefinite' })]).expect(200);
      const res = await v1('post', '/treatments/').send([override({ duration: 37.5 })]).expect(200);
      String(res.body[0]._id).should.equal(String(first.body[0]._id));
      const stored = await only('treatments', 'reason', note);
      has(stored, 'durationType').should.equal(false);
      stored.duration.should.equal(37.5);
      stored.identifier.should.equal(syncId);
      stored.insulinNeedsScaleFactor.should.equal(1.2);
    });

    it('a batch re-send by identifier replaces: a field it leaves out is gone; the reply is as before', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 600000);
      const first = await v1('post', '/treatments/').send([treatment(note, { identifier, created_at, kept: 1
        , extra: { a: 1, b: 2 } })]).expect(200);
      const res = await v1('post', '/treatments/').send([treatment(note, { identifier, created_at, carbs: 30
        , extra: { b: 3 } })]).expect(200);
      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(String(first.body[0]._id));
      res.body[0].carbs.should.equal(30);
      const stored = await only('treatments', 'notes', note);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(30);
      stored.extra.should.eql({ b: 3 });
      stored.identifier.should.equal(identifier);
    });

    it('a single document re-send by _id replaces', async ( ) => {
      const note = tag();
      const first = await v1('post', '/treatments/').send(treatment(note, { kept: 1 })).expect(200);
      const id = String(first.body[0]._id);
      await v1('post', '/treatments/').send(treatment(note, { _id: id, carbs: 30 })).expect(200);
      const stored = await only('treatments', 'notes', note);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(30);
    });

    it('AndroidAPS sends pumpId as a JSON number: the replace stores it as sent', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 600000);
      await v1('post', '/treatments/').send([treatment(note, { identifier, created_at, pumpId: 4102, kept: 1 })]).expect(200);
      await v1('post', '/treatments/').send([treatment(note, { identifier, created_at, pumpId: 4103 })]).expect(200);
      const stored = await only('treatments', 'notes', note);
      assert.strictEqual(stored.pumpId, 4103);
      has(stored, 'kept').should.equal(false);
    });

    it('in-process create replaces', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 600000);
      const create = (docs) => new Promise((resolve, reject) => self.instance.ctx.treatments.create(docs
        , (err, result) => err ? reject(err) : resolve(result)));
      const first = await create([treatment(note, { identifier, created_at, kept: 1 })]);
      const again = await create([treatment(note, { identifier, created_at, carbs: 31 })]);
      String(again[0]._id).should.equal(String(first[0]._id));
      const stored = await only('treatments', 'notes', note);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(31);
    });

    it('the step answers `replaced` for a matched re-send, `inserted` for a new one', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 600000);
      const store = ( ) => require('../lib/server/storage-reads').collection(self.instance.ctx, self.instance.env
        , self.instance.env.treatments_collection, 'treatments');
      const step = writeIntent.forCollection(store, 'treatments', 'v1/internal', { env: self.instance.env });
      const first = await step.write({ op: 'create', form: 'batch', docs: [treatment(note, { identifier, created_at })] });
      first.items[0].outcome.should.equal('inserted');
      const again = await step.write({ op: 'create', form: 'batch', docs: [treatment(note, { identifier, created_at, carbs: 5 })] });
      again.items[0].outcome.should.equal('replaced');
      const one = await step.write({ op: 'create', form: 'one', docs: [treatment(note, { identifier, created_at, carbs: 6 })] });
      one.items[0].outcome.should.equal('replaced');
    });

    it('API v1 PUT replaces: a field the edit leaves out is gone', async ( ) => {
      const note = tag();
      const first = await v1('post', '/treatments/').send(treatment(note, { kept: 1 })).expect(200);
      const stored = await only('treatments', 'notes', note);
      await v1('put', '/treatments/').send(treatment(note, { _id: String(first.body[0]._id), created_at: stored.created_at, carbs: 40 })).expect(200);
      const after = await only('treatments', 'notes', note);
      has(after, 'kept').should.equal(false);
      after.carbs.should.equal(40);
    });

    it('in-process save replaces', async ( ) => {
      const note = tag();
      const first = await v1('post', '/treatments/').send(treatment(note, { kept: 1 })).expect(200);
      const stored = await only('treatments', 'notes', note);
      await new Promise((resolve, reject) => self.instance.ctx.treatments.save(treatment(note, { _id: first.body[0]._id
        , created_at: stored.created_at, carbs: 41 }), (err) => err ? reject(err) : resolve()));
      const after = await only('treatments', 'notes', note);
      has(after, 'kept').should.equal(false);
      after.carbs.should.equal(41);
    });
  });

  describe('API v3 POST', function ( ) {

    function body (note, fields) {
      return Object.assign({ eventType: 'Carb Correction', date: Date.now() - 600000, utcOffset: 0, app: 'merge', device: 'merge-' + note
        , carbs: 20, notes: note }, fields);
    }

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): an entries
    // re-send replaces (it merged: `kept` stayed); a null is stored as sent.
    it('a re-send replaces: the reply is the deduplication reply, the cache holds the replaced record, no flush', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      const entry = (fields) => Object.assign({ type: 'sgv', sgv: 120, date, utcOffset: 0, app: 'merge', device, identifier }, fields);
      await v3('post', '/entries').send(entry({ kept: 1, gone: 'x' })).expect(201);
      let res;
      const seen = await events(async ( ) => {
        res = await v3('post', '/entries').send(entry({ sgv: 130, gone: null })).expect(200);
      });
      Object.keys(res.body).should.eql(['status', 'lastModified', 'identifier', 'isDeduplication']);
      res.body.identifier.should.equal(identifier);
      res.body.isDeduplication.should.equal(true);
      const stored = await only('entries', 'device', device);
      has(stored, 'kept').should.equal(false);
      stored.sgv.should.equal(130);
      assert.strictEqual(stored.gone, null);
      res.body.lastModified.should.equal(stored.srvModified);
      flushes(seen).length.should.equal(0);
      const inCache = cached('entries', stored._id);
      inCache.length.should.equal(1);
      has(inCache[0], 'kept').should.equal(false);
      inCache[0].sgv.should.equal(130);
    });

    it('a treatment re-send replaces (2026-10-30): a field it leaves out is gone, a null is stored; the reply is the deduplication reply, no flush', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      await v3('post', '/treatments').send(body(note, { identifier, date, kept: 1, gone: 'x' })).expect(201);
      let res;
      const seen = await events(async ( ) => {
        res = await v3('post', '/treatments').send(body(note, { identifier, date, carbs: 30, gone: null })).expect(200);
      });
      Object.keys(res.body).should.eql(['status', 'lastModified', 'identifier', 'isDeduplication']);
      res.body.isDeduplication.should.equal(true);
      const stored = await only('treatments', 'notes', note);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(30);
      assert.strictEqual(stored.gone, null);
      flushes(seen).length.should.equal(0);
      const inCache = cached('treatments', stored._id);
      inCache.length.should.equal(1);
      has(inCache[0], 'kept').should.equal(false);
      inCache[0].carbs.should.equal(30);
    });

    it('a Loop-shaped override re-send that ends it: durationType is gone, the duration stored', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 45 * 60000;
      const override = (fields) => body(note, Object.assign({ identifier, date, eventType: 'Temporary Override', reason: note
        , insulinNeedsScaleFactor: 1.2, correctionRange: [90, 110], carbs: undefined }, fields));
      await v3('post', '/treatments').send(override({ durationType: 'indefinite' })).expect(201);
      await v3('post', '/treatments').send(override({ duration: 37 })).expect(200);
      const stored = await only('treatments', 'notes', note);
      has(stored, 'durationType').should.equal(false);
      stored.duration.should.equal(37);
    });

    it('the immutable-field 400 stays', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      await v3('post', '/treatments').send(body(note, { identifier, date, kept: 1 })).expect(201);
      await v3('post', '/treatments').send(body(note, { identifier, date: date + 300000 })).expect(400);
      const stored = await only('treatments', 'notes', note);
      stored.carbs.should.equal(20);
      stored.kept.should.equal(1);
    });

    it('PUT replaces; PATCH merges', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      await v3('post', '/treatments').send(body(note, { identifier, date, kept: 1 })).expect(201);
      await v3('patch', '/treatments/' + identifier).send({ carbs: 25 }).expect(200);
      let stored = await only('treatments', 'notes', note);
      stored.kept.should.equal(1);
      await v3('put', '/treatments/' + identifier).send(body(note, { identifier, date, carbs: 26 })).expect(200);
      stored = await only('treatments', 'notes', note);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(26);
    });

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): the whole
    // profile is replaced (ID-Q7 moot); `kept` was merged in and stayed.
    it('profile: the whole record is replaced, `store` included', async ( ) => {
      const name = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      const profile = (fields) => Object.assign({ identifier, date, utcOffset: 0, app: 'merge', device: 'merge', defaultProfile: name
        , units: 'mg/dl' }, fields);
      await v3('post', '/profile').send(profile({ kept: 1, store: { [name]: { dia: 3 }, Alt: { dia: 4 } } })).expect(201);
      await v3('post', '/profile').send(profile({ store: { [name]: { dia: 5 } } })).expect(200);
      const stored = await only('profile', 'defaultProfile', name);
      stored.store.should.eql({ [name]: { dia: 5 } });
      has(stored, 'kept').should.equal(false);
    });

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): ID-Q2's
    // merge on API v3 is reversed; the re-send replaces.
    it('devicestatus: a re-send by identifier replaces (compat card B; ID-Q2 had it merge)', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 300000;
      await v3('post', '/devicestatus').send({ identifier, date, utcOffset: 0, app: 'merge', device, kept: 1, uploaderBattery: 50 }).expect(201);
      const res = await v3('post', '/devicestatus').send({ identifier, date, utcOffset: 0, app: 'merge', device, uploaderBattery: 60 }).expect(200);
      res.body.isDeduplication.should.equal(true);
      const stored = await only('devicestatus', 'device', device);
      has(stored, 'kept').should.equal(false);
      stored.uploaderBattery.should.equal(60);
      res.body.lastModified.should.equal(stored.srvModified);
    });

    it('devicestatus: a match on created_at + device alone still replaces (ID-NATURAL-KEY)', async ( ) => {
      const device = tag();
      const created_at = iso(Date.now() - 300000);
      await v1('post', '/devicestatus/').send({ device, created_at, kept: 1, uploaderBattery: 50 }).expect(200);
      await v3('post', '/devicestatus').send({ date: Date.parse(created_at), utcOffset: 0, app: 'merge', device, uploaderBattery: 60 }).expect(200);
      const stored = await only('devicestatus', 'device', device);
      has(stored, 'kept').should.equal(false);
      stored.uploaderBattery.should.equal(60);
    });
  });

  describe('API v1 device status, profile, food, activity and entries', function ( ) {

    it('devicestatus: a re-send by identifier merges and is announced (ID-Q2); a re-send by a stored _id is still not written', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 300000);
      const first = await v1('post', '/devicestatus/').send({ device, created_at, identifier, kept: 1, uploaderBattery: 50 }).expect(200);
      let res;
      const seen = await events(async ( ) => {
        res = await v1('post', '/devicestatus/').send({ device, created_at, identifier, uploaderBattery: 60 }).expect(200);
      });
      String(res.body[0]._id).should.equal(String(first.body[0]._id));
      let stored = await only('devicestatus', 'device', device);
      stored.kept.should.equal(1);
      stored.uploaderBattery.should.equal(60);
      stored.srvModified.should.be.above(stored.srvCreated);
      seen.filter((ev) => ev.type === 'devicestatus' && ev.op === 'update').length.should.equal(1);
      const modified = stored.srvModified;
      await v1('post', '/devicestatus/').send({ _id: String(stored._id), device, created_at, uploaderBattery: 70 }).expect(200);
      stored = await only('devicestatus', 'device', device);
      stored.uploaderBattery.should.equal(60);
      stored.srvModified.should.equal(modified);
    });

    it('profile: a re-send by _id replaces `store` whole and merges the rest (ID-Q7)', async ( ) => {
      const name = tag();
      const startDate = iso(Date.now());
      const first = await v1('post', '/profile/').send({ defaultProfile: name, startDate, units: 'mg/dl', kept: 1
        , store: { [name]: { dia: 3 }, Alt: { dia: 4 } } }).expect(200);
      const id = String(first.body[0]._id);
      await v1('post', '/profile/').send({ _id: id, defaultProfile: name, startDate, units: 'mmol', store: { [name]: { dia: 5 } } }).expect(200);
      const stored = await only('profile', 'defaultProfile', name);
      stored.store.should.eql({ [name]: { dia: 5 } });
      stored.units.should.equal('mmol');
      stored.kept.should.equal(1);
    });

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): a create
    // re-send by _id replaces, as on 15.0.9 (it merged: `kept` stayed).
    it('food: a create re-send by _id replaces; PUT replaces', async ( ) => {
      const name = tag();
      const first = await v1('post', '/food/').send({ type: 'food', name, carbs: 10, kept: 1 }).expect(200);
      const id = String(first.body[0]._id);
      await v1('post', '/food/').send({ _id: id, type: 'food', name, carbs: 11 }).expect(200);
      let stored = await only('food', 'name', name);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(11);
      // a field to show that PUT replaces too
      await v1('post', '/food/').send({ _id: id, type: 'food', name, carbs: 11, kept: 1 }).expect(200);
      await v1('put', '/food/').send({ _id: id, type: 'food', name, carbs: 12 }).expect(200);
      stored = await only('food', 'name', name);
      has(stored, 'kept').should.equal(false);
      stored.carbs.should.equal(12);
    });

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): an
    // in-process create re-send by _id replaces (it merged: `kept` stayed).
    it('activity: an in-process create re-send by _id replaces', async ( ) => {
      const name = tag();
      const create = (docs) => new Promise((resolve, reject) => self.instance.ctx.activity.create(docs
        , (err, result) => err ? reject(err) : resolve(result)));
      const first = await create([{ name, steps: 100, kept: 1, created_at: iso(Date.now()) }]);
      await create([{ _id: String(first[0]._id), name, steps: 150 }]);
      const stored = await only('activity', 'name', name);
      has(stored, 'kept').should.equal(false);
      stored.steps.should.equal(150);
    });

    it('entries merge by the same rule: kept, replaced, null removed', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 300000;
      await v1('post', '/entries/').send([{ type: 'sgv', sgv: 120, date, dateString: iso(date), device, identifier, kept: 1, gone: 'x' }]).expect(200);
      await v1('post', '/entries/').send([{ type: 'sgv', sgv: 121, date, dateString: iso(date), device, identifier, gone: null }]).expect(200);
      const stored = await only('entries', 'device', device);
      stored.kept.should.equal(1);
      stored.sgv.should.equal(121);
      has(stored, 'gone').should.equal(false);
    });
  });

  describe('the socket', function ( ) {

    // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): an exact
    // match replaces the stored profile, as on 15.0.9 (`kept` was merged in).
    it('profile dbAdd: an exact match replaces; the ack is the document as written', async ( ) => {
      const name = tag();
      const startDate = iso(Date.now() - 60000);
      const first = await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, units: 'mg/dl', kept: 1
        , store: { [name]: { dia: 3 }, Alt: { dia: 4 } } } });
      const ack = await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, units: 'mmol'
        , store: { [name]: { dia: 5 } } } });
      ack.length.should.equal(1);
      String(ack[0]._id).should.equal(String(first[0]._id));
      has(ack[0], 'kept').should.equal(false);
      ack[0].store.should.eql({ [name]: { dia: 5 } });
      const stored = await only('profile', 'defaultProfile', name);
      has(stored, 'kept').should.equal(false);
      stored.units.should.equal('mmol');
      stored.store.should.eql({ [name]: { dia: 5 } });
    });

    it('profile dbAdd on a soft-deleted profile still revives it (Q-R)', async ( ) => {
      const name = tag();
      const startDate = iso(Date.now() - 120000);
      await col('profile').insertOne({ defaultProfile: name, startDate, units: 'mg/dl', kept: 1, isValid: false
        , srvCreated: 1557000000000, srvModified: 1557000000000, store: { [name]: { dia: 3 } } });
      await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, units: 'mg/dl', store: { [name]: { dia: 4 } } } });
      const stored = await only('profile', 'defaultProfile', name);
      has(stored, 'isValid').should.equal(false);
      // CHANGED EXPECTATION (maintainer 2026-10-31, compat card B): revived by
      // a replace, so `kept` is gone (the merge kept it).
      has(stored, 'kept').should.equal(false);
      stored.store.should.eql({ [name]: { dia: 4 } });
    });
  });
});
