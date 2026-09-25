'use strict';

// A profile's `_id` is stored as a MongoDB ObjectId, whichever way it arrives.
//
// POST /api/v1/profile stored a 24-hex `_id` exactly as sent, as a string,
// while every other profile path (PUT, DELETE, find[_id]) looks the `_id` up
// as an ObjectId. A profile created with its own `_id` - as the Nightscout
// connector does when it copies profiles from another site - could then not
// be found by `_id`, could not be deleted, and an edit of it added a second
// profile beside the first instead of replacing it.
//
// Profiles already stored that way must be manageable through the API with no
// database step, so the second half of this file seeds string `_id` profiles
// directly and edits, finds and deletes them.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('Profiles API: _id is stored and matched as an ObjectId', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  // Distinct, recognisable ids so each test only ever sees its own documents.
  var HEX = {
    created: '5f1a00000000000000000a01'
    , array1: '5f1a00000000000000000a02'
    , array2: '5f1a00000000000000000a03'
    , legacy: '5f1a00000000000000000b01'
    , legacyDelete: '5f1a00000000000000000b02'
    , twins: '5f1a00000000000000000b03'
    , twinsDelete: '5f1a00000000000000000b05'
    , legacyUpper: '5F1A00000000000000000B04'
    , legacyRepost: '5f1a00000000000000000b06'
  };

  function sampleProfile (dia, extra) {
    // Synthetic values only.
    return Object.assign({
      defaultProfile: 'Default'
      , store: {
        Default: {
          dia: dia
          , carbratio: [{ time: '00:00', value: 30, timeAsSeconds: 0 }]
          , sens: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , basal: [{ time: '00:00', value: 0.1, timeAsSeconds: 0 }]
          , target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , target_high: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , timezone: 'UTC'
          , units: 'mg/dl'
        }
      }
      , startDate: '2021-03-04T00:00:00.000Z'
      , units: 'mg/dl'
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.profile_collection);
  }

  // Every stored document for this id, whichever type its _id has.
  function storedFor (hex) {
    return collection().find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function dropAll () {
    var ids = [];
    Object.keys(HEX).forEach(function (k) {
      ids.push(new ObjectID(HEX[k]), HEX[k], HEX[k].toLowerCase());
    });
    return collection().deleteMany({ _id: { $in: ids } });
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

  describe('a profile created with a 24-hex string _id', function () {

    it('is stored with an ObjectId _id', async function () {
      await request(self.app)
        .post('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(5, { _id: HEX.created }))
        .expect(200);

      var stored = await storedFor(HEX.created);
      stored.length.should.equal(1);
      (stored[0]._id instanceof ObjectID).should.equal(true, 'stored _id is a ' + typeof stored[0]._id);
      stored[0]._id.toHexString().should.equal(HEX.created);
    });

    it('is found by find[_id]', async function () {
      var res = await request(self.app)
        .get('/api/profiles/')
        .query({ 'find[_id]': HEX.created })
        .set('api-secret', known)
        .expect(200);

      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(HEX.created);
    });

    it('is replaced by a PUT of the same _id, leaving one document with the new content', async function () {
      await request(self.app)
        .put('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(6, { _id: HEX.created }))
        .expect(200);

      var stored = await storedFor(HEX.created);
      stored.length.should.equal(1, 'documents holding this _id after the PUT');
      stored[0].store.Default.dia.should.equal(6);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });

    it('is removed by DELETE /profile/:_id', async function () {
      await request(self.app)
        .delete('/api/profile/' + HEX.created)
        .set('api-secret', known)
        .expect(200);

      var stored = await storedFor(HEX.created);
      stored.length.should.equal(0, 'documents holding this _id after the DELETE');
    });

    it('is stored with an ObjectId _id for each element of an array POST', async function () {
      await request(self.app)
        .post('/api/profile/')
        .set('api-secret', known)
        .send([
          sampleProfile(5, { _id: HEX.array1 })
          , sampleProfile(5, { _id: HEX.array2, startDate: '2021-03-05T00:00:00.000Z' })
        ])
        .expect(200);

      var first = await storedFor(HEX.array1);
      var second = await storedFor(HEX.array2);
      first.length.should.equal(1);
      second.length.should.equal(1);
      (first[0]._id instanceof ObjectID).should.equal(true);
      (second[0]._id instanceof ObjectID).should.equal(true);
    });
  });

  describe('a profile created without an _id', function () {

    it('is still given a new ObjectId _id', async function () {
      var res = await request(self.app)
        .post('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(5, { startDate: '2021-03-06T00:00:00.000Z' }))
        .expect(200);

      res.body.length.should.equal(1);
      var id = String(res.body[0]._id);
      id.should.match(/^[0-9a-f]{24}$/);
      var stored = await collection().find({ _id: new ObjectID(id) }).toArray();
      stored.length.should.equal(1);
      await collection().deleteOne({ _id: new ObjectID(id) });
    });
  });

  describe('a profile already stored with a string _id', function () {

    it('is found by find[_id]', async function () {
      await collection().insertOne(sampleProfile(5, { _id: HEX.legacy }));

      var res = await request(self.app)
        .get('/api/profiles/')
        .query({ 'find[_id]': HEX.legacy })
        .set('api-secret', known)
        .expect(200);

      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(HEX.legacy);
    });

    it('is replaced by a PUT of the same _id, leaving one ObjectId document with the new content', async function () {
      await request(self.app)
        .put('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(6, { _id: HEX.legacy }))
        .expect(200);

      var stored = await storedFor(HEX.legacy);
      stored.length.should.equal(1, 'documents holding this _id after the PUT');
      stored[0].store.Default.dia.should.equal(6);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });

    it('is removed by DELETE /profile/:_id', async function () {
      await collection().insertOne(sampleProfile(5, { _id: HEX.legacyDelete }));

      await request(self.app)
        .delete('/api/profile/' + HEX.legacyDelete)
        .set('api-secret', known)
        .expect(200);

      var stored = await storedFor(HEX.legacyDelete);
      stored.length.should.equal(0, 'documents holding this _id after the DELETE');
    });

    it('stored in upper case is found, replaced by a PUT and removed by DELETE', async function () {
      await collection().insertOne(sampleProfile(5, { _id: HEX.legacyUpper }));

      var found = await request(self.app)
        .get('/api/profiles/')
        .query({ 'find[_id]': HEX.legacyUpper })
        .set('api-secret', known)
        .expect(200);
      found.body.length.should.equal(1);

      await request(self.app)
        .put('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(6, { _id: HEX.legacyUpper }))
        .expect(200);

      var stored = await storedFor(HEX.legacyUpper);
      stored.length.should.equal(1, 'documents holding this _id after the PUT');
      stored[0].store.Default.dia.should.equal(6);

      await request(self.app)
        .delete('/api/profile/' + HEX.legacyUpper)
        .set('api-secret', known)
        .expect(200);

      (await storedFor(HEX.legacyUpper)).length.should.equal(0, 'documents holding this _id after the DELETE');
    });

    it('is not copied by a POST of the same _id', async function () {
      // A sync client re-sending a profile the site already stores (as the
      // Nightscout connector does on every poll) must not now add an
      // ObjectId copy beside the string original. The POST fails on the
      // duplicate _id, exactly as it did before profiles were converted.
      await collection().insertOne(sampleProfile(5, { _id: HEX.legacyRepost }));

      await request(self.app)
        .post('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(5, { _id: HEX.legacyRepost }))
        .expect(500);

      var stored = await storedFor(HEX.legacyRepost);
      stored.length.should.equal(1, 'documents holding this _id after the POST');
      (typeof stored[0]._id).should.equal('string');
    });

    it('with an ObjectId twin left by an earlier edit collapses to one document on the next PUT', async function () {
      // The state an operator is left in by an edit made before this fix:
      // the original string-_id profile and the ObjectId copy the edit added.
      await collection().insertOne(sampleProfile(5, { _id: HEX.twins }));
      await collection().insertOne(sampleProfile(6, { _id: new ObjectID(HEX.twins) }));
      (await storedFor(HEX.twins)).length.should.equal(2);

      await request(self.app)
        .put('/api/profile/')
        .set('api-secret', known)
        .send(sampleProfile(7, { _id: HEX.twins }))
        .expect(200);

      var stored = await storedFor(HEX.twins);
      stored.length.should.equal(1, 'documents holding this _id after the PUT');
      stored[0].store.Default.dia.should.equal(7);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });

    it('with an ObjectId twin is removed entirely by DELETE /profile/:_id', async function () {
      await collection().insertOne(sampleProfile(5, { _id: HEX.twinsDelete }));
      await collection().insertOne(sampleProfile(6, { _id: new ObjectID(HEX.twinsDelete) }));
      (await storedFor(HEX.twinsDelete)).length.should.equal(2);

      await request(self.app)
        .delete('/api/profile/' + HEX.twinsDelete)
        .set('api-secret', known)
        .expect(200);

      (await storedFor(HEX.twinsDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
    });
  });
});
