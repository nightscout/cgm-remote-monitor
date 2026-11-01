'use strict';

// ID-UNIQUE-INDEX, item level (decision 2026-10-30: "re-reads by identifier,
// applies the item ... and retries once"): when one item of an API v1 batch
// loses an identifier race, only that item is applied again, as its re-send.
// The items the write had already stored keep their outcome, are written
// once (srvModified as inserted) and are announced once.
//
// Device status: deterministic. The other upload's status is stored straight
// to MongoDB at the batch's first insertMany, after the batch's identifier
// match, so the raced status's insert is refused by identifier_unique. The
// insert is unordered, so slot 0 is stored by the same call.
//
// Treatments: a treatment's target is its identifier, so a record stored
// before the write would simply be matched. The race needs two upserts at
// once: two batches, each a new treatment of its own in slot 0 and the same
// treatment in slot 1 (so their slot-1 upserts line up), are held at their
// bulk write until both arrive, then run together, ROUNDS times. MongoDB
// settles some of these itself; the test counts the rounds that reached the
// write step's race handling and fails if none did, so it cannot pass
// without the race. In each such round, the batch whose slot 1 lost keeps
// slot 0 as inserted, written once.
//
// Synthetic values only; records dated 2021.

var request = require('supertest');
var should = require('should');
var { Collection } = require('mongodb');
var language = require('../lib/language')();
var writeIntent = require('../lib/storage/write-intent');

describe('ID-UNIQUE-INDEX: a batch item that loses an identifier race is applied alone', function () {
  this.timeout(60000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var DEVICE = 'batch-race-item-level-test';
  var realInsertMany = Collection.prototype.insertMany;
  var realBulkWrite = Collection.prototype.bulkWrite;
  var realForCollection = writeIntent.forCollectionIntent;
  var defaultWrite;
  var updates = [];
  var results = [];
  var warned = [];
  var realWarn = console.warn;

  function col (name) { return self.ctx.store.collection(self.env[name + '_collection']); }
  function iso (minute) { return new Date(Date.UTC(2021, 8, 9, 7, minute)).toISOString(); }
  async function dropAll () {
    await col('devicestatus').deleteMany({ device: DEVICE });
    await col('treatments').deleteMany({ enteredBy: DEVICE });
    await col('food').deleteMany({ enteredBy: DEVICE });
    await col('profile').deleteMany({ enteredBy: DEVICE });
    await col('activity').deleteMany({ enteredBy: DEVICE });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    defaultWrite = self.env.write;
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      ctx.bus.on('data-update', function (ev) { updates.push(ev); });
      dropAll().then(function () { done(); }, done);
    });
  });

  beforeEach(function () {
    updates = [];
    results = [];
    warned = [];
    console.warn = function () { warned.push(Array.prototype.join.call(arguments, ' ')); return realWarn.apply(console, arguments); };
    // Each result the write step answers, by collection.
    writeIntent.forCollectionIntent = function forCollectionIntent (storage, name) {
      var options = arguments[3];
      var step = realForCollection.apply(this, arguments);
      var write = step.write;
      step.write = async function (intent) {
        var result = await write.call(step, intent);
        results.push({ name: name, result: result, resend: options && options.env && options.env.write.resend });
        return result;
      };
      return step;
    };
    return dropAll();
  });

  afterEach(function () {
    console.warn = realWarn;
    self.env.write = defaultWrite;
    Collection.prototype.insertMany = realInsertMany;
    Collection.prototype.bulkWrite = realBulkWrite;
    writeIntent.forCollectionIntent = realForCollection;
  });

  after(dropAll);

  function raceLines () {
    return warned.filter(function (w) { return /applying this one as its re-send/.test(w); }).length;
  }

  async function raceBatchMode (name, mode, method, url, body, rival, targetId) {
    self.env.write = Object.freeze(Object.assign({ }, defaultWrite, { resend: mode }));
    var real = Collection.prototype[method];
    var target = col(name).collectionName;
    var inserted = null;
    var docs = Array.isArray(body) ? body : [body];
    var identifier = targetId || docs[docs.length - 1].identifier;
    Collection.prototype[method] = async function raceBeforeWrite () {
      var that = this;
      var args = arguments;
      if (that.collectionName === target && inserted === null) {
        inserted = (await col(name).insertOne(rival)).insertedId;
      }
      return real.apply(that, args);
    };
    var response;
    try {
      response = await request(self.app).post(url).set('api-secret', known).send(docs);
    } finally {
      Collection.prototype[method] = real;
    }
    should.exist(inserted, name + ' race reached its write');
    response.status.should.equal(200, JSON.stringify(response.body));
    var matches = results.filter(function (r) {
      return r.name === name && r.result.items.some(function (item) { return item.identifier === identifier; });
    });
    matches.length.should.equal(1, name + ' write results ' + JSON.stringify(matches));
    matches[0].resend.should.equal(mode, name + ' resend mode reached the write step');
    var result = matches[0].result;
    var stored = await col(name).findOne({ identifier: identifier });
    should.exist(stored, name + ' has one record after race');
    return { response: response, result: result, stored: stored };
  }

  function assertRaceMode (result, mode, outcome, identifier) {
    var raced = result.items.filter(function (item) { return item.identifier === identifier; });
    raced.length.should.equal(1);
    raced[0].outcome.should.equal(outcome);
    if (mode === 'acknowledge' || mode === 'refuse') {
      raced[0].reason.should.equal(writeIntent.RESEND_REASON);
    }
  }

  it('status race retries honor acknowledge, refuse and merge-except-treatments', async function () {
    var modes = [['acknowledge', 'unchanged'], ['refuse', 'refused'], ['merge-except-treatments', 'merged']];
    for (var entry of modes) {
      var id = 'batch-race-status-' + entry[0] + '-' + Date.now();
      var created = iso(20);
      var r = await raceBatchMode('devicestatus', entry[0], 'insertMany', '/api/devicestatus/'
        , { identifier: id, device: DEVICE, created_at: created, uploaderBattery: 60 }
        , { identifier: id, device: DEVICE, created_at: created, uploaderBattery: 50, pump: { reservoir: 10 }
          , srvCreated: 1, srvModified: 1 });
      assertRaceMode(r.result, entry[0], entry[1], id);
      if (entry[0] === 'merge-except-treatments') {
        r.stored.uploaderBattery.should.equal(60);
        r.stored.pump.reservoir.should.equal(10);
      } else {
        r.stored.uploaderBattery.should.equal(50);
      }
    }
  });

  it('entries identifier race honors acknowledge and refuse while retaining entry matching', async function () {
    for (var mode of ['acknowledge', 'refuse']) {
      var id = 'batch-race-entry-' + mode + '-' + Date.now();
      var date = Date.UTC(2021, 8, 10, 7, 20);
      var rivalDate = date - 60000;
      var r = await raceBatchMode('entries', mode, 'bulkWrite', '/api/entries/'
        , { identifier: id, type: 'sgv', sgv: 110, date: date, dateString: new Date(date).toISOString()
          , sysTime: new Date(date).toISOString(), device: DEVICE }
        , { identifier: id, type: 'sgv', sgv: 100, date: rivalDate, dateString: new Date(rivalDate).toISOString()
          , sysTime: new Date(rivalDate).toISOString(), device: DEVICE
          , srvCreated: 1, srvModified: 1 });
      assertRaceMode(r.result, mode, mode === 'acknowledge' ? 'unchanged' : 'refused', id);
      r.stored.sgv.should.equal(100);
    }
  });

  it('profile race retries honor resend modes', async function () {
    for (var mode of ['acknowledge', 'refuse', 'merge-except-treatments']) {
      var id = 'batch-race-profile-mode-' + mode + '-' + Date.now();
      var startDate = new Date(Date.UTC(2021, 8, 9)).toISOString();
      var r = await raceBatchMode('profile', mode, 'insertMany', '/api/profile/'
        , { identifier: id, defaultProfile: 'next', startDate: startDate, units: 'mg/dl', enteredBy: DEVICE
          , store: { p: { dia: 4 } } }
        , { identifier: id, defaultProfile: 'previous', startDate: startDate, units: 'mg/dl', enteredBy: DEVICE
          , store: { p: { dia: 3 } }, srvCreated: 1, srvModified: 1 });
      assertRaceMode(r.result, mode, mode === 'acknowledge' ? 'unchanged' : mode === 'refuse' ? 'refused' : 'merged', id);
      r.stored.defaultProfile.should.equal(mode === 'merge-except-treatments' ? 'next' : 'previous');
    }
  });

  it('profile identifier race does not grant create-only update permission', async function () {
    var id = 'batch-race-profile-create-only-' + Date.now();
    var startDate = new Date(Date.UTC(2021, 8, 9)).toISOString();
    var rival = { identifier: id, defaultProfile: 'previous', startDate: startDate, units: 'mg/dl', enteredBy: DEVICE
      , store: { p: { dia: 3 } }, srvCreated: 1, srvModified: 1 };
    var other = null;
    var profileName = col('profile').collectionName;
    Collection.prototype.insertMany = async function insertMany () {
      if (this.collectionName === profileName && other === null) {
        other = (await col('profile').insertOne(rival)).insertedId;
      }
      return realInsertMany.apply(this, arguments);
    };
    var err;
    try {
      await self.ctx.profile.create([
        { identifier: id, defaultProfile: 'next', startDate: startDate, units: 'mg/dl', enteredBy: DEVICE
          , store: { p: { dia: 4 } } }
      ], null, { canUpdate: false });
    } catch (error) {
      err = error;
    } finally {
      Collection.prototype.insertMany = realInsertMany;
    }
    should.exist(other, 'the create-only upload reached insertMany');
    should.exist(err, 'the create-only upload is refused');
    err.code.should.equal('PROFILE_UPDATE_PERMISSION_REQUIRED');
    var stored = await col('profile').find({ identifier: id }).toArray();
    stored.length.should.equal(1);
    String(stored[0]._id).should.equal(String(other));
    stored[0].defaultProfile.should.equal('previous');
    stored[0].store.p.dia.should.equal(3);
  });

  it('food and activity replace-document races honor acknowledge, refuse and merge mode', async function () {
    for (var name of ['food', 'activity']) {
      for (var entry of [['acknowledge', 'unchanged'], ['refuse', 'refused'], ['merge-except-treatments', 'merged']]) {
        var id = 'batch-race-' + name + '-' + entry[0] + '-' + Date.now();
        var body = name === 'food'
          ? { identifier: id, type: 'food', name: 'new', enteredBy: DEVICE }
          : { identifier: id, created_at: iso(22), notes: 'new', steps: 200, enteredBy: DEVICE };
        var rival = name === 'food'
          ? { identifier: id, type: 'food', name: 'stored', category: 'keep', enteredBy: DEVICE, srvCreated: 1, srvModified: 1 }
          : { identifier: id, created_at: iso(22), notes: 'stored', steps: 100, heartrate: 60, enteredBy: DEVICE
            , srvCreated: 1, srvModified: 1 };
        var r = await raceBatchMode(name, entry[0], 'bulkWrite', '/api/' + name + '/', body, rival);
        assertRaceMode(r.result, entry[0], entry[1], id);
        var changed = entry[0] === 'merge-except-treatments';
        r.stored[name === 'food' ? 'name' : 'notes'].should.equal(changed ? 'new' : 'stored');
        if (changed && name === 'food') r.stored.category.should.equal('keep');
        if (changed && name === 'activity') r.stored.heartrate.should.equal(60);
      }
    }
  });

  // CHANGED EXPECTATION (compat card B, extended, maintainer 2026-10-31): an
  // identifier match replaces on every path, so the raced item is applied as
  // the table's onMatch, `replaced`, and what it leaves out is gone. Was:
  // merged, keeping the other upload's fields.
  it('device status: slot 0 stored once and announced once; slot 1 replaces the other upload\'s status', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var RACE = 'batch-race-status-1';
    var other = null;
    var statusName = col('devicestatus').collectionName;
    Collection.prototype.insertMany = async function insertMany () {
      if (this.collectionName === statusName && other === null) {
        other = (await col('devicestatus').insertOne({ identifier: RACE, device: DEVICE, created_at: iso(1)
          , uploaderBattery: 50, pump: { reservoir: 10 }, srvCreated: 1, srvModified: 1 })).insertedId;
      }
      return realInsertMany.apply(this, arguments);
    };
    var batch = [
      { identifier: 'batch-race-status-0', device: DEVICE, created_at: iso(0), uploaderBattery: 70 }
      , { identifier: RACE, device: DEVICE, created_at: iso(1), uploaderBattery: 40 }
    ];
    var res = await request(self.app).post('/api/devicestatus/').set('api-secret', known).send(batch).expect(200);
    Collection.prototype.insertMany = realInsertMany;
    should.exist(other, 'the other upload was stored at the first insertMany');

    var written = results.filter(function (r) { return r.name === 'devicestatus'; });
    written.length.should.equal(1);
    written[0].result.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'replaced']);
    // Q-A (#8890): a replace is an update, named in WriteResult.updated, so
    // the raced item's replace names the other upload's record.
    (written[0].result.updated || []).map(String).should.eql([String(other)]);
    raceLines().should.equal(1, 'one race handled');

    var s0 = await col('devicestatus').find({ identifier: 'batch-race-status-0' }).toArray();
    s0.length.should.equal(1);
    s0[0].srvModified.should.equal(s0[0].srvCreated, 'slot 0 written once');
    var s1 = await col('devicestatus').find({ identifier: RACE }).toArray();
    s1.length.should.equal(1, 'one status holds the identifier');
    s1[0].uploaderBattery.should.equal(40, 'slot 1 written');
    s1[0].should.not.have.property('pump', 'a replace drops what slot 1 leaves out');

    res.body.length.should.equal(2);
    String(res.body[0]._id).should.equal(String(s0[0]._id));
    String(res.body[1]._id).should.equal(String(other));
    var announced = updates.filter(function (u) { return u.type === 'devicestatus'; });
    announced.length.should.equal(1, 'one data-update for device status');
    announced[0].changes.map(function (s) { return s.uploaderBattery; }).sort().should.eql([40, 70]);
  });

  it('treatments: in the rounds where slot 1 lost the race, slot 0 keeps its outcome and is written once', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var treatmentsName = col('treatments').collectionName;
    for (var entry of [['replace', 'replaced'], ['merge-except-treatments', 'replaced'], ['acknowledge', 'unchanged'], ['refuse', 'refused']]) {
      self.env.write = Object.freeze(Object.assign({ }, defaultWrite, { resend: entry[0] }));
      var ROUNDS = 30;
      var raced = 0;
      for (var round = 0; round < ROUNDS; round++) {
        var stamp = Date.now() + '-' + round;
        var t0 = { identifier: 'batch-race-t0-' + stamp, eventType: 'Note', notes: 'zero', created_at: iso(10 + round), enteredBy: DEVICE };
        var p0 = { identifier: 'batch-race-p0-' + stamp, eventType: 'Note', notes: 'pad', created_at: iso(10 + round), enteredBy: DEVICE };
        var t1 = { identifier: 'batch-race-t1-' + stamp, eventType: 'Note', notes: 'one', created_at: iso(10 + round), enteredBy: DEVICE };
        // Hold the first two bulk writes on treatments until both arrive.
        var held = [];
        Collection.prototype.bulkWrite = function bulkWrite () {
          var that = this;
          var args = arguments;
          if (that.collectionName !== treatmentsName || held.length >= 2 && held.released) return realBulkWrite.apply(that, args);
          return new Promise(function (resolve) {
            held.push(resolve);
            if (held.length === 2) { held.released = true; held.forEach(function (go) { go(); }); }
          }).then(function () { return realBulkWrite.apply(that, args); });
        };
        results = [];
        var before = raceLines();
        var replies = await Promise.all([
          request(self.app).post('/api/treatments/').set('api-secret', known).send([t0, Object.assign({}, t1, { notes: 'one again' })])
          , request(self.app).post('/api/treatments/').set('api-secret', known).send([p0, t1])
        ]);
        Collection.prototype.bulkWrite = realBulkWrite;
        replies.map(function (r) { return r.status; }).should.eql([200, 200], 'round ' + round);
        var stored1 = await col('treatments').find({ identifier: t1.identifier }).toArray();
        stored1.length.should.equal(1, 'round ' + round + ': one record holds slot 1\'s identifier');
        if (raceLines() === before) continue;
        raced += 1;
        var batches = results.filter(function (r) { return r.name === 'treatments' && r.result.items.length === 2; });
        batches.length.should.equal(2, 'round ' + round + ': one write result per batch');
        var losers = batches.filter(function (r) { return r.result.items[1].outcome !== 'inserted'; });
        losers.length.should.equal(1, 'round ' + round + ': one batch lost slot 1');
        var loser = losers[0].result;
        loser.items[0].outcome.should.equal('inserted', 'round ' + round + ': the loser\'s slot 0 keeps its outcome');
        loser.items[1].outcome.should.equal(entry[1], 'round ' + round + ': slot 1 follows resend mode ' + entry[0]);
        var slot0 = await col('treatments').find({ identifier: loser.items[0].identifier }).toArray();
        slot0.length.should.equal(1);
        slot0[0].srvModified.should.equal(slot0[0].srvCreated, 'round ' + round + ': the loser\'s slot 0 written once');
      }
      console.log('    (treatments ' + entry[0] + ' rounds that reached race handling: ' + raced + ' of ' + ROUNDS + ')');
      raced.should.be.above(0, entry[0] + ': the race was reached in at least one round');
    }
  });

  // ID-FIRST-MATCH slices 6 and 6a: food and profile match a stored
  // identifier first, so a raced item of their batches is applied as its
  // re-send too. Deterministic, as device status above: the other upload's
  // record is stored at the batch's first write call, after identifier first.
  it('food (slice 6): slot 0 stored once, slot 1 replaces the other upload\'s food, slot 2 stored after it', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var RACE = 'batch-race-food-1-' + Date.now();
    var other = null;
    var foodName = col('food').collectionName;
    Collection.prototype.bulkWrite = async function bulkWrite () {
      if (this.collectionName === foodName && other === null) {
        other = (await col('food').insertOne({ identifier: RACE, type: 'food', name: 'rival', category: 'race', enteredBy: DEVICE
          , srvCreated: 1, srvModified: 1 })).insertedId;
      }
      return realBulkWrite.apply(this, arguments);
    };
    var batch = [
      { identifier: RACE + '-0', type: 'food', name: 'zero', enteredBy: DEVICE }
      , { identifier: RACE, type: 'food', name: 'one', enteredBy: DEVICE }
      , { identifier: RACE + '-2', type: 'food', name: 'two', enteredBy: DEVICE }
    ];
    var res = await request(self.app).post('/api/food/').set('api-secret', known).send(batch);
    Collection.prototype.bulkWrite = realBulkWrite;
    res.status.should.equal(200);
    should.exist(other, 'the other upload was stored at the first bulk write');
    var written = results.filter(function (r) { return r.name === 'food'; });
    written.length.should.equal(1);
    // CHANGED EXPECTATION (compat card B, extended): replaced, as the table says.
    written[0].result.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'replaced', 'inserted']);
    (written[0].result.updated || []).map(String).should.eql([String(other)], 'Q-A: the replace names the holder');
    raceLines().should.equal(1, 'one race handled');
    var s0 = await col('food').find({ identifier: RACE + '-0' }).toArray();
    s0.length.should.equal(1);
    s0[0].srvModified.should.equal(s0[0].srvCreated, 'slot 0 written once');
    (await col('food').countDocuments({ identifier: RACE + '-2' })).should.equal(1, 'slot 2 stored after the raced slot');
    var s1 = await col('food').find({ identifier: RACE }).toArray();
    s1.length.should.equal(1, 'one food holds the identifier');
    String(s1[0]._id).should.equal(String(other));
    s1[0].name.should.equal('one', 'slot 1 written');
    s1[0].should.not.have.property('category', 'a replace drops what slot 1 leaves out');
    s1[0].srvCreated.should.equal(1, 'the replace keeps the stored record\'s srvCreated');
    await col('food').deleteMany({ enteredBy: DEVICE });
  });

  // Activity (slice 6a) has no server dates of its own: a replace carries the
  // ones the stored record has (compat card B, extended), on the race path too.
  it('activity (slice 6a): slot 1 replaces the other upload\'s activity and keeps its server dates', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var RACE = 'batch-race-activity-1-' + Date.now();
    var other = null;
    var activityName = col('activity').collectionName;
    Collection.prototype.bulkWrite = async function bulkWrite () {
      if (this.collectionName === activityName && other === null) {
        other = (await col('activity').insertOne({ identifier: RACE, created_at: iso(41), steps: 900, heartrate: 70, enteredBy: DEVICE
          , srvCreated: 1, srvModified: 1 })).insertedId;
      }
      return realBulkWrite.apply(this, arguments);
    };
    var batch = [
      { identifier: RACE + '-0', created_at: iso(40), steps: 100, enteredBy: DEVICE }
      , { identifier: RACE, created_at: iso(41), steps: 1000, enteredBy: DEVICE }
      , { identifier: RACE + '-2', created_at: iso(42), steps: 200, enteredBy: DEVICE }
    ];
    var res = await request(self.app).post('/api/activity/').set('api-secret', known).send(batch);
    Collection.prototype.bulkWrite = realBulkWrite;
    res.status.should.equal(200);
    should.exist(other, 'the other upload was stored at the first bulk write');
    var written = results.filter(function (r) { return r.name === 'activity'; });
    written.length.should.equal(1);
    written[0].result.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'replaced', 'inserted']);
    (written[0].result.updated || []).map(String).should.eql([String(other)], 'Q-A: the replace names the holder');
    raceLines().should.equal(1, 'one race handled');
    (await col('activity').countDocuments({ identifier: RACE + '-0' })).should.equal(1);
    (await col('activity').countDocuments({ identifier: RACE + '-2' })).should.equal(1, 'slot 2 stored after the raced slot');
    var s1 = await col('activity').find({ identifier: RACE }).toArray();
    s1.length.should.equal(1, 'one activity holds the identifier');
    String(s1[0]._id).should.equal(String(other));
    s1[0].steps.should.equal(1000, 'slot 1 written');
    s1[0].should.not.have.property('heartrate', 'a replace drops what slot 1 leaves out');
    s1[0].srvCreated.should.equal(1, 'the replace keeps the stored record\'s srvCreated');
    s1[0].srvModified.should.equal(1, 'and its srvModified');
    await col('activity').deleteMany({ enteredBy: DEVICE });
  });

  it('profile (slice 6): slot 0 stored once, slot 1 replaces the other upload\'s profile, slot 2 inserted after it', async function () {
    self.ctx.identifierIndex.mode.should.equal('try');
    var RACE = 'batch-race-profile-1-' + Date.now();
    var startDate = new Date(Date.UTC(2021, 8, 9, 0, 0)).toISOString();
    var other = null;
    var profileName = col('profile').collectionName;
    function profile (n, extra) {
      return Object.assign({ defaultProfile: 'p' + n, startDate: new Date(Date.UTC(2021, 8, 9 + n, 0, 0)).toISOString()
        , units: 'mg/dl', enteredBy: DEVICE, store: { ['p' + n]: { dia: 3 + n } } }, extra || {});
    }
    Collection.prototype.insertMany = async function insertMany () {
      if (this.collectionName === profileName && other === null) {
        other = (await col('profile').insertOne(Object.assign(profile(1, { identifier: RACE, startDate: startDate, mills: 1 })
          , { srvCreated: 1, srvModified: 1 }))).insertedId;
      }
      return realInsertMany.apply(this, arguments);
    };
    var batch = [profile(0, { identifier: RACE + '-0' }), profile(1, { identifier: RACE, startDate: startDate, defaultProfile: 'one' })
      , profile(2, { identifier: RACE + '-2' })];
    var res = await request(self.app).post('/api/profile/').set('api-secret', known).send(batch);
    Collection.prototype.insertMany = realInsertMany;
    res.status.should.equal(200);
    should.exist(other, 'the other upload was stored at the first insertMany');
    var written = results.filter(function (r) { return r.name === 'profile'; });
    written.length.should.equal(1);
    written[0].result.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'replaced', 'inserted']);
    raceLines().should.equal(1, 'one race handled');
    var s0 = await col('profile').find({ identifier: RACE + '-0' }).toArray();
    s0.length.should.equal(1);
    s0[0].srvModified.should.equal(s0[0].srvCreated, 'slot 0 written once');
    (await col('profile').countDocuments({ identifier: RACE + '-2' })).should.equal(1, 'slot 2 inserted after the raced slot');
    var s1 = await col('profile').find({ identifier: RACE }).toArray();
    s1.length.should.equal(1, 'one profile holds the identifier');
    String(s1[0]._id).should.equal(String(other));
    s1[0].defaultProfile.should.equal('one', 'slot 1 merged');
    s1[0].should.not.have.property('mills', 'a replace drops what slot 1 leaves out');
    await col('profile').deleteMany({ enteredBy: DEVICE });
  });
});
