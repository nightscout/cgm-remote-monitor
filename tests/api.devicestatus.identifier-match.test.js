'use strict';

// A devicestatus POSTed again with the `identifier` of a stored status
// replaces that status's fields, as a v1 treatment with the same
// `identifier` does, instead of being stored a second time.
//
// `identifier` is the client's name for the status. v1 devicestatus had no
// match key: every POST added a record, so an uploader that retried a status
// it had already sent stored a copy. Now a status whose `identifier` is
// already stored updates that status with the later values, and the response
// names the stored `_id`. A status with a new `identifier`, or with none, is
// inserted as before, and a re-sent `_id` is still answered with the stored
// record (see api.devicestatus.resend-guard).

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('devicestatus: a re-send with a stored identifier updates that status', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var DEVICE = 'identifier-match-test';

  // Synthetic values only.
  function status (minute, extra) {
    return Object.assign({
      device: DEVICE
      , created_at: new Date(Date.UTC(2021, 4, 9, 7, minute)).toISOString()
      , uploaderBattery: 50
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.devicestatus_collection);
  }

  function stored (filter) {
    return collection().find(Object.assign({ device: DEVICE }, filter || {})).sort({ created_at: 1, uploaderBattery: 1 }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/devicestatus/').set('api-secret', known).send(body);
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
      dropAll().then(function () { done(); }, done);
    });
  });

  afterEach(function () {
    return dropAll();
  });

  it('the same identifier POSTed twice stores one status with the later values', async function () {
    var first = await post(status(0, { identifier: 'idm-status-a', uploaderBattery: 50 })).expect(200);
    var second = await post(status(1, { identifier: 'idm-status-a', uploaderBattery: 48 })).expect(200);

    var docs = await stored({ identifier: 'idm-status-a' });
    docs.length.should.equal(1);
    docs[0].uploaderBattery.should.equal(48);
    docs[0].created_at.should.equal(status(1).created_at);
    String(first.body[0]._id).should.equal(String(docs[0]._id));
    String(second.body[0]._id).should.equal(String(docs[0]._id));
    docs[0].srvModified.should.be.above(docs[0].srvCreated);
  });

  it('a different identifier stores a second status', async function () {
    await post(status(0, { identifier: 'idm-status-b1' })).expect(200);
    await post(status(0, { identifier: 'idm-status-b2' })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
  });

  it('without identifier, every POST stores a status, as before', async function () {
    await post(status(0)).expect(200);
    await post(status(0)).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs.forEach(function (d) { d.should.not.have.property('identifier'); });
  });

  it('a batch of stored, new, repeated and unidentified statuses stores each identifier once', async function () {
    await post(status(0, { identifier: 'idm-batch-stored', uploaderBattery: 40 })).expect(200);

    var res = await post([
      status(2, { identifier: 'idm-batch-stored', uploaderBattery: 42 })
      , status(3, { identifier: 'idm-batch-new', uploaderBattery: 43 })
      , status(4, { uploaderBattery: 44 })
      , status(4, { uploaderBattery: 45 })
      , status(5, { identifier: 'idm-batch-twice', uploaderBattery: 46 })
      , status(6, { identifier: 'idm-batch-twice', uploaderBattery: 47 })
    ]).expect(200);

    var docs = await stored();
    docs.map(function (d) { return d.uploaderBattery; }).should.eql([42, 43, 44, 45, 47]);
    var byIdentifier = {};
    docs.forEach(function (d) { if (d.identifier) byIdentifier[d.identifier] = String(d._id); });
    res.body.length.should.equal(6);
    String(res.body[0]._id).should.equal(byIdentifier['idm-batch-stored']);
    String(res.body[1]._id).should.equal(byIdentifier['idm-batch-new']);
    String(res.body[4]._id).should.equal(byIdentifier['idm-batch-twice']);
    String(res.body[5]._id).should.equal(byIdentifier['idm-batch-twice']);
  });

  it('a re-sent _id without identifier is still answered with the stored status', async function () {
    var hex = '5f3300000000000000000a01';
    await post(status(0, { _id: hex, uploaderBattery: 50 })).expect(200);
    var res = await post(status(0, { _id: hex, uploaderBattery: 49 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(1);
    docs[0]._id.should.be.instanceOf(ObjectID);
    String(docs[0]._id).should.equal(hex);
    docs[0].uploaderBattery.should.equal(50, 'a re-sent _id does not rewrite the stored status');
    String(res.body[0]._id).should.equal(hex);
  });

  it('when _id and identifier name different stored statuses, identifier decides', async function () {
    var storedHex = '5f3300000000000000000b02';
    var otherHex = '5f3300000000000000000b03';
    await post(status(0, { _id: storedHex, identifier: 'idm-status-d', uploaderBattery: 50 })).expect(200);
    await post(status(5, { _id: otherHex, uploaderBattery: 30 })).expect(200);

    var res = await post(status(1, { _id: otherHex, identifier: 'idm-status-d', uploaderBattery: 49 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    String(docs[0]._id).should.equal(storedHex);
    docs[0].uploaderBattery.should.equal(49);
    String(docs[1]._id).should.equal(otherHex);
    docs[1].uploaderBattery.should.equal(30);
    String(res.body[0]._id).should.equal(storedHex);
  });

  it('a non-string or empty identifier is stored as sent, and every POST stores a status', async function () {
    await post(status(0, { identifier: '' })).expect(200);
    await post(status(0, { identifier: '' })).expect(200);
    await post(status(0, { identifier: 7 })).expect(200);
    await post(status(0, { identifier: 7 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(4);
  });
});
