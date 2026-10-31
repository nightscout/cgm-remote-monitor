'use strict';

// Compat card B (`c1-replace`, maintainer 2026-10-31): a matched re-send
// REPLACES the stored record, as on 15.0.9 and as slice 4 already decided for
// treatments. It reverses slice 4's merge on match (ID-Q8; ID-Q2 for device
// status; ID-Q7's `store` taken whole is moot under a replace) on the paths
// where 15.0.9 replaced:
// - API v3 POST of entries, profile, food, device status and settings that
//   matches a stored record (by identifier, sent or computed, or the fallback
//   fields);
// - the socket's profile dbAdd (an exact match on NSCLIENT_ID or startDate,
//   and the identifier-first match at the same startDate);
// - an API v1 or in-process food or activity create that names a stored
//   record by its _id.
// A field the re-send leaves out is gone, srvModified advances where the
// collection has server dates, and there is still one record. Merge stays
// where a client asks for it: API v3 PATCH and the socket's dbUpdate.
//
// Outside the card's measured scope (write-contract matrix group c1, 136
// cells) the rules are as they were, and the last block pins them so that this
// change cannot reach them: an identifier-first match on API v1, in-process or
// socket creates (new in 16.0.0; 15.0.9 stored a second record there) merges,
// and API v1 entries merge, as on 15.0.9.
// Synthetic values only.

require('should');
const assert = require('node:assert/strict');
const writeIntent = require('../lib/storage/write-intent');

describe('compat card B: the rule table (maintainer 2026-10-31)', function ( ) {

  it('API v3 POST replaces a matched record on every collection', function ( ) {
    const rules = writeIntent.COLLECTION_RULES;
    ['treatments', 'entries', 'devicestatus', 'profile', 'food', 'settings'].forEach(function (name) {
      assert.equal(rules[name].v3.create.onMatch, 'replaced', name);
      assert.equal(rules[name].v3.patch.write, 'v3-merge', name);
    });
  });

  it('the socket\'s profile dbAdd replaces on an exact and an identifier match', function ( ) {
    const rule = writeIntent.COLLECTION_RULES.profile.socket.create;
    assert.equal(rule.onExact, 'replaced');
    assert.equal(rule.onIdentifier, 'replaced');
  });

  it('a v1 or in-process food or activity create by a stored _id replaces; an identifier-first match still merges', function ( ) {
    ['food', 'activity'].forEach(function (name) {
      const rule = writeIntent.COLLECTION_RULES[name]['v1/internal'].create;
      assert.equal(rule.onMatch, 'replaced', name);
      assert.equal(rule.onIdentifierMatch, 'merged', name);
    });
  });
});

describe('compat card B: a matched re-send replaces (maintainer 2026-10-31)', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'replace-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const v1 = (method, url) => self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  const v3 = (method, url) => self.instance[method]('/api/v3' + url, self.jwt.all);
  const uuid = ( ) => require('crypto').randomUUID();
  const has = (doc, field) => Object.prototype.hasOwnProperty.call(doc, field);
  const later = ( ) => new Promise((resolve) => setTimeout(resolve, 5));

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  async function only (name, field, value) {
    const docs = await col(name).find({ [field]: value }).toArray();
    docs.length.should.equal(1);
    return docs[0];
  }

  // The re-send replaced the record: the field it left out is gone, one
  // record, and srvModified moved past what the seed stored.
  function replaced (before, after, field) {
    assert.equal(has(after, field), false, field + ' is gone');
    String(after._id).should.equal(String(before._id));
    if (has(before, 'srvModified')) {
      after.srvModified.should.be.above(before.srvModified);
      after.srvCreated.should.equal(before.srvCreated);
    }
  }

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
    await Promise.all(['entries', 'devicestatus', 'profile', 'food', 'activity', 'settings'].map((name) =>
      col(name).deleteMany({ $or: [{ device: { $regex: '^' + TAG } }, { name: { $regex: '^' + TAG } }
        , { defaultProfile: { $regex: '^' + TAG } }, { app: TAG }] })));
    self.instance.ctx.bus.teardown();
  });

  describe('API v3 POST', function ( ) {

    // One date per test: a re-send keeps the seed's date (API v3 refuses a
    // changed date with 400).
    let date;
    beforeEach(function ( ) { date = Date.now() - 600000; });
    function v3doc (fields) {
      return Object.assign({ date, utcOffset: 0, app: TAG }, fields);
    }

    it('entries: a re-send by identifier that leaves out a field replaces', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const doc = (fields) => v3doc(Object.assign({ type: 'sgv', sgv: 120, device, identifier }, fields));
      await v3('post', '/entries').send(doc({ kept: 1 })).expect(201);
      const before = await only('entries', 'device', device);
      await later();
      const res = await v3('post', '/entries').send(doc({ sgv: 130 })).expect(200);
      res.body.isDeduplication.should.equal(true);
      const after = await only('entries', 'device', device);
      replaced(before, after, 'kept');
      after.sgv.should.equal(130);
      res.body.lastModified.should.equal(after.srvModified);
    });

    it('food: a re-send by identifier that leaves out a field replaces', async ( ) => {
      const name = tag();
      const identifier = uuid();
      const doc = (fields) => v3doc(Object.assign({ type: 'food', name, carbs: 10, identifier, device: name }, fields));
      await v3('post', '/food').send(doc({ kept: 1 })).expect(201);
      const before = await only('food', 'name', name);
      await later();
      await v3('post', '/food').send(doc({ carbs: 11 })).expect(200);
      const after = await only('food', 'name', name);
      replaced(before, after, 'kept');
      after.carbs.should.equal(11);
    });

    it('settings: a re-send by identifier that leaves out a field replaces', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const doc = (fields) => v3doc(Object.assign({ device, identifier, value: 1 }, fields));
      await v3('post', '/settings').send(doc({ kept: 1 })).expect(201);
      const before = await only('settings', 'device', device);
      await later();
      await v3('post', '/settings').send(doc({ value: 2 })).expect(200);
      const after = await only('settings', 'device', device);
      replaced(before, after, 'kept');
      after.value.should.equal(2);
    });

    it('devicestatus: a re-send by identifier that leaves out a field replaces (ID-Q2\'s merge reversed)', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const doc = (fields) => v3doc(Object.assign({ device, identifier, uploaderBattery: 50 }, fields));
      await v3('post', '/devicestatus').send(doc({ kept: 1 })).expect(201);
      const before = await only('devicestatus', 'device', device);
      await later();
      const res = await v3('post', '/devicestatus').send(doc({ uploaderBattery: 60 })).expect(200);
      res.body.isDeduplication.should.equal(true);
      const after = await only('devicestatus', 'device', device);
      replaced(before, after, 'kept');
      after.uploaderBattery.should.equal(60);
    });

    it('profile: a re-send replaces the whole record, `store` included (ID-Q7 is moot)', async ( ) => {
      const name = tag();
      const identifier = uuid();
      const doc = (fields) => v3doc(Object.assign({ identifier, device: name, defaultProfile: name, units: 'mg/dl' }, fields));
      await v3('post', '/profile').send(doc({ kept: 1, store: { [name]: { dia: 3 }, Alt: { dia: 4 } } })).expect(201);
      const before = await only('profile', 'defaultProfile', name);
      await later();
      await v3('post', '/profile').send(doc({ store: { [name]: { dia: 5 } } })).expect(200);
      const after = await only('profile', 'defaultProfile', name);
      replaced(before, after, 'kept');
      after.store.should.eql({ [name]: { dia: 5 } });
    });

    it('PATCH still merges (entries, profile, devicestatus)', async ( ) => {
      for (const name of ['entries', 'profile', 'devicestatus']) {
        const device = tag();
        const identifier = uuid();
        const base = { entries: { type: 'sgv', sgv: 120 }, profile: { defaultProfile: device, store: { a: { dia: 3 } } }
          , devicestatus: { uploaderBattery: 50 } }[name];
        await v3('post', '/' + name).send(v3doc(Object.assign({ device, identifier, kept: 1 }, base))).expect(201);
        await v3('patch', '/' + name + '/' + identifier).send({ other: 2 }).expect(200);
        const after = await only(name, 'device', device);
        assert.equal(after.kept, 1, name + ' kept by PATCH');
        assert.equal(after.other, 2, name);
      }
    });
  });

  describe('the socket', function ( ) {

    it('profile dbAdd: an exact match on startDate replaces, `store` whole; srvModified advances', async ( ) => {
      const name = tag();
      const startDate = iso(Date.now() - 60000);
      const first = await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, units: 'mg/dl', kept: 1
        , store: { [name]: { dia: 3 }, Alt: { dia: 4 } } } });
      const before = await only('profile', 'defaultProfile', name);
      await later();
      const ack = await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, units: 'mmol'
        , store: { [name]: { dia: 5 } } } });
      ack.length.should.equal(1);
      String(ack[0]._id).should.equal(String(first[0]._id));
      const after = await only('profile', 'defaultProfile', name);
      replaced(before, after, 'kept');
      after.units.should.equal('mmol');
      after.store.should.eql({ [name]: { dia: 5 } });
    });

    it('profile dbAdd: an identifier match at the same startDate replaces', async ( ) => {
      const name = tag();
      const identifier = uuid();
      const startDate = iso(Date.now() - 90000);
      await emit('dbAdd', { collection: 'profile', data: { identifier, defaultProfile: name, startDate, units: 'mg/dl', kept: 1
        , store: { [name]: { dia: 3 } } } });
      const before = await only('profile', 'defaultProfile', name);
      await later();
      await emit('dbAdd', { collection: 'profile', data: { identifier, defaultProfile: name, startDate, units: 'mmol'
        , store: { [name]: { dia: 6 } } } });
      const after = await only('profile', 'defaultProfile', name);
      replaced(before, after, 'kept');
      after.identifier.should.equal(identifier);
      after.store.should.eql({ [name]: { dia: 6 } });
    });

    it('dbUpdate still merges (profile, food)', async ( ) => {
      const name = tag();
      const startDate = iso(Date.now() - 30000);
      const profile = await emit('dbAdd', { collection: 'profile', data: { defaultProfile: name, startDate, kept: 1, store: { a: { dia: 3 } } } });
      await emit('dbUpdate', { collection: 'profile', _id: String(profile[0]._id), data: { units: 'mmol' } });
      const storedProfile = await only('profile', 'defaultProfile', name);
      storedProfile.kept.should.equal(1);
      storedProfile.units.should.equal('mmol');
      const food = await emit('dbAdd', { collection: 'food', data: { type: 'food', name, carbs: 10, kept: 1 } });
      await emit('dbUpdate', { collection: 'food', _id: String(food[0]._id), data: { carbs: 12 } });
      const storedFood = await only('food', 'name', name);
      storedFood.kept.should.equal(1);
      storedFood.carbs.should.equal(12);
    });
  });

  describe('API v1 and in-process food and activity by a stored _id', function ( ) {

    const create = (name, docs) => new Promise((resolve, reject) => self.instance.ctx[name].create(docs
      , (err, result) => err ? reject(err) : resolve(result)));

    it('food: an in-process create re-send by _id replaces', async ( ) => {
      const name = tag();
      const first = await create('food', [{ type: 'food', name, carbs: 10, kept: 1 }]);
      const before = await only('food', 'name', name);
      await later();
      const again = await create('food', [{ _id: String(first[0]._id), type: 'food', name, carbs: 11 }]);
      String(again[0]._id).should.equal(String(first[0]._id));
      const after = await only('food', 'name', name);
      replaced(before, after, 'kept');
      after.carbs.should.equal(11);
    });

    it('food: an API v1 POST re-send by _id replaces, as 15.0.9 did', async ( ) => {
      const name = tag();
      const first = await v1('post', '/food/').send({ type: 'food', name, carbs: 10, kept: 1 }).expect(200);
      const before = await only('food', 'name', name);
      await later();
      await v1('post', '/food/').send({ _id: String(first.body[0]._id), type: 'food', name, carbs: 11 }).expect(200);
      const after = await only('food', 'name', name);
      replaced(before, after, 'kept');
    });

    it('activity: an in-process create re-send by a UUID _id replaces (no server dates)', async ( ) => {
      const name = tag();
      const id = uuid();
      await create('activity', [{ _id: id, name, steps: 100, kept: 1, created_at: iso(Date.now()) }]);
      const before = await only('activity', 'name', name);
      await create('activity', [{ _id: id, name, steps: 150 }]);
      const after = await only('activity', 'name', name);
      replaced(before, after, 'kept');
      after.steps.should.equal(150);
    });

    it('the step answers `replaced` for a re-send by _id, `merged` for an identifier-first match', async ( ) => {
      const name = tag();
      const identifier = uuid();
      const store = ( ) => require('../lib/server/storage-reads').collection(self.instance.ctx, self.instance.env
        , self.instance.env.food_collection || 'food', 'food');
      const step = writeIntent.forCollection(store, 'food', 'v1/internal', { env: self.instance.env });
      const first = await step.write({ op: 'create', docs: [{ type: 'food', name, carbs: 1, identifier, kept: 1 }] });
      first.items[0].outcome.should.equal('inserted');
      const byId = await step.write({ op: 'create', docs: [{ _id: String(first.items[0]._id), type: 'food', name, carbs: 2, identifier }] });
      byId.items[0].outcome.should.equal('replaced');
      const byIdentifier = await step.write({ op: 'create', docs: [{ type: 'food', name, carbs: 3, identifier, kept: 2 }] });
      byIdentifier.items[0].outcome.should.equal('merged');
    });
  });

  // Outside card B's measured scope: these keep #8879's rule. 15.0.9 stored a
  // second record on an identifier re-send over these paths, so there is no
  // 15.0.9 replace to restore; API v1 entries merged on 15.0.9.
  describe('unchanged by card B: identifier-first creates over API v1, in-process and the socket, and v1 entries, merge', function ( ) {

    it('food and activity: an API v1 / in-process create matched by identifier merges', async ( ) => {
      const name = tag();
      const identifier = uuid();
      await v1('post', '/food/').send({ type: 'food', name, carbs: 10, identifier, kept: 1 }).expect(200);
      await v1('post', '/food/').send({ type: 'food', name, carbs: 11, identifier }).expect(200);
      const food = await only('food', 'name', name);
      food.kept.should.equal(1);
      food.carbs.should.equal(11);
      const activityName = tag();
      const activityId = uuid();
      const create = (docs) => new Promise((resolve, reject) => self.instance.ctx.activity.create(docs
        , (err, result) => err ? reject(err) : resolve(result)));
      await create([{ name: activityName, steps: 1, identifier: activityId, kept: 1, created_at: iso(Date.now()) }]);
      await create([{ name: activityName, steps: 2, identifier: activityId }]);
      const activity = await only('activity', 'name', activityName);
      activity.kept.should.equal(1);
      activity.steps.should.equal(2);
    });

    it('entries and food: a socket dbAdd matched by identifier merges', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 400000;
      await emit('dbAdd', { collection: 'entries', data: { type: 'sgv', sgv: 100, date, dateString: iso(date), device, identifier, kept: 1 } });
      await emit('dbAdd', { collection: 'entries', data: { type: 'sgv', sgv: 101, date, dateString: iso(date), device, identifier } });
      const entry = await only('entries', 'device', device);
      entry.kept.should.equal(1);
      entry.sgv.should.equal(101);
    });

    it('devicestatus: an API v1 re-send by identifier merges', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const created_at = iso(Date.now() - 300000);
      await v1('post', '/devicestatus/').send({ device, created_at, identifier, kept: 1, uploaderBattery: 50 }).expect(200);
      await v1('post', '/devicestatus/').send({ device, created_at, identifier, uploaderBattery: 60 }).expect(200);
      const stored = await only('devicestatus', 'device', device);
      stored.kept.should.equal(1);
      stored.uploaderBattery.should.equal(60);
    });

    it('entries: an API v1 re-send merges, as on 15.0.9', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 200000;
      await v1('post', '/entries/').send([{ type: 'sgv', sgv: 120, date, dateString: iso(date), device, identifier, kept: 1 }]).expect(200);
      await v1('post', '/entries/').send([{ type: 'sgv', sgv: 121, date, dateString: iso(date), device, identifier }]).expect(200);
      const stored = await only('entries', 'device', device);
      stored.kept.should.equal(1);
      stored.sgv.should.equal(121);
    });
  });
});
