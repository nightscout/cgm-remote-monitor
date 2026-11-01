'use strict';

// ID-FIRST-MATCH slice 3, "stays deleted" (on-deleted in
// lib/storage/write-intent.js), as the maintainer decided it:
// - ID-Q4: a re-send (a create) that reaches a soft-deleted record
//   (isValid: false) by an identity (identifier, _id, NSCLIENT_ID,
//   syncIdentifier, id, uuid) is acknowledged: nothing is written, the reply
//   names the stored record, and the record stays deleted. One that reaches it
//   by a time key alone (a treatment's fallback key, an entry's sysTime +
//   type, API v3's fallback fields) stores a new record beside it.
// - ID-Q3: an edit of a soft-deleted record over API v1 (PUT), the socket
//   (dbUpdate, dbUpdateUnset) or in-process (save) is not applied. Under
//   WRITE_DELETED_EDIT=ignore (the default) it is answered as done; under
//   `refuse`, 410. API v3 PUT and PATCH answer 410 either way.
//
// Deleted records are seeded straight to MongoDB with a fixed, old
// srvModified, so "nothing written" is checked on the stored record itself.
// Synthetic values only.

require('should');
const assert = require('node:assert/strict');
const { ObjectId } = require('mongodb');
const writeIntent = require('../lib/storage/write-intent');
const writeSettings = require('../lib/server/write-settings');
const fallbackKey = require('../lib/server/treatment-fallback-key');

const OLD = 1557000000000;

describe('write(intent): on-deleted vocabulary (ID-FIRST-MATCH slice 3)', function ( ) {

  it('keyKind: identifier-match is an identifier key', function ( ) {
    assert.equal(writeIntent.keyKind({ identifier: { $eq: 'x' } }), 'identifier');
    assert.equal(writeIntent.keyKind({ $or: [{ identifier: { $eq: 'x' } }, { _id: { $eq: 'x' } }] }), 'identifier');
  });

  it('keyKind: _id, NSCLIENT_ID and a client identity in the fallback key are identity keys', function ( ) {
    assert.equal(writeIntent.keyKind({ _id: { $eq: new ObjectId() } }), 'identity');
    assert.equal(writeIntent.keyKind({ _id: new ObjectId() }), 'identity');
    assert.equal(writeIntent.keyKind({ NSCLIENT_ID: { $eq: '1' } }), 'identity');
    const doc = { created_at: '2019-05-11T07:40:00.000Z', eventType: 'Meal Bolus', syncIdentifier: 'loop-1' };
    assert.equal(writeIntent.keyKind(fallbackKey.fallbackQuery(doc, doc.created_at, { withAmounts: true })), 'identity');
  });

  it('keyKind: the fallback key without a client identity, sysTime + type and created_at are time keys', function ( ) {
    const doc = { created_at: '2019-05-11T07:40:00.000Z', eventType: 'Meal Bolus', carbs: 20 };
    assert.equal(writeIntent.keyKind(fallbackKey.fallbackQuery(doc, doc.created_at, { withAmounts: true })), 'time');
    assert.equal(writeIntent.keyKind({ sysTime: { $eq: 'x' }, type: { $eq: 'sgv' } }), 'time');
    assert.equal(writeIntent.keyKind({ created_at: { $eq: 'x' } }), 'time');
  });

  it('every rule that names on-deleted names an entry of ON_DELETED', function ( ) {
    const named = [ ];
    (function walk (value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.deleted === 'string') named.push(value.deleted);
      Object.keys(value).forEach(function (key) { walk(value[key]); });
    })(writeIntent.COLLECTION_RULES);
    assert(named.length > 0);
    named.forEach(function (name) { assert(Object.prototype.hasOwnProperty.call(writeIntent.ON_DELETED, name), name); });
  });

  it('the re-send and edit entries: identity keys stay deleted, a time key is hidden', function ( ) {
    // API v3's computed identifier is decided per collection (maintainer, 2026-10-30).
    assert.deepEqual(writeIntent.ON_DELETED['stays-deleted'], { identifier: 'acknowledged', identity: 'acknowledged', computed: 'by-collection', time: 'hidden' });
    assert.deepEqual(writeIntent.ON_DELETED['stays-deleted-edit'], { identifier: 'edit', identity: 'edit', computed: 'edit', time: 'hidden' });
  });

  it('API v3\'s computed identifier: an identity on every collection but treatments, which revive in 16.0.0', function ( ) {
    assert.deepEqual(writeIntent.V3_COMPUTED_IDENTIFIER, { treatments: 'revive', entries: 'acknowledged', profile: 'acknowledged'
      , food: 'acknowledged', settings: 'acknowledged', devicestatus: 'acknowledged' });
  });

  it('WRITE_DELETED_EDIT: ignore by default, refuse, case and space aside; anything else refuses to start', function ( ) {
    const parsed = values => writeSettings.parse((name, fallback) => Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback);
    assert.equal(parsed({ }).write.deletedEdit, 'ignore');
    assert.equal(parsed({ WRITE_DELETED_EDIT: 'refuse' }).write.deletedEdit, 'refuse');
    assert.equal(parsed({ WRITE_DELETED_EDIT: ' REFUSE ' }).write.deletedEdit, 'refuse');
    assert.deepEqual(parsed({ WRITE_DELETED_EDIT: 'refuse' }).errors, [ ]);
    const bad = parsed({ WRITE_DELETED_EDIT: 'restore' });
    assert.equal(bad.errors.length, 1);
    assert.match(bad.errors[0], /WRITE_DELETED_EDIT must be one of ignore, refuse/);
    assert.equal(writeSettings.deletedEditMode({ }), 'ignore');
  });
});

describe('ID-FIRST-MATCH slice 3: a deleted record stays deleted, on every path', function ( ) {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'ondel-' + Date.now()
    ;

  self.timeout(30000);

  let n = 0;
  const tag = ( ) => TAG + '-' + (++n);
  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const iso = (ms) => new Date(ms).toISOString();
  const v1 = (method, url) => self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  const uuid = ( ) => require('crypto').randomUUID();

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  // A record stored deleted, as API v3 DELETE or dbUpdate isValid: false leave it.
  async function seedDeleted (name, doc) {
    const copy = Object.assign({ srvCreated: OLD, srvModified: OLD, isValid: false }, doc);
    const result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  async function seedLive (name, doc) {
    const copy = Object.assign({ srvCreated: OLD, srvModified: OLD }, doc);
    const result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  // The record is exactly as seeded: not written, still deleted.
  async function shouldStayDeleted (name, seeded) {
    const now = await col(name).findOne({ _id: seeded._id });
    JSON.parse(JSON.stringify(now)).should.eql(JSON.parse(JSON.stringify(seeded)));
    now.isValid.should.equal(false);
  }

  const mine = (name, field, value) => col(name).find({ [field]: value }).toArray();
  const cached = (name, id) => (self.instance.ctx.cache.getData(name) || []).filter((d) => String(d._id) === String(id));

  function treatment (note, fields) {
    return Object.assign({ eventType: 'Carb Correction', created_at: iso(Date.now() - 600000), carbs: 20, notes: note, enteredBy: TAG }, fields);
  }

  function setDeletedEdit (mode) {
    self.instance.env.write = Object.freeze(Object.assign({ }, self.instance.env.write, { deletedEdit: mode }));
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

  afterEach(( ) => setDeletedEdit('ignore'));

  after(async ( ) => {
    if (self.socket) self.socket.close();
    await Promise.all(['treatments', 'entries', 'profile', 'food', 'activity'].map((name) =>
      col(name).deleteMany({ $or: [{ notes: { $regex: '^' + TAG } }, { device: { $regex: '^' + TAG } }
        , { name: { $regex: '^' + TAG } }, { defaultProfile: { $regex: '^' + TAG } }] })));
    self.instance.ctx.bus.teardown();
  });

  describe('a re-send that reaches a deleted record by an identity is acknowledged (ID-Q4)', function ( ) {

    it('API v1 treatments, by identifier: 200 with the stored _id, nothing written, not cached', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seedDeleted('treatments', treatment(note, { identifier }));
      const res = await v1('post', '/treatments/').send([treatment(note, { identifier, carbs: 30 })]).expect(200);
      String(res.body[0]._id).should.equal(String(seeded._id));
      await shouldStayDeleted('treatments', seeded);
      (await mine('treatments', 'notes', note)).length.should.equal(1);
      cached('treatments', seeded._id).length.should.equal(0);
    });

    it('API v1 treatments, a single document by _id', async ( ) => {
      const note = tag();
      const seeded = await seedDeleted('treatments', treatment(note));
      const res = await v1('post', '/treatments/').send(treatment(note, { _id: String(seeded._id), carbs: 30 })).expect(200);
      String(res.body[0]._id).should.equal(String(seeded._id));
      await shouldStayDeleted('treatments', seeded);
    });

    it('API v1 treatments, by a client identity in the fallback key (syncIdentifier)', async ( ) => {
      const note = tag();
      const seeded = await seedDeleted('treatments', treatment(note, { syncIdentifier: 'loop-' + note }));
      await v1('post', '/treatments/').send([treatment(note, { syncIdentifier: 'loop-' + note, created_at: seeded.created_at })]).expect(200);
      await shouldStayDeleted('treatments', seeded);
      (await mine('treatments', 'notes', note)).length.should.equal(1);
    });

    it('in-process treatments create: the callback names the stored _id', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seedDeleted('treatments', treatment(note, { identifier }));
      const docs = await new Promise((resolve, reject) => self.instance.ctx.treatments.create([treatment(note, { identifier })]
        , (err, result) => err ? reject(err) : resolve(result)));
      String(docs[0]._id).should.equal(String(seeded._id));
      await shouldStayDeleted('treatments', seeded);
    });

    it('a batch: the deleted item is acknowledged, the new one stored', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const seeded = await seedDeleted('treatments', treatment(note, { identifier }));
      const res = await v1('post', '/treatments/').send([treatment(note, { identifier })
        , treatment(note, { identifier: uuid(), carbs: 5 })]).expect(200);
      res.body.length.should.equal(2);
      String(res.body[0]._id).should.equal(String(seeded._id));
      await shouldStayDeleted('treatments', seeded);
      (await mine('treatments', 'notes', note)).length.should.equal(2);
    });

    it('API v1 entries, by identifier', async ( ) => {
      const device = tag();
      const identifier = uuid();
      const date = Date.now() - 300000;
      const seeded = await seedDeleted('entries', { type: 'sgv', sgv: 120, date, dateString: iso(date), sysTime: iso(date), device, identifier });
      const res = await v1('post', '/entries/').send([{ type: 'sgv', sgv: 121, date, dateString: iso(date), device, identifier }]).expect(200);
      String(res.body[0]._id).should.equal(String(seeded._id));
      await shouldStayDeleted('entries', seeded);
      (await mine('entries', 'device', device)).length.should.equal(1);
    });

    it('API v1 food, by _id', async ( ) => {
      const name = tag();
      const seeded = await seedDeleted('food', { type: 'food', name, carbs: 10, created_at: iso(Date.now()) });
      await v1('post', '/food/').send({ _id: String(seeded._id), type: 'food', name, carbs: 11 }).expect(200);
      await shouldStayDeleted('food', seeded);
    });

    it('API v1 profile, by _id', async ( ) => {
      const name = tag();
      const seeded = await seedDeleted('profile', { defaultProfile: name, startDate: iso(Date.now()), units: 'mg/dl', store: { [name]: { dia: 3 } } });
      await v1('post', '/profile/').send({ _id: String(seeded._id), defaultProfile: name, startDate: seeded.startDate, units: 'mmol', store: { [name]: { dia: 4 } } }).expect(200);
      await shouldStayDeleted('profile', seeded);
    });

    it('API v3 POST with the identifier: 200 deduplication reply, not revived, no history entry', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      const seeded = await seedDeleted('treatments', { identifier, eventType: 'Carb Correction', date, created_at: iso(date), utcOffset: 0, app: 'ondel', device: 'ondel', carbs: 20, notes: note });
      const res = await self.instance.post('/api/v3/treatments', self.jwt.all)
        .send({ identifier, eventType: 'Carb Correction', date, utcOffset: 0, app: 'ondel', device: 'ondel', carbs: 30, notes: note }).expect(200);
      res.body.should.eql({ status: 200, identifier, isDeduplication: true, lastModified: OLD });
      await shouldStayDeleted('treatments', seeded);
      const history = await self.instance.get('/api/v3/treatments/history/' + (OLD + 1) + '?limit=1000', self.jwt.all).expect(200);
      history.body.result.filter((d) => d.identifier === identifier).length.should.equal(0);
    });

    // Maintainer, 2026-10-30: on treatments a re-send matched by API v3's
    // computed identifier (device, date, eventType) keeps today's behaviour in
    // 16.0.0, the deduplicating replace, which revives the record
    // (V3_COMPUTED_IDENTIFIER.treatments: 'revive'; AndroidAPS stalls on a 410).
    it('API v3 POST without an identifier: matched by the computed identifier, held at today\'s revive', async ( ) => {
      const note = tag();
      const date = Date.now() - 600000;
      const body = { eventType: 'Carb Correction', date, utcOffset: 0, app: 'ondel', device: 'ondel-' + note, carbs: 20, notes: note };
      const first = await self.instance.post('/api/v3/treatments', self.jwt.all).send(body).expect(201);
      await self.instance.delete('/api/v3/treatments/' + first.body.identifier, self.jwt.all).expect(200);
      const deleted = await col('treatments').findOne({ identifier: first.body.identifier });
      deleted.isValid.should.equal(false);
      const again = await self.instance.post('/api/v3/treatments', self.jwt.all).send(Object.assign({ }, body, { carbs: 30 })).expect(200);
      again.body.isDeduplication.should.equal(true);
      const now = await col('treatments').findOne({ _id: deleted._id });
      (now.isValid === false).should.equal(false);
      now.carbs.should.equal(30);
    });

    it('API v3 POST of an entry without an identifier: the computed identifier is an identity, acknowledged', async ( ) => {
      const device = tag();
      const date = Date.now() - 300000;
      const body = { type: 'sgv', sgv: 120, date, utcOffset: 0, app: 'ondel', device };
      const first = await self.instance.post('/api/v3/entries', self.jwt.all).send(body).expect(201);
      await self.instance.delete('/api/v3/entries/' + first.body.identifier, self.jwt.all).expect(200);
      const deleted = await col('entries').findOne({ identifier: first.body.identifier });
      deleted.isValid.should.equal(false);
      const again = await self.instance.post('/api/v3/entries', self.jwt.all).send(Object.assign({ }, body, { sgv: 121 })).expect(200);
      again.body.isDeduplication.should.equal(true);
      again.body.identifier.should.equal(first.body.identifier);
      await shouldStayDeleted('entries', deleted);
    });

    it('API v3 POST with an identifier that equals the computed one is the client\'s: acknowledged', async ( ) => {
      const note = tag();
      const date = Date.now() - 600000;
      const body = { eventType: 'Carb Correction', date, utcOffset: 0, app: 'ondel', device: 'ondel-' + note, carbs: 20, notes: note };
      const first = await self.instance.post('/api/v3/treatments', self.jwt.all).send(body).expect(201);
      await self.instance.delete('/api/v3/treatments/' + first.body.identifier, self.jwt.all).expect(200);
      const deleted = await col('treatments').findOne({ identifier: first.body.identifier });
      await self.instance.post('/api/v3/treatments', self.jwt.all)
        .send(Object.assign({ }, body, { identifier: first.body.identifier, carbs: 30 })).expect(200);
      await shouldStayDeleted('treatments', deleted);
    });

    it('API v3 PUT and PATCH of a deleted record keep their 410', async ( ) => {
      const note = tag();
      const identifier = uuid();
      const date = Date.now() - 600000;
      const seeded = await seedDeleted('treatments', { identifier, eventType: 'Note', date, created_at: iso(date), utcOffset: 0, app: 'ondel', device: 'ondel', notes: note });
      await self.instance.put('/api/v3/treatments/' + identifier, self.jwt.all)
        .send({ identifier, eventType: 'Note', date, utcOffset: 0, app: 'ondel', device: 'ondel', notes: note + 'x' }).expect(410);
      await self.instance.patch('/api/v3/treatments/' + identifier, self.jwt.all).send({ notes: note + 'x' }).expect(410);
      await shouldStayDeleted('treatments', seeded);
    });
  });

  describe('a re-send that reaches a deleted record by a time key alone stores a new record (ID-Q4)', function ( ) {

    it('API v1 treatments by the fallback key: a new record beside the deleted one', async ( ) => {
      const note = tag();
      const seeded = await seedDeleted('treatments', treatment(note));
      const res = await v1('post', '/treatments/').send([treatment(note, { created_at: seeded.created_at })]).expect(200);
      String(res.body[0]._id).should.not.equal(String(seeded._id));
      await shouldStayDeleted('treatments', seeded);
      (await mine('treatments', 'notes', note)).length.should.equal(2);
    });

    it('API v1 entries by sysTime + type: a new reading beside the deleted one', async ( ) => {
      const device = tag();
      const date = Date.now() - 300000;
      const seeded = await seedDeleted('entries', { type: 'sgv', sgv: 120, date, dateString: iso(date), sysTime: iso(date), device });
      await v1('post', '/entries/').send([{ type: 'sgv', sgv: 120, date, dateString: iso(date), device }]).expect(200);
      await shouldStayDeleted('entries', seeded);
      (await mine('entries', 'device', device)).length.should.equal(2);
    });
  });

  describe('an edit of a deleted record is not applied (ID-Q3)', function ( ) {

    for (const mode of ['ignore', 'refuse']) {
      const status = mode === 'ignore' ? 200 : 410;

      it(`WRITE_DELETED_EDIT=${mode}: API v1 PUT treatments answers ${status}`, async ( ) => {
        setDeletedEdit(mode);
        const note = tag();
        const seeded = await seedDeleted('treatments', treatment(note));
        await v1('put', '/treatments/').send(Object.assign({ }, treatment(note), { _id: String(seeded._id), carbs: 99 })).expect(status);
        await shouldStayDeleted('treatments', seeded);
      });

      it(`WRITE_DELETED_EDIT=${mode}: API v1 PUT profile, food and activity answer ${status}`, async ( ) => {
        setDeletedEdit(mode);
        const name = tag();
        const profile = await seedDeleted('profile', { defaultProfile: name, startDate: iso(Date.now()), units: 'mg/dl', store: { } });
        await v1('put', '/profile/').send({ _id: String(profile._id), defaultProfile: name, startDate: profile.startDate, units: 'mmol', store: { } }).expect(status);
        await shouldStayDeleted('profile', profile);
        const food = await seedDeleted('food', { type: 'food', name, carbs: 10, created_at: iso(Date.now()) });
        await v1('put', '/food/').send({ _id: String(food._id), type: 'food', name, carbs: 11 }).expect(status);
        await shouldStayDeleted('food', food);
        const activity = await seedDeleted('activity', { created_at: iso(Date.now()), steps: 10, notes: name });
        await v1('put', '/activity/').send({ _id: String(activity._id), created_at: activity.created_at, steps: 11, notes: name }).expect(status);
        await shouldStayDeleted('activity', activity);
      });

      it(`WRITE_DELETED_EDIT=${mode}: socket dbUpdate and dbUpdateUnset`, async ( ) => {
        setDeletedEdit(mode);
        const note = tag();
        const seeded = await seedDeleted('treatments', treatment(note, { foodType: 'x' }));
        const update = await emit('dbUpdate', { collection: 'treatments', _id: String(seeded._id), data: { carbs: 99 } });
        const unset = await emit('dbUpdateUnset', { collection: 'treatments', _id: String(seeded._id), data: { foodType: 1 } });
        if (mode === 'ignore') {
          update.should.eql({ result: 'success' });
          unset.should.eql({ result: 'success' });
        } else {
          update.length.should.equal(1);
          update[0].refused.status.should.equal(410);
          update[0].refused.message.should.equal(writeIntent.DELETED_RECORD_MESSAGE);
          unset[0].refused.status.should.equal(410);
        }
        await shouldStayDeleted('treatments', seeded);
      });

      it(`WRITE_DELETED_EDIT=${mode}: in-process save`, async ( ) => {
        setDeletedEdit(mode);
        const note = tag();
        const seeded = await seedDeleted('treatments', treatment(note));
        const err = await new Promise((resolve) => self.instance.ctx.treatments.save(
          Object.assign({ }, treatment(note), { _id: String(seeded._id), carbs: 99 }), (e) => resolve(e)));
        if (mode === 'ignore') assert.equal(err, null);
        else assert(writeIntent.isDeletedRecord(err), String(err));
        await shouldStayDeleted('treatments', seeded);
      });
    }

    it('WRITE_DELETED_EDIT=refuse: an edit of a live record is applied', async ( ) => {
      setDeletedEdit('refuse');
      const note = tag();
      const live = await seedLive('treatments', treatment(note));
      await v1('put', '/treatments/').send(Object.assign({ }, treatment(note), { _id: String(live._id), carbs: 99 })).expect(200);
      (await col('treatments').findOne({ _id: live._id })).carbs.should.equal(99);
      const update = await emit('dbUpdate', { collection: 'treatments', _id: String(live._id), data: { carbs: 98 } });
      update.should.eql({ result: 'success' });
      (await col('treatments').findOne({ _id: live._id })).carbs.should.equal(98);
    });
  });
});
