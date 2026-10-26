'use strict';

// GET /api/v1/entries/<id> for an id that names no entry (BF-129).
//
// A 24-hex id that names no stored entry is a read that matched nothing, and
// answers 200 with [] like every other v1 read that matches nothing
// (GET /entries.json?find[_id]=<id>, /treatments.json?find[_id]=<id>, ...).
// Only a storage fault answers 500. The id may be written in either case and
// may name an entry stored under an ObjectId or under the hex string itself
// (as 15.0.6 and earlier stored it).

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('entries: GET /entries/<id> for an id that names no entry (BF-129)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var DEVICE = 'bf129-unknown-id-test';

  var HEX = {
    oid: '5f32abcdef0000000000d001'
    , strLower: '5f32abcdef0000000000d002'
    , strUpper: '5F32ABCDEF0000000000D003'
    , deleted: '5f32abcdef0000000000d004'
    // names nothing; differs from the stored ids in one digit
    , unknown: '5f32abcdef0000000000d00f'
  };

  // Synthetic values only.
  function sampleEntry (minute, id) {
    var date = Date.UTC(2021, 4, 6, 7, minute);
    return {
      _id: id
      , type: 'sgv'
      , sgv: 100 + minute
      , date: date
      , dateString: new Date(date).toISOString()
      , sysTime: new Date(date).toISOString()
      , device: DEVICE
    };
  }

  function collection () {
    return self.ctx.store.collection(self.env.entries_collection);
  }

  function get (url) {
    return request(self.app).get(url).set('api-secret', known).set('Accept', 'application/json');
  }

  function dropAll () {
    return collection().deleteMany({ device: DEVICE });
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
      dropAll().then(function () {
        return collection().insertMany([
          sampleEntry(1, new ObjectID(HEX.oid))
          , sampleEntry(2, HEX.strLower)
          , sampleEntry(3, HEX.strUpper)
          , sampleEntry(4, new ObjectID(HEX.deleted))
        ]);
      }).then(function () { done(); }, done);
    });
  });

  after(function () {
    return dropAll();
  });

  describe('an id that names no entry answers 200 with []', function () {
    it('lower-case unknown id', async function () {
      var res = await get('/api/entries/' + HEX.unknown + '.json').expect(200);
      res.body.should.be.an.Array().and.have.length(0);
    });

    it('upper-case unknown id', async function () {
      var res = await get('/api/entries/' + HEX.unknown.toUpperCase() + '.json').expect(200);
      res.body.should.be.an.Array().and.have.length(0);
    });

    it('unknown id without an extension', async function () {
      var res = await get('/api/entries/' + HEX.unknown).expect(200);
      res.body.should.be.an.Array().and.have.length(0);
    });

    it('unknown id as .csv answers 200 with an empty body', async function () {
      var res = await request(self.app).get('/api/entries/' + HEX.unknown + '.csv').set('api-secret', known).expect(200);
      res.text.should.equal('');
    });

    it('an id whose entry was deleted', async function () {
      (await get('/api/entries/' + HEX.deleted + '.json').expect(200)).body.should.have.length(1);
      await request(self.app).delete('/api/entries/' + HEX.deleted).set('api-secret', known).expect(200);
      var res = await get('/api/entries/' + HEX.deleted + '.json').expect(200);
      res.body.should.be.an.Array().and.have.length(0);
    });

    it('matches what find[_id] answers for the same id (control)', async function () {
      var res = await get('/api/entries.json?find[_id]=' + HEX.unknown).expect(200);
      res.body.should.be.an.Array().and.have.length(0);
    });
  });

  describe('an id that names an entry still returns it (controls)', function () {
    it('ObjectId-stored, lower-case id', async function () {
      var res = await get('/api/entries/' + HEX.oid + '.json').expect(200);
      res.body.should.have.length(1);
      res.body[0].sgv.should.equal(101);
    });

    it('ObjectId-stored, upper-case id', async function () {
      var res = await get('/api/entries/' + HEX.oid.toUpperCase() + '.json').expect(200);
      res.body.should.have.length(1);
      res.body[0].sgv.should.equal(101);
    });

    it('string-stored lower-case, lower-case id', async function () {
      var res = await get('/api/entries/' + HEX.strLower + '.json').expect(200);
      res.body.should.have.length(1);
      res.body[0].sgv.should.equal(102);
    });

    it('string-stored upper-case, upper-case id', async function () {
      var res = await get('/api/entries/' + HEX.strUpper + '.json').expect(200);
      res.body.should.have.length(1);
      res.body[0].sgv.should.equal(103);
    });
  });

  describe('a storage fault still answers 500 (control)', function () {
    it('getEntry failing answers 500, not 200 []', async function () {
      var original = self.ctx.entries.getEntry;
      self.ctx.entries.getEntry = function (id, fn) {
        fn(new Error('synthetic storage fault'));
      };
      try {
        var res = await get('/api/entries/' + HEX.unknown + '.json');
        res.status.should.equal(500);
        res.body.should.not.be.an.Array();
      } finally {
        self.ctx.entries.getEntry = original;
      }
      // restored: the same request answers 200 [] again
      (await get('/api/entries/' + HEX.unknown + '.json').expect(200)).body.should.have.length(0);
    });
  });
});
