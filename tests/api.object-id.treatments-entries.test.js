'use strict';

// Treatments and entries stored with a string `_id` by 15.0.6 and earlier.
//
// Since 15.0.7 a treatment or entry POSTed with a 24-hex `_id` is stored with
// the ObjectId it names. 15.0.6 and earlier stored the same `_id` as the
// string itself, so a site upgraded from those releases may hold treatments
// and entries whose `_id` is a string. PUT, DELETE and find[_id] look the
// `_id` up as an ObjectId only, so those records could not be found or deleted
// by `_id`, and an edit added a second record beside the original.
//
// These tests seed string `_id` records directly, as an upgraded site holds
// them, and find, edit and delete them through the v1 API.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('treatments and entries: records stored with a string _id', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  var HEX = {
    tFind: '5f2100000000000000000b01'
    , tPut: '5f2100000000000000000b02'
    , tDelete: '5f2100000000000000000b03'
    , tTwinsPut: '5f2100000000000000000b04'
    , tTwinsDelete: '5f2100000000000000000b05'
    , tRepost: '5f2100000000000000000b06'
    , tRepostArray: '5f2100000000000000000b07'
    , tUpper: '5F2100000000000000000B08'
    , tRepostPreBolus: '5f2100000000000000000b09'
    , tNew: '5f2100000000000000000a01'
    , eFind: '5f2200000000000000000b01'
    , eGet: '5f2200000000000000000b02'
    , eDelete: '5f2200000000000000000b03'
    , eTwinsDelete: '5f2200000000000000000b04'
    , eNew: '5f2200000000000000000a01'
  };

  // Synthetic values only.
  function sampleTreatment (minute, extra) {
    return Object.assign({
      eventType: 'Note'
      , notes: 'object-id-test'
      , created_at: new Date(Date.UTC(2021, 2, 4, 3, minute)).toISOString()
    }, extra || {});
  }

  function sampleEntry (minute, extra) {
    var date = Date.UTC(2021, 2, 4, 4, minute);
    return Object.assign({
      type: 'sgv'
      , sgv: 100 + minute
      , date: date
      , dateString: new Date(date).toISOString()
      , device: 'object-id-test'
    }, extra || {});
  }

  function collection (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  function storedFor (name, hex) {
    return collection(name).find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function dropAll () {
    var ids = [];
    Object.keys(HEX).forEach(function (k) {
      ids.push(new ObjectID(HEX[k]), HEX[k], HEX[k].toLowerCase());
    });
    return Promise.all([
      collection('treatments').deleteMany({ $or: [{ _id: { $in: ids } }, { notes: 'object-id-test' }] })
      , collection('entries').deleteMany({ $or: [{ _id: { $in: ids } }, { device: 'object-id-test' }] })
    ]);
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

  describe('treatments', function () {

    function findById (hex) {
      return request(self.app)
        .get('/api/treatments/')
        .query({ 'find[_id]': hex })
        .set('api-secret', known)
        .expect(200);
    }

    function put (doc) {
      return request(self.app)
        .put('/api/treatments/')
        .set('api-secret', known)
        .send(doc)
        .expect(200);
    }

    function deleteById (hex) {
      return request(self.app)
        .delete('/api/treatments/' + hex)
        .set('api-secret', known)
        .expect(200);
    }

    it('is found by find[_id]', async function () {
      await collection('treatments').insertOne(sampleTreatment(1, { _id: HEX.tFind }));
      var res = await findById(HEX.tFind);
      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(HEX.tFind);
    });

    it('is replaced by a PUT of the same _id, leaving one ObjectId record with the new content', async function () {
      await collection('treatments').insertOne(sampleTreatment(2, { _id: HEX.tPut }));
      await put(sampleTreatment(2, { _id: HEX.tPut, notes: 'object-id-test', carbs: 12 }));
      var stored = await storedFor('treatments', HEX.tPut);
      stored.length.should.equal(1, 'records holding this _id after the PUT');
      stored[0].carbs.should.equal(12);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });

    it('is removed by DELETE /treatments/:id', async function () {
      await collection('treatments').insertOne(sampleTreatment(3, { _id: HEX.tDelete }));
      await deleteById(HEX.tDelete);
      (await storedFor('treatments', HEX.tDelete)).length.should.equal(0, 'records holding this _id after the DELETE');
    });

    it('with an ObjectId twin left by an earlier edit collapses to one record on the next PUT', async function () {
      await collection('treatments').insertOne(sampleTreatment(4, { _id: HEX.tTwinsPut }));
      await collection('treatments').insertOne(sampleTreatment(4, { _id: new ObjectID(HEX.tTwinsPut) }));
      (await findById(HEX.tTwinsPut)).body.length.should.equal(2);
      await put(sampleTreatment(4, { _id: HEX.tTwinsPut, carbs: 20 }));
      var stored = await storedFor('treatments', HEX.tTwinsPut);
      stored.length.should.equal(1, 'records holding this _id after the PUT');
      stored[0].carbs.should.equal(20);
    });

    it('with an ObjectId twin is removed entirely by DELETE /treatments/:id', async function () {
      await collection('treatments').insertOne(sampleTreatment(5, { _id: HEX.tTwinsDelete }));
      await collection('treatments').insertOne(sampleTreatment(5, { _id: new ObjectID(HEX.tTwinsDelete) }));
      await deleteById(HEX.tTwinsDelete);
      (await storedFor('treatments', HEX.tTwinsDelete)).length.should.equal(0, 'records holding this _id after the DELETE');
    });

    it('is replaced, not copied, by a POST of the same _id', async function () {
      // POST /treatments upserts by _id when a record carries one.
      await collection('treatments').insertOne(sampleTreatment(6, { _id: HEX.tRepost }));
      await request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send(sampleTreatment(6, { _id: HEX.tRepost, carbs: 30 }))
        .expect(200);
      var stored = await storedFor('treatments', HEX.tRepost);
      stored.length.should.equal(1, 'records holding this _id after the POST');
      stored[0].carbs.should.equal(30);
    });

    it('is replaced, not copied, by an array POST of the same _id', async function () {
      await collection('treatments').insertOne(sampleTreatment(7, { _id: HEX.tRepostArray }));
      await request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([sampleTreatment(7, { _id: HEX.tRepostArray, carbs: 31 }), sampleTreatment(8)])
        .expect(200);
      var stored = await storedFor('treatments', HEX.tRepostArray);
      stored.length.should.equal(1, 'records holding this _id after the POST');
      stored[0].carbs.should.equal(31);
    });

    it('is replaced, not copied, by a POST of the same _id with a preBolus', async function () {
      // A preBolus sends the batch through the one-record-at-a-time path.
      await collection('treatments').insertOne(sampleTreatment(11, { _id: HEX.tRepostPreBolus }));
      await request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send([sampleTreatment(11, { _id: HEX.tRepostPreBolus, eventType: 'Meal Bolus', insulin: 1.5, carbs: 32, preBolus: 15 })])
        .expect(200);
      var stored = await storedFor('treatments', HEX.tRepostPreBolus);
      stored.length.should.equal(1, 'records holding this _id after the POST');
      stored[0].insulin.should.equal(1.5);
    });

    it('stored in upper case is found, replaced by a PUT and removed by DELETE', async function () {
      await collection('treatments').insertOne(sampleTreatment(9, { _id: HEX.tUpper }));
      (await findById(HEX.tUpper)).body.length.should.equal(1);
      await put(sampleTreatment(9, { _id: HEX.tUpper, carbs: 40 }));
      var stored = await storedFor('treatments', HEX.tUpper);
      stored.length.should.equal(1, 'records holding this _id after the PUT');
      stored[0].carbs.should.equal(40);
      await deleteById(HEX.tUpper);
      (await storedFor('treatments', HEX.tUpper)).length.should.equal(0, 'records holding this _id after the DELETE');
    });

    it('a new treatment POSTed with a 24-hex _id is still stored with that ObjectId', async function () {
      await request(self.app)
        .post('/api/treatments/')
        .set('api-secret', known)
        .send(sampleTreatment(10, { _id: HEX.tNew }))
        .expect(200);
      var stored = await storedFor('treatments', HEX.tNew);
      stored.length.should.equal(1);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });
  });

  describe('entries', function () {

    it('is found by find[_id]', async function () {
      await collection('entries').insertOne(sampleEntry(1, { _id: HEX.eFind }));
      var res = await request(self.app)
        .get('/api/entries.json')
        .query({ 'find[_id]': HEX.eFind })
        .set('api-secret', known)
        .expect(200);
      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(HEX.eFind);
    });

    it('is returned by GET /entries/:id', async function () {
      await collection('entries').insertOne(sampleEntry(2, { _id: HEX.eGet }));
      var res = await request(self.app)
        .get('/api/entries/' + HEX.eGet + '.json')
        .set('api-secret', known)
        .expect(200);
      res.body.length.should.equal(1);
      String(res.body[0]._id).should.equal(HEX.eGet);
    });

    it('is removed by DELETE /entries/:id', async function () {
      await collection('entries').insertOne(sampleEntry(3, { _id: HEX.eDelete }));
      await request(self.app)
        .delete('/api/entries/' + HEX.eDelete)
        .set('api-secret', known)
        .expect(200);
      (await storedFor('entries', HEX.eDelete)).length.should.equal(0, 'records holding this _id after the DELETE');
    });

    it('with an ObjectId twin is removed entirely by DELETE /entries/:id', async function () {
      await collection('entries').insertOne(sampleEntry(4, { _id: HEX.eTwinsDelete }));
      await collection('entries').insertOne(sampleEntry(5, { _id: new ObjectID(HEX.eTwinsDelete) }));
      await request(self.app)
        .delete('/api/entries/' + HEX.eTwinsDelete)
        .set('api-secret', known)
        .expect(200);
      (await storedFor('entries', HEX.eTwinsDelete)).length.should.equal(0, 'records holding this _id after the DELETE');
    });

    it('a new entry POSTed with a 24-hex _id is still stored with that ObjectId', async function () {
      await request(self.app)
        .post('/api/entries/')
        .set('api-secret', known)
        .send([sampleEntry(6, { _id: HEX.eNew })])
        .expect(200);
      var stored = await storedFor('entries', HEX.eNew);
      stored.length.should.equal(1);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });
  });
});
