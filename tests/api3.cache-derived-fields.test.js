'use strict';

// BF-146: a treatment written through API v3 entered the server's in-memory
// cache without `mills`, the time field every v1 path derives on the way in
// (ddata.processRawDataForRuntime, from created_at). The dataloader sorts the
// treatments by `mills`, and the IOB and COB plugins count a treatment only
// when its `mills` is before the time asked about. Once the cache holds enough
// treatments for the dataloader to take its incremental load (it fetches only
// the most recent minutes from MongoDB), a v3 record dated earlier than that
// window stayed in memory without `mills` until restart: left out of IOB and
// COB, and in the way of the time sort that COB and its "last carbs" detail
// rely on. A device status written through v3 had the same gap:
// GET /api/v1/devicestatus served from memory sorts by `mills`, so a late v3
// status was placed after every other one.
//
// Synthetic values only; not medical advice.

require('should');

describe('BF-146: treatments and device status written through API v3 enter the cache with mills', function () {
  const self = this
    , instance = require('./fixtures/api3/instance')
    , authSubject = require('./fixtures/api3/authSubject')
    , io = require('socket.io-client')
    , helper = require('./inithelper')()
    , HASH = 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
    , TAG = 'bf146-' + Date.now()
    , MIN = 60000
    // lib/server/cache.js isEmpty: below this many treatments every load is a
    // full load; at or above it the dataloader loads incrementally.
    , INCREMENTAL_THRESHOLD = 20
    ;

  self.timeout(30000);

  const cob = require('../lib/plugins/cob')(helper.ctx);
  const iob = require('../lib/plugins/iob')(helper.ctx);
  const profile = require('../lib/profilefunctions')([{ dia: 3, sens: 95, carbratio: 18, carbs_hr: 30 }], helper.ctx);

  const col = () => self.instance.ctx.store.collection(self.instance.env.treatments_collection || 'treatments');
  const tag = (s) => TAG + '-' + s;
  const ago = (minutes) => Date.now() - minutes * MIN;

  function v1 (method, url) {
    return self.instance[method]('/api/v1' + url).set('api-secret', HASH);
  }

  function load () {
    return new Promise((resolve) => self.instance.ctx.dataloader.update(self.instance.ctx.ddata, resolve));
  }

  // The loaded treatments whose notes start with the prefix, in the order the
  // site holds them (the order COB and IOB read them in).
  async function mine (prefix) {
    await load();
    return self.instance.ctx.ddata.treatments.filter((t) => typeof t.notes === 'string' && t.notes.indexOf(prefix) === 0);
  }

  const at = () => Date.now() + MIN;

  function v3 (body) {
    return self.instance.post('/api/v3/treatments', self.jwt.all)
      .send(Object.assign({ utcOffset: 0, app: 'AAPS', device: 'bf146', isValid: true }, body))
      .expect(201);
  }

  const v3Bolus = (units, minutesAgo, note) => v3({ eventType: 'Correction Bolus', date: ago(minutesAgo), insulin: units, notes: note });
  const v3Carbs = (grams, minutesAgo, note) => v3({ eventType: 'Carb Correction', date: ago(minutesAgo), carbs: grams, notes: note });
  const v1Treatment = (fields, minutesAgo) => v1('post', '/treatments/')
    .send(Object.assign({ created_at: new Date(ago(minutesAgo)).toISOString(), enteredBy: 'bf146' }, fields))
    .expect(200);

  before(async () => {
    self.instance = await instance.create({ useHttps: false });
    self.instance.app.use('/api/v1', require('../lib/api/')(self.instance.env, self.instance.ctx));
    const authResult = await authSubject(self.instance.ctx.authorization.storage, ['all'], self.instance.app);
    self.jwt = authResult.jwt;

    // Enough treatments in the cache for the incremental load: notes only,
    // no insulin or carbs, within the cache's retention.
    const filler = [];
    for (let i = 0; i < INCREMENTAL_THRESHOLD + 4; i++) {
      filler.push({ eventType: 'Note', created_at: new Date(ago(120 + i)).toISOString(), notes: tag('filler-' + i), enteredBy: 'bf146' });
    }
    await v1('post', '/treatments/').send(filler).expect(200);
    await load();
  });

  beforeEach(async () => {
    await load();
    self.instance.ctx.cache.isEmpty('treatments').should.equal(false, 'the dataloader is not on its incremental load');
  });

  after(async () => {
    await col().deleteMany({ $or: [{ notes: { $regex: '^' + TAG } }, { enteredBy: 'bf146' }, { device: 'bf146' }] });
    await self.instance.ctx.store.collection(self.instance.env.devicestatus_collection || 'devicestatus')
      .deleteMany({ device: { $regex: '^' + TAG } });
    self.instance.ctx.bus.teardown();
  });

  describe('incremental load: a late v3 record counts', () => {
    it('a v3 bolus dated 40 minutes ago counts in IOB', async () => {
      const note = tag('late-v3-bolus');
      await v3Bolus(2, 40, note);
      const held = await mine(note);
      held.length.should.equal(1);
      iob.calcTotal(held, [], profile, at()).iob.should.be.above(1);
      held[0].mills.should.equal(new Date(held[0].created_at).getTime());
    });

    it('v3 carbs dated 40 minutes ago count in COB', async () => {
      const note = tag('late-v3-carbs');
      await v3Carbs(30, 40, note);
      const held = await mine(note);
      held.length.should.equal(1);
      cob.cobTotal(held, [], profile, at()).cob.should.be.above(10);
    });

    it('control: a v1 bolus of the same age counts in IOB', async () => {
      const note = tag('late-v1-bolus');
      await v1Treatment({ eventType: 'Correction Bolus', insulin: 2, notes: note }, 40);
      iob.calcTotal(await mine(note), [], profile, at()).iob.should.be.above(1);
    });

    it('control: a v3 bolus dated now counts in IOB', async () => {
      const note = tag('fresh-v3-bolus');
      await v3Bolus(2, 0, note);
      iob.calcTotal(await mine(note), [], profile, at()).iob.should.be.above(1.5);
    });

    it('a v3 record updated through v3 (PUT and PATCH) keeps its mills', async () => {
      const note = tag('late-v3-edited');
      const created = await v3Bolus(1, 45, note);
      const identifier = created.body.identifier;
      await self.instance.patch('/api/v3/treatments/' + identifier, self.jwt.all).send({ insulin: 1.5 }).expect(200);
      let held = await mine(note);
      held.length.should.equal(1);
      held[0].insulin.should.equal(1.5);
      iob.calcTotal(held, [], profile, at()).iob.should.be.above(1);
      const doc = (await self.instance.get('/api/v3/treatments/' + identifier, self.jwt.all).expect(200)).body.result;
      delete doc.srvModified; delete doc.srvCreated; delete doc.subject; delete doc.modifiedBy;
      await self.instance.put('/api/v3/treatments/' + identifier, self.jwt.all).send(Object.assign(doc, { insulin: 1.25 })).expect(200);
      held = await mine(note);
      held.length.should.equal(1);
      held[0].insulin.should.equal(1.25);
      iob.calcTotal(held, [], profile, at()).iob.should.be.above(0.8);
      held[0].mills.should.equal(new Date(held[0].created_at).getTime());
    });
  });

  describe('order', () => {
    it('treatments follow time with mixed v1 and v3 writes', async () => {
      const prefix = tag('order-');
      await v1Treatment({ eventType: 'Note', notes: prefix + 'v1-90' }, 90);
      await v3({ eventType: 'Temp Basal', date: ago(75), duration: 30, rate: 0.5, absolute: 0.5, notes: prefix + 'v3-75' });
      await v1Treatment({ eventType: 'Note', notes: prefix + 'v1-60' }, 60);
      await v3Bolus(0.3, 50, prefix + 'v3-50');
      await v1Treatment({ eventType: 'Note', notes: prefix + 'v1-35' }, 35);
      await v3Bolus(0.2, 25, prefix + 'v3-25');
      const held = await mine(prefix);
      held.map((t) => t.notes.slice(prefix.length)).should.eql(['v1-90', 'v3-75', 'v1-60', 'v3-50', 'v1-35', 'v3-25']);
      held.forEach((t) => Number.isFinite(t.mills).should.equal(true, t.notes + ' has no mills'));
    });

    it('COB "last carbs" names the newest carbs after a v3 write and an edit of older carbs (BF-133)', async () => {
      const prefix = tag('lastcarbs-');
      await v1Treatment({ eventType: 'Carb Correction', carbs: 25, notes: prefix + 'older-25g' }, 150);
      await v1Treatment({ eventType: 'Carb Correction', carbs: 15, notes: prefix + 'newer-15g' }, 30);
      await v3Bolus(0.4, 50, prefix + 'v3-smb');
      const older = await col().findOne({ notes: prefix + 'older-25g' });
      await v1('put', '/treatments/').send(Object.assign({}, older, { _id: String(older._id), carbs: 24 })).expect(200);
      const result = cob.cobTotal(await mine(prefix), [], profile, at());
      result.lastCarbs.notes.should.equal(prefix + 'newer-15g');
    });

    it('the COB total is the one computed in time order', async () => {
      const prefix = tag('cobtotal-');
      await v1Treatment({ eventType: 'Carb Correction', carbs: 25, notes: prefix + 'older-25g' }, 150);
      await v1Treatment({ eventType: 'Carb Correction', carbs: 15, notes: prefix + 'newer-15g' }, 30);
      await v3Bolus(0.4, 50, prefix + 'v3-smb');
      const held = await mine(prefix);
      const inTimeOrder = held.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((t) => Object.assign({}, t, { mills: Date.parse(t.created_at) }));
      const when = at();
      const expected = cob.cobTotal(inTimeOrder, [], profile, when).cob;
      expected.should.be.above(0);
      cob.cobTotal(held, [], profile, when).cob.should.equal(expected);
    });
  });

  describe('device status', () => {
    const ds = (s) => tag('ds-' + s);
    const statusTime = (d) => Date.parse(d.created_at);
    const cached = () => self.instance.ctx.cache.devicestatus;

    function v1Status (name, minutesAgo) {
      return { device: ds(name), created_at: new Date(ago(minutesAgo)).toISOString(), pump: { reservoir: 100 } };
    }

    function v3Status (name, minutesAgo) {
      return self.instance.post('/api/v3/devicestatus', self.jwt.all)
        .send({ date: ago(minutesAgo), utcOffset: 0, app: 'AAPS', device: ds(name), pump: { reservoir: 90 } })
        .expect(201);
    }

    // What GET /api/v1/devicestatus should answer from memory: the newest
    // `count` held statuses by time.
    function newestHeld (count) {
      return cached().slice().sort((a, b) => statusTime(b) - statusTime(a)).slice(0, count).map((d) => d.device);
    }

    async function v1Read (count) {
      const url = '/devicestatus.json' + (count ? '?count=' + count : '');
      const res = await v1('get', url).expect(200);
      return res.body.map((d) => d.device);
    }

    before(async () => {
      // More held statuses than the default read asks for, and enough for the
      // dataloader's incremental load of device status.
      const held = [];
      for (let i = 0; i < INCREMENTAL_THRESHOLD + 4; i++) held.push(v1Status('v1-' + i, 60 - i));
      await v1('post', '/devicestatus/').send(held).expect(200);
      await load();
    });

    beforeEach(() => {
      self.instance.ctx.cache.isEmpty('devicestatus').should.equal(false, 'the dataloader is not on its incremental load of device status');
      cached().length.should.be.aboveOrEqual(10);
    });

    it('a late v3 status newer than the others is in the default v1 read, in its place', async () => {
      await v3Status('v3-late', 20);
      await load();
      const read = await v1Read();
      read.should.containEql(ds('v3-late'));
      read.should.eql(newestHeld(10));
    });

    it('the whole held set read from memory is in time order', async () => {
      const count = cached().length;
      const read = await v1Read(count);
      read.should.eql(newestHeld(count));
    });

    it('control: a v1 status of the same age is in its place', async () => {
      await v1('post', '/devicestatus/').send([v1Status('v1-late', 19)]).expect(200);
      await load();
      // Its own place only: this control does not depend on the v3 records.
      const read = await v1Read();
      read.should.containEql(ds('v1-late'));
      read.indexOf(ds('v1-late')).should.equal(newestHeld(10).indexOf(ds('v1-late')));
    });

    it('control: a v3 status dated now is first', async () => {
      await v3Status('v3-now', 0);
      await load();
      (await v1Read())[0].should.equal(ds('v3-now'));
    });

    it('the page data holds the late v3 status with its time', async () => {
      const held = self.instance.ctx.ddata.devicestatus.filter((d) => d.device === ds('v3-late'));
      held.length.should.equal(1);
      held[0].mills.should.equal(statusTime(held[0]));
      const recent = self.instance.ctx.ddata.recentDeviceStatus(Date.now()).filter((d) => d.device === ds('v3-late'));
      recent.length.should.equal(1);
    });

    it('with DENORMALIZE_DATES the late v3 status keeps its time and place over repeated reads', async () => {
      const settings = self.instance.env.settings;
      const was = settings.deNormalizeDates;
      settings.deNormalizeDates = true;
      try {
        await v3Status('v3-late-denorm', 18);
        await load();
        for (let i = 0; i < 2; i++) {
          const res = await v1('get', '/devicestatus.json').expect(200);
          const mine = res.body.filter((d) => d.device === ds('v3-late-denorm'));
          mine.length.should.equal(1);
          Date.parse(mine[0].created_at).should.equal(mine[0].mills);
          res.body.map((d) => d.device).should.eql(newestHeld(10));
          await load();
        }
      } finally {
        settings.deNormalizeDates = was;
      }
    });
  });

  it('the page data sent over the socket carries mills for a late v3 bolus', async () => {
    const note = tag('socket-v3-bolus');
    await v3Bolus(2, 40, note);
    await load();
    self.instance.ctx.bus.emit('data-processed');

    const socket = io(self.instance.baseUrl, { transports: ['websocket'], reconnection: false });
    try {
      const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no dataUpdate')), 5000);
        socket.on('dataUpdate', (d) => { clearTimeout(timer); resolve(d); });
        socket.on('connect', () => socket.emit('authorize', { client: 'test', secret: HASH }));
        socket.on('connect_error', reject);
      });
      const sent = data.treatments.filter((t) => t.notes === note);
      sent.length.should.equal(1);
      iob.calcTotal(sent, [], profile, at()).iob.should.be.above(1);
      sent[0].mills.should.be.a.Number();
    } finally {
      socket.close();
    }
  });
});
