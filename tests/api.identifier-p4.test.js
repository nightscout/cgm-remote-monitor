'use strict';

// P4 (ID-FIRST-MATCH slice 5, ID-Q5): when one `identifier` names more than
// one stored record, a create or re-send matched by it lands on the record
// whose time key equals the write's (created_at for treatments and device
// status, sysTime or date for entries), else on the newest by _id, and the
// reply names that record. Before slice 5 each path kept its own pick: v1 and
// in-process treatments and entries wrote to the record MongoDB found first,
// device status named the first by _id (BF-212: the re-send of the moved half
// of a chart split landed on the original). Every such match is logged without
// the identifier.
//
// The records are stored straight to MongoDB, as the chart split stored two
// halves under one identifier before BF-212's fix. Synthetic values only;
// every record is dated in May 2019.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

describe('P4: a re-send whose identifier names two stored records lands on the one at its time', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var ID = 'f1d2c3b4-0000-4000-8000-00000000c001';
  var T_A = Date.parse('2019-05-11T07:40:00.000Z');
  var T_B = T_A + 120000;
  var FROM = '2019-05-01T00:00:00.000Z';
  var TO = '2019-06-01T00:00:00.000Z';
  var warnings;
  var realWarn = console.warn;

  function iso (t) { return new Date(t).toISOString(); }

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function stored (name) {
    var key = name === 'entries' ? 'sysTime' : 'created_at';
    return col(name).find({ [key]: { $gte: FROM, $lt: TO } }).sort({ _id: 1 }).toArray();
  }

  function dropAll () {
    return Promise.all([
      col('treatments').deleteMany({ created_at: { $gte: FROM, $lt: TO } })
      , col('devicestatus').deleteMany({ created_at: { $gte: FROM, $lt: TO } })
      , col('entries').deleteMany({ sysTime: { $gte: FROM, $lt: TO } })
    ]);
  }

  // A, then B two minutes later with another amount, one identifier.
  async function seed (name) {
    var a, b;
    if (name === 'treatments') {
      a = { identifier: ID, eventType: 'Carb Correction', carbs: 12, created_at: iso(T_A), half: 'a' };
      b = { identifier: ID, eventType: 'Carb Correction', carbs: 20, created_at: iso(T_B), half: 'b' };
    } else if (name === 'entries') {
      a = { identifier: ID, type: 'sgv', sgv: 100, date: T_A, dateString: iso(T_A), sysTime: iso(T_A), utcOffset: 0, half: 'a' };
      b = { identifier: ID, type: 'sgv', sgv: 120, date: T_B, dateString: iso(T_B), sysTime: iso(T_B), utcOffset: 0, half: 'b' };
    } else {
      a = { identifier: ID, device: 'p4-test', created_at: iso(T_A), uploaderBattery: 77, half: 'a' };
      b = { identifier: ID, device: 'p4-test', created_at: iso(T_B), uploaderBattery: 70, half: 'b' };
    }
    await col(name).insertOne(a);
    await col(name).insertOne(b);
    return { a: a, b: b };
  }

  function byHalf (docs) {
    var out = {};
    docs.forEach(function (doc) { out[doc.half] = doc; });
    return out;
  }

  function dedupeLines () {
    return warnings.filter(function (line) { return line.indexOf('identifier names') !== -1; });
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      // The two halves are stored as before the unique index (ID-UNIQUE-INDEX).
      require('./fixtures/identifier-index').dropIdentifierIndex(ctx.store, self.env)
        .then(dropAll).then(function () { done(); }, done);
    });
  });

  beforeEach(function () {
    warnings = [];
    console.warn = function (line) { warnings.push(String(line)); };
  });

  afterEach(function () {
    console.warn = realWarn;
    return dropAll();
  });

  it('treatments, API v1: a re-send of A replaces A, not B, and names A', async function () {
    var s = await seed('treatments');
    var res = await request(self.app).post('/api/treatments/').set('api-secret', known)
      .send([{ identifier: ID, eventType: 'Carb Correction', carbs: 13, created_at: iso(T_A), half: 'a' }]).expect(200);
    var docs = byHalf(await stored('treatments'));
    Object.keys(docs).length.should.equal(2);
    docs.a.carbs.should.equal(13);
    docs.b.carbs.should.equal(20);
    String(res.body[0]._id).should.equal(String(s.a._id));
    dedupeLines().length.should.equal(1);
    dedupeLines()[0].should.containEql('treatments v1/internal re-send: identifier names 2 records; the write lands on '
      + String(s.a._id) + ' (same time)');
    dedupeLines()[0].should.not.containEql(ID);
  });

  it('treatments, API v1: a re-send of B replaces B and names B', async function () {
    var s = await seed('treatments');
    var res = await request(self.app).post('/api/treatments/').set('api-secret', known)
      .send([{ identifier: ID, eventType: 'Carb Correction', carbs: 21, created_at: iso(T_B), half: 'b' }]).expect(200);
    var docs = byHalf(await stored('treatments'));
    docs.a.carbs.should.equal(12);
    docs.b.carbs.should.equal(21);
    String(res.body[0]._id).should.equal(String(s.b._id));
  });

  it('treatments, in-process: one document at neither time lands on the newest (B) and names it', async function () {
    var s = await seed('treatments');
    var created = await new Promise(function (resolve, reject) {
      self.ctx.treatments.create({ identifier: ID, eventType: 'Carb Correction', carbs: 30, created_at: iso(T_B + 600000), half: 'b' }
        , function (err, result) { if (err) reject(err); else resolve(result); });
    });
    var docs = await stored('treatments');
    docs.length.should.equal(2);
    var halves = byHalf(docs);
    halves.a.carbs.should.equal(12);
    halves.b.carbs.should.equal(30);
    String(created[0]._id).should.equal(String(s.b._id));
    dedupeLines()[0].should.endWith(' (newest)');
  });

  it('treatments, API v1 PUT (save): an edit addressed by the shared identifier lands on the record P4 picks (ID-Q10)', async function () {
    var s = await seed('treatments');
    await request(self.app).put('/api/treatments/').set('api-secret', known)
      .send({ identifier: ID, eventType: 'Carb Correction', carbs: 22, created_at: iso(T_B), half: 'b' }).expect(200);
    var docs = byHalf(await stored('treatments'));
    docs.a.carbs.should.equal(12);
    docs.b.carbs.should.equal(22);
    String(docs.b._id).should.equal(String(s.b._id));
  });

  it('entries, API v1: a re-send of B merges into B, not A, and names B', async function () {
    var s = await seed('entries');
    var res = await request(self.app).post('/api/entries/').set('api-secret', known)
      .send([{ identifier: ID, type: 'sgv', sgv: 121, date: T_B, dateString: iso(T_B), half: 'b' }]).expect(200);
    var docs = byHalf(await stored('entries'));
    Object.keys(docs).length.should.equal(2);
    docs.a.sgv.should.equal(100);
    docs.b.sgv.should.equal(121);
    String(res.body[0]._id).should.equal(String(s.b._id));
    dedupeLines().length.should.equal(1);
    dedupeLines()[0].should.containEql('entries v1/internal re-send');
  });

  it('device status, API v1: a re-send of B writes nothing and names B', async function () {
    var s = await seed('devicestatus');
    var before = await stored('devicestatus');
    var res = await request(self.app).post('/api/devicestatus/').set('api-secret', known)
      .send([{ identifier: ID, device: 'p4-test', created_at: iso(T_B), uploaderBattery: 50 }]).expect(200);
    var docs = await stored('devicestatus');
    // CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): the re-send is merged
    // into B, the one P4 picks (it was answered without a write); A is as it was.
    docs.length.should.equal(2);
    var a = docs.find(function (d) { return String(d._id) === String(s.a._id); });
    var b = docs.find(function (d) { return String(d._id) === String(s.b._id); });
    a.should.eql(before.find(function (d) { return String(d._id) === String(s.a._id); }));
    b.uploaderBattery.should.equal(50);
    b.half.should.equal('b');
    should.exist(b.srvModified);
    String(res.body[0]._id).should.equal(String(s.b._id));
    dedupeLines().length.should.equal(1);
    dedupeLines()[0].should.containEql('devicestatus v1/internal re-send');
  });

  it('one record with the identifier: the write lands on it, and nothing is logged', async function () {
    await col('treatments').insertOne({ identifier: ID, eventType: 'Carb Correction', carbs: 12, created_at: iso(T_A), half: 'a' });
    await request(self.app).post('/api/treatments/').set('api-secret', known)
      .send([{ identifier: ID, eventType: 'Carb Correction', carbs: 15, created_at: iso(T_B), half: 'a' }]).expect(200);
    var docs = await stored('treatments');
    docs.length.should.equal(1);
    docs[0].carbs.should.equal(15);
    dedupeLines().should.eql([]);
    should.exist(docs[0].identifier);
  });
});
