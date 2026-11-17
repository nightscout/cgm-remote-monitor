'use strict';

// BF-221: a v1 treatments PUT announced the write (`data-received`, which
// makes the server reload its data and push it to every open page) when the
// write started, not when it finished. The reload could read the treatment
// from before the edit, so open pages showed the edit only at a later reload,
// up to about a minute after. BF-195 fixed the same order for profiles.
//
// Each PUT here is watched on the server's bus: when `data-received` fires,
// the listener reads the treatment back at once, as the reload does, and the
// edit must already be there. Several edits in a row, so a race shows.
// Through HTTP against the booted server. Synthetic values only.

var request = require('supertest');
var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('v1 treatments PUT announces the edit after it is written (BF-221)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var NOTE = 'treatments-put-announce-test';
  var ID = '5f3300000000000000000c01';
  var CREATED = '2021-08-09T10:11:00.000Z';

  function collection () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function dropAll () {
    return collection().deleteMany({ notes: NOTE });
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

  after(dropAll);

  // The carbs stored when `data-received` fires for this PUT.
  function carbsAtAnnouncement () {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        self.ctx.bus.removeListener('data-received', announced);
        reject(new Error('no data-received within 2 s of the PUT'));
      }, 2000);
      function announced () {
        clearTimeout(timer);
        collection().findOne({ _id: new ObjectID(ID) }).then(function (doc) {
          resolve(doc && doc.carbs);
        }, reject);
      }
      self.ctx.bus.once('data-received', announced);
    });
  }

  it('the reload triggered by each PUT reads the edited treatment', async function () {
    await collection().insertOne({ _id: new ObjectID(ID), eventType: 'Carb Correction', created_at: CREATED, carbs: 10, notes: NOTE });
    for (var carbs = 11; carbs <= 18; carbs++) {
      var seen = carbsAtAnnouncement();
      var res = await request(self.app).put('/api/treatments/').set('api-secret', known)
        .send({ _id: ID, eventType: 'Carb Correction', created_at: CREATED, carbs: carbs, notes: NOTE })
        .expect(200);
      res.body.carbs.should.equal(carbs);
      should(await seen).equal(carbs, 'carbs stored when the PUT of ' + carbs + ' was announced');
    }
  });
});
