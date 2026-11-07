'use strict';

// GET and DELETE /api/v1/entries/<id> accept an id written in upper case.
//
// A 24-hex id names the same ObjectId in either case, and every other v1 path
// accepts both: find[_id], the _id checks on the devicestatus, food, activity
// and profile routes, the websocket, and API v3. /entries/:spec alone tested
// for lower-case hex, so an upper-case id was taken for a model name (an entry
// `type`): GET answered an empty list and DELETE removed nothing.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('entries: /entries/<id> in upper case', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  var HEX = {
    get: '5f32abcdef0000000000b001'
    , del: '5f32abcdef0000000000b002'
    , upperStored: '5F32ABCDEF0000000000B003'
    , lower: '5f32abcdef0000000000b004'
  };

  // Synthetic values only.
  function sampleEntry (minute, id) {
    var date = Date.UTC(2021, 4, 6, 6, minute);
    return {
      _id: id
      , type: 'sgv'
      , sgv: 100 + minute
      , date: date
      , dateString: new Date(date).toISOString()
      , sysTime: new Date(date).toISOString()
      , device: 'upper-case-id-test'
    };
  }

  function collection () {
    return self.ctx.store.collection(self.env.entries_collection);
  }

  function getJson (url) {
    return request(self.app).get(url).set('api-secret', known).set('Accept', 'application/json');
  }

  function dropAll () {
    return collection().deleteMany({ device: 'upper-case-id-test' });
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
      dropAll().then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  it('GET /entries/<UPPER-CASE HEX> returns the entry stored with that ObjectId', async function () {
    await collection().insertOne(sampleEntry(1, new ObjectID(HEX.get)));
    var res = await getJson('/api/entries/' + HEX.get.toUpperCase()).expect(200);
    res.body.length.should.equal(1);
    res.body[0].sgv.should.equal(101);
  });

  it('DELETE /entries/<UPPER-CASE HEX> removes the entry stored with that ObjectId', async function () {
    await collection().insertOne(sampleEntry(2, new ObjectID(HEX.del)));
    await request(self.app).delete('/api/entries/' + HEX.del.toUpperCase()).set('api-secret', known).expect(200);
    (await collection().countDocuments({ _id: new ObjectID(HEX.del) })).should.equal(0);
  });

  it('GET /entries/<UPPER-CASE HEX> returns an entry stored with that upper-case string', async function () {
    await collection().insertOne(sampleEntry(3, HEX.upperStored));
    var res = await getJson('/api/entries/' + HEX.upperStored).expect(200);
    res.body.length.should.equal(1);
    res.body[0].sgv.should.equal(103);
  });

  it('GET /entries/<lower-case hex> still returns the entry (control)', async function () {
    await collection().insertOne(sampleEntry(4, new ObjectID(HEX.lower)));
    var res = await getJson('/api/entries/' + HEX.lower).expect(200);
    res.body.length.should.equal(1);
    res.body[0].sgv.should.equal(104);
  });

  it('GET /entries/sgv is still a model name (control)', async function () {
    var res = await getJson('/api/entries/sgv?find[device]=upper-case-id-test&find[date][$gte]=0&count=10').expect(200);
    res.body.length.should.be.above(0);
    res.body.forEach(function (e) { e.type.should.equal('sgv'); });
  });
});
