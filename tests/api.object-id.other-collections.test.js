'use strict';

// devicestatus, food and activity records keep their `_id` as a MongoDB
// ObjectId, whichever way it arrives.
//
// POST stored a 24-hex `_id` exactly as sent, as a string, while PUT, DELETE
// and find[_id] look the `_id` up as an ObjectId. A record created with its
// own `_id` - as a sync client or the Nightscout connector may send it - could
// then not be found or deleted by that `_id`, and a food or activity edit
// added a second record beside the first instead of replacing it.
//
// Records already stored that way must be manageable through the API with no
// database step, so each collection also seeds string `_id` records directly
// and edits, finds and deletes them.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('devicestatus, food and activity: _id is stored and matched as an ObjectId', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  // Distinct, recognisable ids so each test only ever sees its own documents.
  var HEX = {
    dsCreated: '5f1b00000000000000000a01'
    , dsArray1: '5f1b00000000000000000a02'
    , dsArray2: '5f1b00000000000000000a03'
    , dsLegacy: '5f1b00000000000000000b01'
    , dsLegacyDelete: '5f1b00000000000000000b02'
    , dsTwins: '5f1b00000000000000000b03'
    , dsLegacyUpper: '5F1B00000000000000000B04'
    , foodCreated: '5f1c00000000000000000a01'
    , foodArray1: '5f1c00000000000000000a02'
    , foodArray2: '5f1c00000000000000000a03'
    , foodLegacy: '5f1c00000000000000000b01'
    , foodLegacyDelete: '5f1c00000000000000000b02'
    , foodTwins: '5f1c00000000000000000b03'
    , foodTwinsDelete: '5f1c00000000000000000b05'
    , foodLegacyRepost: '5f1c00000000000000000b06'
    , foodLegacyUpper: '5F1C00000000000000000B04'
    , actCreated: '5f1d00000000000000000a01'
    , actLegacy: '5f1d00000000000000000b01'
    , actLegacyDelete: '5f1d00000000000000000b02'
    , actTwins: '5f1d00000000000000000b03'
    , actTwinsDelete: '5f1d00000000000000000b05'
    , actLegacyRepost: '5f1d00000000000000000b06'
    , actLegacyUpper: '5F1D00000000000000000B04'
  };

  // Synthetic values only.
  function sampleStatus (extra) {
    return Object.assign({
      device: 'object-id-test'
      , created_at: '2021-03-04T00:00:00.000Z'
      , uploaderBattery: 50
    }, extra || {});
  }

  function sampleFood (carbs, extra) {
    return Object.assign({
      type: 'food'
      , category: 'object-id-test'
      , name: 'a food'
      , portion: 1
      , unit: 'g'
      , carbs: carbs
    }, extra || {});
  }

  function sampleActivity (steps, extra) {
    return Object.assign({
      created_at: '2021-03-04T00:00:00.000Z'
      , heartrate: 90
      , steps: steps
      , activitylevel: 'object-id-test'
    }, extra || {});
  }

  function collection (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  // Every stored document for this id, whichever type its _id has.
  function storedFor (name, hex) {
    return collection(name).find({ _id: { $in: [new ObjectID(hex), hex, hex.toLowerCase()] } }).toArray();
  }

  function dropAll () {
    var ids = [];
    Object.keys(HEX).forEach(function (k) {
      ids.push(new ObjectID(HEX[k]), HEX[k], HEX[k].toLowerCase());
    });
    var filter = { _id: { $in: ids } };
    return Promise.all([
      collection('devicestatus').deleteMany(filter)
      , collection('food').deleteMany(filter)
      , collection('activity').deleteMany(filter)
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

  describe('devicestatus', function () {

    function findById (hex) {
      return request(self.app)
        .get('/api/devicestatus/')
        .query({ 'find[_id]': hex })
        .set('api-secret', known)
        .expect(200);
    }

    function deleteById (hex) {
      return request(self.app)
        .delete('/api/devicestatus/' + hex)
        .set('api-secret', known)
        .expect(200);
    }

    describe('created with a 24-hex string _id', function () {

      it('is stored with an ObjectId _id', async function () {
        await request(self.app)
          .post('/api/devicestatus/')
          .set('api-secret', known)
          .send(sampleStatus({ _id: HEX.dsCreated }))
          .expect(200);

        var stored = await storedFor('devicestatus', HEX.dsCreated);
        stored.length.should.equal(1);
        (stored[0]._id instanceof ObjectID).should.equal(true, 'stored _id is a ' + typeof stored[0]._id);
        stored[0]._id.toHexString().should.equal(HEX.dsCreated);
      });

      it('is found by find[_id]', async function () {
        var res = await findById(HEX.dsCreated);
        res.body.length.should.equal(1);
        String(res.body[0]._id).should.equal(HEX.dsCreated);
      });

      it('is removed by DELETE /devicestatus/:id', async function () {
        await deleteById(HEX.dsCreated);
        (await storedFor('devicestatus', HEX.dsCreated)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('is stored with an ObjectId _id for each element of an array POST', async function () {
        await request(self.app)
          .post('/api/devicestatus/')
          .set('api-secret', known)
          .send([
            sampleStatus({ _id: HEX.dsArray1 })
            , sampleStatus({ _id: HEX.dsArray2, created_at: '2021-03-04T00:05:00.000Z' })
          ])
          .expect(200);

        var first = await storedFor('devicestatus', HEX.dsArray1);
        var second = await storedFor('devicestatus', HEX.dsArray2);
        first.length.should.equal(1);
        second.length.should.equal(1);
        (first[0]._id instanceof ObjectID).should.equal(true);
        (second[0]._id instanceof ObjectID).should.equal(true);
      });
    });

    it('created without an _id is still given a new ObjectId _id', async function () {
      var res = await request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', known)
        .send(sampleStatus({ created_at: '2021-03-04T00:10:00.000Z' }))
        .expect(200);

      var id = String(res.body[0]._id);
      id.should.match(/^[0-9a-f]{24}$/);
      (await collection('devicestatus').find({ _id: new ObjectID(id) }).toArray()).length.should.equal(1);
      await collection('devicestatus').deleteOne({ _id: new ObjectID(id) });
    });

    describe('already stored with a string _id', function () {

      it('is found by find[_id]', async function () {
        await collection('devicestatus').insertOne(sampleStatus({ _id: HEX.dsLegacy }));
        var res = await findById(HEX.dsLegacy);
        res.body.length.should.equal(1);
        String(res.body[0]._id).should.equal(HEX.dsLegacy);
      });

      it('is removed by DELETE /devicestatus/:id', async function () {
        await collection('devicestatus').insertOne(sampleStatus({ _id: HEX.dsLegacyDelete }));
        await deleteById(HEX.dsLegacyDelete);
        (await storedFor('devicestatus', HEX.dsLegacyDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('stored in upper case is found and removed', async function () {
        await collection('devicestatus').insertOne(sampleStatus({ _id: HEX.dsLegacyUpper }));
        (await findById(HEX.dsLegacyUpper)).body.length.should.equal(1);
        await deleteById(HEX.dsLegacyUpper);
        (await storedFor('devicestatus', HEX.dsLegacyUpper)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('with an ObjectId twin is found as both and removed entirely by DELETE', async function () {
        await collection('devicestatus').insertOne(sampleStatus({ _id: HEX.dsTwins }));
        await collection('devicestatus').insertOne(sampleStatus({ _id: new ObjectID(HEX.dsTwins) }));
        (await findById(HEX.dsTwins)).body.length.should.equal(2);
        await deleteById(HEX.dsTwins);
        (await storedFor('devicestatus', HEX.dsTwins)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });
    });
  });

  describe('food', function () {

    function putFood (doc) {
      return request(self.app)
        .put('/api/food/')
        .set('api-secret', known)
        .send(doc)
        .expect(200);
    }

    function deleteById (hex) {
      return request(self.app)
        .delete('/api/food/' + hex)
        .set('api-secret', known)
        .expect(200);
    }

    describe('created with a 24-hex string _id', function () {

      it('is stored with an ObjectId _id', async function () {
        await request(self.app)
          .post('/api/food/')
          .set('api-secret', known)
          .send(sampleFood(10, { _id: HEX.foodCreated }))
          .expect(200);

        var stored = await storedFor('food', HEX.foodCreated);
        stored.length.should.equal(1);
        (stored[0]._id instanceof ObjectID).should.equal(true, 'stored _id is a ' + typeof stored[0]._id);
      });

      it('is replaced by a PUT of the same _id, leaving one document with the new content', async function () {
        await putFood(sampleFood(20, { _id: HEX.foodCreated }));
        var stored = await storedFor('food', HEX.foodCreated);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].carbs.should.equal(20);
        (stored[0]._id instanceof ObjectID).should.equal(true);
      });

      it('is removed by DELETE /food/:_id', async function () {
        await deleteById(HEX.foodCreated);
        (await storedFor('food', HEX.foodCreated)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('is stored with an ObjectId _id for each element of an array POST', async function () {
        await request(self.app)
          .post('/api/food/')
          .set('api-secret', known)
          .send([sampleFood(10, { _id: HEX.foodArray1 }), sampleFood(11, { _id: HEX.foodArray2 })])
          .expect(200);

        var first = await storedFor('food', HEX.foodArray1);
        var second = await storedFor('food', HEX.foodArray2);
        first.length.should.equal(1);
        second.length.should.equal(1);
        (first[0]._id instanceof ObjectID).should.equal(true);
        (second[0]._id instanceof ObjectID).should.equal(true);
      });
    });

    it('created without an _id is still given a new ObjectId _id', async function () {
      var res = await request(self.app)
        .post('/api/food/')
        .set('api-secret', known)
        .send(sampleFood(12))
        .expect(200);

      var id = String(res.body[0]._id);
      id.should.match(/^[0-9a-f]{24}$/);
      (await collection('food').find({ _id: new ObjectID(id) }).toArray()).length.should.equal(1);
      await collection('food').deleteOne({ _id: new ObjectID(id) });
    });

    describe('already stored with a string _id', function () {

      it('is replaced by a PUT of the same _id, leaving one ObjectId document with the new content', async function () {
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodLegacy }));
        await putFood(sampleFood(20, { _id: HEX.foodLegacy }));
        var stored = await storedFor('food', HEX.foodLegacy);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].carbs.should.equal(20);
        (stored[0]._id instanceof ObjectID).should.equal(true);
      });

      it('is removed by DELETE /food/:_id', async function () {
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodLegacyDelete }));
        await deleteById(HEX.foodLegacyDelete);
        (await storedFor('food', HEX.foodLegacyDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('stored in upper case is replaced by a PUT and removed by DELETE', async function () {
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodLegacyUpper }));
        await putFood(sampleFood(20, { _id: HEX.foodLegacyUpper }));
        var stored = await storedFor('food', HEX.foodLegacyUpper);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].carbs.should.equal(20);
        await deleteById(HEX.foodLegacyUpper);
        (await storedFor('food', HEX.foodLegacyUpper)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('is replaced, not copied, by a POST of the same _id', async function () {
        // POST /food is an upsert by _id: re-sending a record replaces it.
        // That must stay true for a record stored with a string _id, rather
        // than adding an ObjectId copy beside it.
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodLegacyRepost }));
        await request(self.app)
          .post('/api/food/')
          .set('api-secret', known)
          .send(sampleFood(30, { _id: HEX.foodLegacyRepost }))
          .expect(200);

        var stored = await storedFor('food', HEX.foodLegacyRepost);
        stored.length.should.equal(1, 'documents holding this _id after the POST');
        stored[0].carbs.should.equal(30);
      });

      it('with an ObjectId twin left by an earlier edit collapses to one document on the next PUT', async function () {
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodTwins }));
        await collection('food').insertOne(sampleFood(11, { _id: new ObjectID(HEX.foodTwins) }));
        (await storedFor('food', HEX.foodTwins)).length.should.equal(2);

        await putFood(sampleFood(40, { _id: HEX.foodTwins }));
        var stored = await storedFor('food', HEX.foodTwins);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].carbs.should.equal(40);
        (stored[0]._id instanceof ObjectID).should.equal(true);
      });

      it('with an ObjectId twin is removed entirely by DELETE /food/:_id', async function () {
        await collection('food').insertOne(sampleFood(10, { _id: HEX.foodTwinsDelete }));
        await collection('food').insertOne(sampleFood(11, { _id: new ObjectID(HEX.foodTwinsDelete) }));
        await deleteById(HEX.foodTwinsDelete);
        (await storedFor('food', HEX.foodTwinsDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });
    });
  });

  describe('activity', function () {

    function findById (hex) {
      return request(self.app)
        .get('/api/activity')
        .query({ 'find[_id]': hex })
        .set('api-secret', known)
        .expect(200);
    }

    function putActivity (doc) {
      return request(self.app)
        .put('/api/activity/')
        .set('api-secret', known)
        .send(doc)
        .expect(200);
    }

    function deleteById (hex) {
      return request(self.app)
        .delete('/api/activity/' + hex)
        .set('api-secret', known)
        .expect(200);
    }

    describe('created with a 24-hex string _id', function () {

      it('is stored with an ObjectId _id', async function () {
        await request(self.app)
          .post('/api/activity/')
          .set('api-secret', known)
          .send(sampleActivity(100, { _id: HEX.actCreated }))
          .expect(200);

        var stored = await storedFor('activity', HEX.actCreated);
        stored.length.should.equal(1);
        (stored[0]._id instanceof ObjectID).should.equal(true, 'stored _id is a ' + typeof stored[0]._id);
      });

      it('is found by find[_id]', async function () {
        var res = await findById(HEX.actCreated);
        res.body.length.should.equal(1);
        String(res.body[0]._id).should.equal(HEX.actCreated);
      });

      it('is replaced by a PUT of the same _id, leaving one document with the new content', async function () {
        await putActivity(sampleActivity(200, { _id: HEX.actCreated }));
        var stored = await storedFor('activity', HEX.actCreated);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].steps.should.equal(200);
      });

      it('is removed by DELETE /activity/:_id', async function () {
        await deleteById(HEX.actCreated);
        (await storedFor('activity', HEX.actCreated)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });
    });

    describe('already stored with a string _id', function () {

      it('is found by find[_id]', async function () {
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actLegacy }));
        var res = await findById(HEX.actLegacy);
        res.body.length.should.equal(1);
        String(res.body[0]._id).should.equal(HEX.actLegacy);
      });

      it('is replaced by a PUT of the same _id, leaving one ObjectId document with the new content', async function () {
        await putActivity(sampleActivity(200, { _id: HEX.actLegacy }));
        var stored = await storedFor('activity', HEX.actLegacy);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].steps.should.equal(200);
        (stored[0]._id instanceof ObjectID).should.equal(true);
      });

      it('is removed by DELETE /activity/:_id', async function () {
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actLegacyDelete }));
        await deleteById(HEX.actLegacyDelete);
        (await storedFor('activity', HEX.actLegacyDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('stored in upper case is found, replaced by a PUT and removed by DELETE', async function () {
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actLegacyUpper }));
        (await findById(HEX.actLegacyUpper)).body.length.should.equal(1);
        await putActivity(sampleActivity(200, { _id: HEX.actLegacyUpper }));
        var stored = await storedFor('activity', HEX.actLegacyUpper);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].steps.should.equal(200);
        await deleteById(HEX.actLegacyUpper);
        (await storedFor('activity', HEX.actLegacyUpper)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });

      it('is replaced, not copied, by a POST of the same _id', async function () {
        // POST /activity is an upsert by _id, as for food.
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actLegacyRepost }));
        await request(self.app)
          .post('/api/activity/')
          .set('api-secret', known)
          .send(sampleActivity(300, { _id: HEX.actLegacyRepost }))
          .expect(200);

        var stored = await storedFor('activity', HEX.actLegacyRepost);
        stored.length.should.equal(1, 'documents holding this _id after the POST');
        stored[0].steps.should.equal(300);
      });

      it('with an ObjectId twin left by an earlier edit collapses to one document on the next PUT', async function () {
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actTwins }));
        await collection('activity').insertOne(sampleActivity(101, { _id: new ObjectID(HEX.actTwins) }));
        (await storedFor('activity', HEX.actTwins)).length.should.equal(2);

        await putActivity(sampleActivity(400, { _id: HEX.actTwins }));
        var stored = await storedFor('activity', HEX.actTwins);
        stored.length.should.equal(1, 'documents holding this _id after the PUT');
        stored[0].steps.should.equal(400);
        (stored[0]._id instanceof ObjectID).should.equal(true);
      });

      it('with an ObjectId twin is removed entirely by DELETE /activity/:_id', async function () {
        await collection('activity').insertOne(sampleActivity(100, { _id: HEX.actTwinsDelete }));
        await collection('activity').insertOne(sampleActivity(101, { _id: new ObjectID(HEX.actTwinsDelete) }));
        await deleteById(HEX.actTwinsDelete);
        (await storedFor('activity', HEX.actTwinsDelete)).length.should.equal(0, 'documents holding this _id after the DELETE');
      });
    });
  });
});
