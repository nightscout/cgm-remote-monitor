'use strict';

// BF-122 (issue #8244): a record written through API v1, the v1 websocket or
// a writer inside the server (nightscout-connect) appears in API v3 history
// (GET /api/v3/<collection>/history/<ms>), which selects on the stored
// srvModified. A client that syncs by history, such as AndroidAPS
// NSClientV3, otherwise never receives it. A v1 PUT that replaces a v3 record
// keeps that record's identifier and srvCreated.
//
// Synthetic values only.

require('should');
const ObjectId = require('mongodb').ObjectId;

describe('BF-122: API v1 and websocket writes appear in API v3 history', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'bf122-' + Date.now()
    ;

  self.timeout(30000);

  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const tag = (s) => TAG + '-' + s;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function v1 (method, url) {
    return self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  }

  async function history (name, since, limit) {
    const res = await self.instance.get(`/api/v3/${name}/history/${since}?limit=${limit || 1000}`, self.jwt.all)
      .expect(200);
    return { docs: res.body.result, etag: res.headers.etag };
  }

  async function inHistory (name, since, match) {
    const h = await history(name, since);
    return h.docs.filter(match);
  }

  function emit (event, data) {
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        resolve(reply);
      });
    });
  }

  async function mark () {
    await sleep(5);
    const t = Date.now();
    await sleep(5);
    return t;
  }

  before(async () => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;

    self.socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      self.socket.on('connect', function () {
        self.socket.emit('authorize', { client: 'test', secret: HASH }, function (auth) {
          if (!auth || !auth.write || !auth.write_treatment) return reject(new Error('socket not authorized to write'));
          resolve();
        });
      });
      self.socket.on('connect_error', reject);
    });
  });

  after(async () => {
    if (self.socket) self.socket.close();
    await Promise.all(['treatments', 'entries', 'devicestatus', 'profile', 'food'].map((name) =>
      col(name).deleteMany({ $or: [
        { notes: { $regex: '^' + TAG } }, { device: { $regex: '^' + TAG } },
        { name: { $regex: '^' + TAG } }, { defaultProfile: { $regex: '^' + TAG } }
      ] })));
    self.instance.ctx.bus.teardown();
  });

  it('a v1 POST of a treatment, an entry and a device status appears in history', async () => {
    const t0 = await mark();
    const now = Date.now();
    await v1('post', '/treatments/').send({ eventType: 'Carb Correction', created_at: new Date(now).toISOString(), carbs: 11, notes: tag('t-post') }).expect(200);
    await v1('post', '/entries/').send([{ type: 'sgv', sgv: 111, date: now, dateString: new Date(now).toISOString(), device: tag('e-post') }]).expect(200);
    await v1('post', '/devicestatus/').send({ created_at: new Date(now).toISOString(), device: tag('d-post'), uploaderBattery: 50 }).expect(200);

    (await inHistory('treatments', t0, (d) => d.notes === tag('t-post'))).length.should.equal(1);
    (await inHistory('entries', t0, (d) => d.device === tag('e-post'))).length.should.equal(1);
    (await inHistory('devicestatus', t0, (d) => d.device === tag('d-post'))).length.should.equal(1);

    for (const [name, query] of [['treatments', { notes: tag('t-post') }], ['entries', { device: tag('e-post') }], ['devicestatus', { device: tag('d-post') }]]) {
      const stored = await col(name).findOne(query);
      stored.srvModified.should.be.a.Number();
      stored.srvModified.should.be.above(t0);
      stored.srvCreated.should.equal(stored.srvModified);
    }
  });

  it('a v1 POST of a profile and a food appears in history', async () => {
    const t0 = await mark();
    await v1('post', '/profile/').send({ defaultProfile: tag('p-post'), startDate: new Date().toISOString(), store: { [tag('p-post')]: { dia: 3, sens: [{ time: '00:00', value: 50 }] } } }).expect(200);
    await v1('post', '/food/').send({ type: 'food', category: 'bf122', name: tag('f-post'), carbs: 10 }).expect(200);
    (await inHistory('profile', t0, (d) => d.defaultProfile === tag('p-post'))).length.should.equal(1);
    (await inHistory('food', t0, (d) => d.name === tag('f-post'))).length.should.equal(1);
  });

  it('an in-process write (as nightscout-connect makes) appears in history', async () => {
    const t0 = await mark();
    const now = Date.now();
    await self.instance.ctx.entries.create([{ type: 'sgv', sgv: 120, date: now, dateString: new Date(now).toISOString(), device: tag('e-internal') }]);
    await new Promise((resolve, reject) => self.instance.ctx.treatments.create({ eventType: 'Note', created_at: new Date(now).toISOString(), notes: tag('t-internal') }, (err) => err ? reject(err) : resolve()));
    (await inHistory('entries', t0, (d) => d.device === tag('e-internal'))).length.should.equal(1);
    (await inHistory('treatments', t0, (d) => d.notes === tag('t-internal'))).length.should.equal(1);
  });

  it('a v1 PUT of a v3 record by _id keeps its identifier and srvCreated, and the change appears in history', async () => {
    const created = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Note', date: Date.now(), utcOffset: 0, app: 'bf122', device: 'bf122', notes: tag('t-put') })
      .expect(201);
    const identifier = created.body.identifier;
    const before = await col('treatments').findOne({ identifier });
    const t1 = await mark();

    // What a v1 client that does not know v3 fields sends back: _id and its own fields.
    await v1('put', '/treatments/').send({ _id: String(before._id), eventType: 'Note', created_at: before.created_at, notes: tag('t-put') + ' changed' }).expect(200);

    const after = await col('treatments').findOne({ _id: before._id });
    after.notes.should.equal(tag('t-put') + ' changed');
    after.identifier.should.equal(identifier);
    after.srvCreated.should.equal(before.srvCreated);
    after.srvModified.should.be.above(before.srvModified);
    const seen = await inHistory('treatments', t1, (d) => d.identifier === identifier);
    seen.length.should.equal(1);
    seen[0].notes.should.equal(tag('t-put') + ' changed');
  });

  it('a v1 PUT that sends the v3 record back with its identifier keeps srvCreated and ignores the srvModified it sends', async () => {
    const created = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Note', date: Date.now(), utcOffset: 0, app: 'bf122', device: 'bf122', notes: tag('t-put2') })
      .expect(201);
    const identifier = created.body.identifier;
    const before = await col('treatments').findOne({ identifier });
    const t1 = await mark();
    const body = Object.assign({}, before, { _id: String(before._id), notes: tag('t-put2') + ' changed', srvModified: 1, srvCreated: 2 });
    await v1('put', '/treatments/').send(body).expect(200);

    const after = await col('treatments').findOne({ identifier });
    after.srvCreated.should.equal(before.srvCreated);
    after.srvModified.should.be.above(t1);
    (await inHistory('treatments', t1, (d) => d.identifier === identifier)).length.should.equal(1);
  });

  it('a v1 PUT of a food and a profile keeps srvCreated and appears in history', async () => {
    await v1('post', '/food/').send({ type: 'food', category: 'bf122', name: tag('f-put'), carbs: 10 }).expect(200);
    const food = await col('food').findOne({ name: tag('f-put') });
    await v1('post', '/profile/').send({ defaultProfile: tag('p-put'), startDate: new Date().toISOString(), store: {} }).expect(200);
    const profile = await col('profile').findOne({ defaultProfile: tag('p-put') });
    const t1 = await mark();

    await v1('put', '/food/').send({ _id: String(food._id), type: 'food', category: 'bf122', name: tag('f-put'), carbs: 12 }).expect(200);
    await v1('put', '/profile/').send({ _id: String(profile._id), defaultProfile: tag('p-put'), startDate: profile.startDate, created_at: profile.created_at, store: { a: {} } }).expect(200);

    const food2 = await col('food').findOne({ _id: food._id });
    food2.srvCreated.should.equal(food.srvCreated);
    food2.srvModified.should.be.above(t1);
    const profile2 = await col('profile').findOne({ _id: profile._id });
    profile2.srvCreated.should.equal(profile.srvCreated);
    profile2.srvModified.should.be.above(t1);
    (await inHistory('food', t1, (d) => d.name === tag('f-put'))).length.should.equal(1);
    (await inHistory('profile', t1, (d) => d.defaultProfile === tag('p-put'))).length.should.equal(1);
  });

  it('a v1 entry sent again for the same reading keeps srvCreated and moves srvModified', async () => {
    const now = Date.now() - 60000;
    const reading = () => [{ type: 'sgv', sgv: 130, date: now, dateString: new Date(now).toISOString(), device: tag('e-again') }];
    await v1('post', '/entries/').send(reading()).expect(200);
    const first = await col('entries').findOne({ device: tag('e-again') });
    const t1 = await mark();
    await v1('post', '/entries/').send(reading()).expect(200);
    const again = await col('entries').find({ device: tag('e-again') }).toArray();
    again.length.should.equal(1);
    again[0].srvCreated.should.equal(first.srvCreated);
    again[0].srvModified.should.be.above(t1);
  });

  it('websocket dbAdd, dbUpdate and dbUpdateUnset appear in history; srvCreated is kept', async () => {
    const t0 = await mark();
    const added = await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Note', created_at: new Date(Date.now() - 600000).toISOString(), notes: tag('ws'), extra: 1 } });
    const id = String(added[0]._id);
    const stored = await col('treatments').findOne({ _id: new ObjectId(id) });
    stored.srvCreated.should.equal(stored.srvModified);
    (await inHistory('treatments', t0, (d) => d.notes === tag('ws'))).length.should.equal(1);

    const t1 = await mark();
    await emit('dbUpdate', { collection: 'treatments', _id: id, data: { notes: tag('ws') + ' changed', srvCreated: 5 } });
    const updated = await col('treatments').findOne({ _id: new ObjectId(id) });
    updated.srvCreated.should.equal(stored.srvCreated);
    updated.srvModified.should.be.above(t1);
    (await inHistory('treatments', t1, (d) => d.notes === tag('ws') + ' changed')).length.should.equal(1);

    const t2 = await mark();
    await emit('dbUpdateUnset', { collection: 'treatments', _id: id, data: { extra: 1, srvModified: 1 } });
    const unset = await col('treatments').findOne({ _id: new ObjectId(id) });
    unset.should.not.have.property('extra');
    unset.srvModified.should.be.above(t2);
    unset.srvCreated.should.equal(stored.srvCreated);
    (await inHistory('treatments', t2, (d) => d.notes === tag('ws') + ' changed')).length.should.equal(1);
  });

  it('a websocket dbUpdate to isValid false (AndroidAPS v1 delete) appears in history as deleted', async () => {
    const added = await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Carb Correction', created_at: new Date(Date.now() - 900000).toISOString(), carbs: 7, notes: tag('ws-del') } });
    const t1 = await mark();
    await emit('dbUpdate', { collection: 'treatments', _id: String(added[0]._id), data: { isValid: false } });
    const seen = await inHistory('treatments', t1, (d) => d.notes === tag('ws-del'));
    seen.length.should.equal(1);
    seen[0].isValid.should.equal(false);
  });

  it('websocket dbAdd of an entry, a device status and a profile appears in history', async () => {
    const t0 = await mark();
    await emit('dbAdd', { collection: 'entries', data: { type: 'sgv', sgv: 99, date: Date.now(), device: tag('ws-e') } });
    await emit('dbAdd', { collection: 'devicestatus', data: { created_at: new Date().toISOString(), device: tag('ws-d') } });
    await emit('dbAdd', { collection: 'profile', data: { defaultProfile: tag('ws-p'), startDate: new Date().toISOString(), store: {} } });
    (await inHistory('entries', t0, (d) => d.device === tag('ws-e'))).length.should.equal(1);
    (await inHistory('devicestatus', t0, (d) => d.device === tag('ws-d'))).length.should.equal(1);
    (await inHistory('profile', t0, (d) => d.defaultProfile === tag('ws-p'))).length.should.equal(1);
  });

  it('a v1 batch larger than a history page is read in full by paging on the cursor', async () => {
    const t0 = await mark();
    const base = Date.now() - 3600000;
    const batch = [];
    for (let i = 0; i < 25; i++) {
      batch.push({ type: 'sgv', sgv: 100 + i, date: base + i * 1000, dateString: new Date(base + i * 1000).toISOString(), device: tag('batch') });
    }
    await v1('post', '/entries/').send(batch).expect(200);

    const stored = await col('entries').find({ device: tag('batch') }).toArray();
    new Set(stored.map((d) => d.srvModified)).size.should.equal(25);

    // What AndroidAPS does: ask for a page, take the ETag (the largest srvModified) as the next cursor.
    const seen = new Set();
    let cursor = t0;
    for (let page = 0; page < 10; page++) {
      const h = await history('entries', cursor, 10);
      if (h.docs.length === 0) break;
      h.docs.forEach((d) => { if (d.device === tag('batch')) seen.add(d.sgv); });
      cursor = Number(/W\/"(\d+)"/.exec(h.etag)[1]);
    }
    seen.size.should.equal(25);
  });

  it('a v3 write made right after a large v1 batch sorts after every record of the batch', async () => {
    const base = Date.now() - 7200000;
    const batch = [];
    for (let i = 0; i < 1500; i++) {
      batch.push({ type: 'sgv', sgv: 100, date: base + i * 1000, dateString: new Date(base + i * 1000).toISOString(), device: tag('big') });
    }
    await v1('post', '/entries/').send(batch).expect(200);
    // A client that has read the whole batch holds its largest srvModified as its cursor.
    const [last] = await col('entries').find({ device: tag('big') }).sort({ srvModified: -1 }).limit(1).toArray();
    const created = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Note', date: Date.now(), utcOffset: 0, app: 'bf122', device: 'bf122', notes: tag('after-big') })
      .expect(201);
    const seen = await inHistory('treatments', last.srvModified, (d) => d.identifier === created.body.identifier);
    seen.length.should.equal(1);
  });

  it('srvDates.next never repeats a value and never goes backwards', () => {
    const srvDates = require('../lib/server/srv-dates');
    const values = [];
    for (let i = 0; i < 1000; i++) values.push(srvDates.next());
    for (let i = 1; i < values.length; i++) values[i].should.be.above(values[i - 1]);
  });

  // Kept by decision (maintainer, 2026-09-26; see the PR): v1 DELETE and websocket
  // dbRemove still remove the record outright, so history has nothing to report.
  // This pins that behaviour so a change to it is deliberate.
  it('a v1 DELETE still removes the record, and history does not report it (pinned: hard delete kept)', async () => {
    const created = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Note', date: Date.now(), utcOffset: 0, app: 'bf122', device: 'bf122', notes: tag('t-del') })
      .expect(201);
    const doc = await col('treatments').findOne({ identifier: created.body.identifier });
    const t1 = await mark();
    await v1('delete', '/treatments/' + String(doc._id)).expect(200);
    (await col('treatments').countDocuments({ _id: doc._id })).should.equal(0);
    (await inHistory('treatments', t1, (d) => d.notes === tag('t-del'))).length.should.equal(0);
  });

  it('control: a v3 DELETE appears in history as isValid false', async () => {
    const created = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Note', date: Date.now(), utcOffset: 0, app: 'bf122', device: 'bf122', notes: tag('t-v3del') })
      .expect(201);
    const t1 = await mark();
    await self.instance.delete('/api/v3/treatments/' + created.body.identifier, self.jwt.all).expect(200);
    const seen = await inHistory('treatments', t1, (d) => d.notes === tag('t-v3del'));
    seen.length.should.equal(1);
    seen[0].isValid.should.equal(false);
  });
});
