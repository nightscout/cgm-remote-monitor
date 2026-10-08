'use strict';

// JL-1: a record stored with isValid false is deleted. API v3 DELETE marks a
// record that way, and AndroidAPS on the v1 websocket deletes with a dbUpdate
// that sets it. Such a record kept counting: v1 reads returned it, and the
// data the site computes COB and IOB from (the dataloader and its cache) kept
// it. It is now left out everywhere except v3 history, which is how a v3
// client learns of the delete.
//
// Synthetic values only; not medical advice.

require('should');
const ObjectId = require('mongodb').ObjectId;

describe('JL-1: a soft-deleted record (isValid false) stops counting', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , helper = require('./inithelper')()
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'jl1-' + Date.now()
    ;

  self.timeout(30000);

  const cob = require('../lib/plugins/cob')(helper.ctx);
  const iob = require('../lib/plugins/iob')(helper.ctx);
  const profile = require('../lib/profilefunctions')([{ dia: 3, sens: 95, carbratio: 18, carbs_hr: 30 }], helper.ctx);

  const col = (name) => self.instance.ctx.store.collection(self.instance.env[name + '_collection'] || name);
  const tag = (s) => TAG + '-' + s;

  function v1 (method, url) {
    return self.instance[method]('/api/v1' + url).set('api-secret', HASH);
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

  // What the site computes from: one dataloader pass, as a write triggers.
  function load () {
    return new Promise((resolve) => self.instance.ctx.dataloader.update(self.instance.ctx.ddata, resolve));
  }

  async function mine (note) {
    await load();
    return self.instance.ctx.ddata.treatments.filter((t) => t.notes === note);
  }

  async function cobFor (note) {
    const treatments = await mine(note);
    const result = cob.cobTotal(treatments, [], profile, Date.now() + 60000);
    return result.cob || 0;
  }

  async function iobFor (note) {
    const treatments = await mine(note);
    return iob.calcTotal(treatments, [], profile, Date.now() + 60000).iob || 0;
  }

  async function v1Treatments (note, extra) {
    const res = await v1('get', '/treatments.json?find[notes]=' + encodeURIComponent(note) + (extra || '')).expect(200);
    return res.body;
  }

  async function v3Carbs (grams, note) {
    const res = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Carb Correction', date: Date.now(), utcOffset: 0, app: 'AAPS', device: 'jl1', carbs: grams, notes: note, isValid: true })
      .expect(201);
    return res.body.identifier;
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

  it('AAPS v3: 40 g carbs count 40 g COB; after the v3 DELETE they count 0 and v1 reads leave them out', async () => {
    const note = tag('v3-carbs');
    const t0 = Date.now() - 1000;
    const identifier = await v3Carbs(40, note);
    (await cobFor(note)).should.equal(40);
    (await v1Treatments(note)).length.should.equal(1);

    await self.instance.delete('/api/v3/treatments/' + identifier, self.jwt.all).expect(200);

    (await cobFor(note)).should.equal(0);
    (await mine(note)).length.should.equal(0);
    (await v1Treatments(note)).length.should.equal(0);
    const count = await v1('get', '/count/treatments/where?find[notes]=' + encodeURIComponent(note)).expect(200);
    (count.body.length === 0 || count.body[0].count === 0).should.equal(true);

    // Still there for whoever asks for it, and for v3 history.
    const deleted = await v1Treatments(note, '&find[isValid]=false');
    deleted.length.should.equal(1);
    deleted[0].isValid.should.equal(false);
    const history = await self.instance.get('/api/v3/treatments/history/' + t0 + '?limit=1000', self.jwt.all).expect(200);
    history.body.result.filter((d) => d.identifier === identifier && d.isValid === false).length.should.equal(1);
    const search = await self.instance.get('/api/v3/treatments?limit=1000&identifier$eq=' + identifier, self.jwt.all).expect(200);
    search.body.result.length.should.equal(0);
  });

  it('AAPS v1: 40 g carbs by dbAdd count 40 g COB; after dbUpdate isValid false they count 0', async () => {
    const note = tag('v1-carbs');
    const added = await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Carb Correction', created_at: new Date(Date.now() - 300000).toISOString(), carbs: 40, isValid: true, notes: note } });
    (await cobFor(note)).should.equal(40);

    await emit('dbUpdate', { collection: 'treatments', _id: String(added[0]._id), data: { isValid: false } });

    (await cobFor(note)).should.equal(0);
    (await v1Treatments(note)).length.should.equal(0);
    self.instance.ctx.cache.getData('treatments').filter((t) => t.notes === note).length.should.equal(0);
  });

  it('control: the same carbs removed by a v1 DELETE count 0', async () => {
    const note = tag('hard-carbs');
    await v3Carbs(40, note);
    (await cobFor(note)).should.equal(40);
    const stored = await col('treatments').findOne({ notes: note });
    await v1('delete', '/treatments/' + String(stored._id)).expect(200);
    (await cobFor(note)).should.equal(0);
    (await v1Treatments(note)).length.should.equal(0);
  });

  it('control: carbs that are not deleted keep counting after another record is deleted', async () => {
    const kept = tag('kept-carbs');
    const gone = tag('gone-carbs');
    await v3Carbs(20, kept);
    const identifier = await v3Carbs(30, gone);
    await self.instance.delete('/api/v3/treatments/' + identifier, self.jwt.all).expect(200);
    (await cobFor(kept)).should.equal(20);
    (await v1Treatments(kept)).length.should.equal(1);
  });

  it('an insulin dose deleted through v3 stops counting in IOB', async () => {
    const note = tag('bolus');
    const res = await self.instance.post('/api/v3/treatments', self.jwt.all)
      .send({ eventType: 'Correction Bolus', date: Date.now(), utcOffset: 0, app: 'AAPS', device: 'jl1', insulin: 2, notes: note })
      .expect(201);
    (await iobFor(note)).should.be.above(1.5);
    await self.instance.delete('/api/v3/treatments/' + res.body.identifier, self.jwt.all).expect(200);
    (await iobFor(note)).should.equal(0);
  });

  it('a websocket dbAdd of the same treatment as a deleted one is stored, not answered with the deleted copy', async () => {
    const note = tag('re-add');
    const created_at = new Date(Date.now() - 1200000).toISOString();
    const first = await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Carb Correction', created_at, carbs: 15, notes: note } });
    await emit('dbUpdate', { collection: 'treatments', _id: String(first[0]._id), data: { isValid: false } });
    const second = await emit('dbAdd', { collection: 'treatments', data: { eventType: 'Carb Correction', created_at, carbs: 15, notes: note } });
    String(second[0]._id).should.not.equal(String(first[0]._id));
    (await v1Treatments(note)).length.should.equal(1);
  });

  it('a deleted profile is not the current profile', async () => {
    const older = tag('profile-older');
    const newer = tag('profile-newer');
    const t = Date.now();
    await v1('post', '/profile/').send({ defaultProfile: older, startDate: new Date(t - 86400000 * 400).toISOString(), store: { [older]: { dia: 3 } } }).expect(200);
    const res = await self.instance.post('/api/v3/profile', self.jwt.all)
      .send({ defaultProfile: newer, startDate: new Date(t + 86400000 * 400).toISOString(), date: t + 86400000 * 400, utcOffset: 0, app: 'AAPS', store: { [newer]: { dia: 4 } } })
      .expect(201);
    (await v1('get', '/profile/current').expect(200)).body.defaultProfile.should.equal(newer);

    await self.instance.delete('/api/v3/profile/' + res.body.identifier, self.jwt.all).expect(200);

    (await v1('get', '/profile/current').expect(200)).body.defaultProfile.should.not.equal(newer);
    (await v1('get', '/profile.json').expect(200)).body.filter((p) => p.defaultProfile === newer).length.should.equal(0);
  });

  describe('a profile search by date with a deleted profile of the same date', () => {
    // Profile date is typed as text on v1 find: find[date]=20210304 matches the
    // text date only, not a numeric one.
    const marker = tag('profile-date');
    const profiles = (query) => v1('get', '/profiles/').query(Object.assign({ 'find[defaultProfile]': marker }, query)).expect(200)
      .then((res) => res.body.map((p) => p.tag).sort());

    before(async () => {
      const startDate = new Date().toISOString();
      await col('profile').insertMany([
        { startDate, date: '20210304', defaultProfile: marker, tag: 'live', store: {} },
        { startDate, date: '20210304', defaultProfile: marker, tag: 'deleted', isValid: false, store: {} },
        { startDate, date: 1614816000000, defaultProfile: marker, tag: 'numeric', store: {} }
      ]);
    });

    it('find[date] returns the live profile and leaves out the deleted one', async () => {
      (await profiles({ 'find[date]': '20210304' })).should.eql(['live']);
    });

    it('find[date] with find[isValid]=false returns the deleted one only', async () => {
      (await profiles({ 'find[date]': '20210304', 'find[isValid]': 'false' })).should.eql(['deleted']);
    });

    it('find[date] as text does not match a numeric date', async () => {
      (await profiles({ 'find[date]': '1614816000000' })).should.eql([]);
    });

    it('control: with no date filter the two profiles that are not deleted come back', async () => {
      (await profiles({})).should.eql(['live', 'numeric']);
    });
  });

  it('a deleted glucose reading is left out of v1 reads; an uploader sending it again stores it again', async () => {
    const device = tag('entry');
    const date = Date.now() - 120000;
    const reading = [{ type: 'sgv', sgv: 150, date, dateString: new Date(date).toISOString(), device }];
    // Uploaded through v1 (as xDrip+ does); AndroidAPS deletes it through v3, by the id v3 lists it under.
    await v1('post', '/entries/').send(reading).expect(200);
    const stored = await col('entries').findOne({ device });
    await self.instance.delete('/api/v3/entries/' + String(stored._id), self.jwt.all).expect(200);
    (await col('entries').findOne({ _id: stored._id })).isValid.should.equal(false);
    (await v1('get', '/entries.json?find[device]=' + device).expect(200)).body.length.should.equal(0);
    self.instance.ctx.cache.getData('entries').filter((e) => e.device === device).length.should.equal(0);

    await v1('post', '/entries/').send([{ type: 'sgv', sgv: 150, date, dateString: new Date(date).toISOString(), device }]).expect(200);
    (await col('entries').countDocuments({ device })).should.equal(1);
    const back = (await v1('get', '/entries.json?find[device]=' + device).expect(200)).body;
    back.length.should.equal(1);
    back[0].should.not.have.property('isValid');
  });

  it('a deleted device status and a deleted food are left out of v1 reads', async () => {
    const device = tag('status');
    const status = await self.instance.post('/api/v3/devicestatus', self.jwt.all)
      .send({ date: Date.now(), utcOffset: 0, app: 'AAPS', device, uploaderBattery: 40 })
      .expect(201);
    const name = tag('food');
    const food = await self.instance.post('/api/v3/food', self.jwt.all)
      .send({ date: Date.now(), utcOffset: 0, app: 'AAPS', type: 'food', name, carbs: 10 })
      .expect(201);
    (await v1('get', '/devicestatus.json?find[device]=' + device).expect(200)).body.length.should.equal(1);
    (await v1('get', '/food.json').expect(200)).body.filter((f) => f.name === name).length.should.equal(1);

    await self.instance.delete('/api/v3/devicestatus/' + status.body.identifier, self.jwt.all).expect(200);
    await self.instance.delete('/api/v3/food/' + food.body.identifier, self.jwt.all).expect(200);

    (await v1('get', '/devicestatus.json?find[device]=' + device).expect(200)).body.length.should.equal(0);
    (await v1('get', '/food.json').expect(200)).body.filter((f) => f.name === name).length.should.equal(0);
  });

  it('a v1 DELETE by query still removes deleted records too', async () => {
    const note = tag('purge');
    const identifier = await v3Carbs(5, note);
    await self.instance.delete('/api/v3/treatments/' + identifier, self.jwt.all).expect(200);
    (await col('treatments').countDocuments({ notes: note })).should.equal(1);
    await v1('delete', '/treatments/?find[notes]=' + encodeURIComponent(note)).expect(200);
    (await col('treatments').countDocuments({ notes: note })).should.equal(0);
  });

  it('the cache takes out a record updated to isValid false and keeps the others', () => {
    const cache = self.instance.ctx.cache;
    const mills = Date.now();
    const a = { _id: new ObjectId().toString(), mills, created_at: new Date(mills).toISOString(), notes: tag('cache-a') };
    const b = { _id: new ObjectId().toString(), mills, created_at: new Date(mills).toISOString(), notes: tag('cache-b') };
    self.instance.ctx.bus.emit('data-update', { type: 'treatments', op: 'update', changes: [a, b] });
    cache.getData('treatments').filter((t) => t.notes === a.notes || t.notes === b.notes).length.should.equal(2);
    self.instance.ctx.bus.emit('data-update', { type: 'treatments', op: 'update', changes: [Object.assign({}, a, { isValid: false })] });
    const left = cache.getData('treatments').filter((t) => t.notes === a.notes || t.notes === b.notes);
    left.length.should.equal(1);
    left[0].notes.should.equal(b.notes);
  });
});
