// A devicestatus POSTed again with the `identifier` of a stored status is
// acknowledged with the stored status's `_id` and not written again
// (ID-SIMPLE-MATCH, devicestatus option (b), maintainer decision 2026-10-26).
//
// `identifier` is the client's name for the status. v1 devicestatus had no
// match key: every POST added a record, so an uploader that retried a status
// it had already sent stored a copy. Now a status whose `identifier` is
// already stored writes nothing: no merge, no second record and no new
// srvModified, whether the body is the same or different; the response names
// the stored `_id`, as a re-sent `_id` is answered (see
// api.devicestatus.resend-guard). A status with a new `identifier`, or with
// none, is inserted as before. API v3 does the same
// (api3.devicestatus.identifier-dedup).
//
// CHANGED EXPECTATION (ID-FIRST-MATCH slice 4, ID-Q2): device status now
// follows the default of the other collections: a status whose `identifier` is
// stored is merged into the stored status (RFC 7386: what it sends is set,
// what it leaves out is kept, a null removes), with a new srvModified, and
// announced; the reply still names the stored `_id`. A re-sent `_id` and a
// deleted status are still answered without a write. The tests keep their
// titles and check the merge.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('devicestatus: a re-send with a stored identifier is acknowledged and not stored again', function () {
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

  it('the same status POSTed twice with one identifier stores it once, unchanged', async function () {
    var body = status(0, { identifier: 'idm-status-same', uploaderBattery: 50 });
    var first = await post(Object.assign({}, body)).expect(200);
    var before = await stored({ identifier: 'idm-status-same' });
    var second = await post(Object.assign({}, body)).expect(200);

    var docs = await stored({ identifier: 'idm-status-same' });
    docs.length.should.equal(1);
    // CHANGED EXPECTATION (slice 4, ID-Q2): merged: the same values, a new srvModified.
    docs[0].srvModified.should.be.above(before[0].srvModified);
    Object.assign({}, docs[0], { srvModified: 0 }).should.eql(Object.assign({}, before[0], { srvModified: 0 }));
    String(first.body[0]._id).should.equal(String(docs[0]._id));
    second.body.length.should.equal(1);
    String(second.body[0]._id).should.equal(String(docs[0]._id));
  });

  it('a different status POSTed with a stored identifier writes nothing: no merge, no copy, no new srvModified', async function () {
    var first = await post(status(0, { identifier: 'idm-status-a', uploaderBattery: 50, pump: { reservoir: 100 } })).expect(200);
    var before = await stored({ identifier: 'idm-status-a' });
    var second = await post(status(1, { identifier: 'idm-status-a', uploaderBattery: 48, pump: null, extra: 'x' })).expect(200);

    var docs = await stored({ identifier: 'idm-status-a' });
    docs.length.should.equal(1);
    // CHANGED EXPECTATION (slice 4, ID-Q2): merged: what it sends is set, the
    // null removes `pump`, srvCreated is kept and srvModified is new.
    docs[0].uploaderBattery.should.equal(48);
    docs[0].should.not.have.property('pump');
    docs[0].extra.should.equal('x');
    docs[0].created_at.should.equal(status(1).created_at);
    docs[0].srvCreated.should.equal(before[0].srvCreated);
    docs[0].srvModified.should.be.above(before[0].srvModified);
    String(first.body[0]._id).should.equal(String(docs[0]._id));
    String(second.body[0]._id).should.equal(String(docs[0]._id));
    // The reply is the status as sent with the stored _id, the shape a
    // re-sent _id gets.
    second.body[0].uploaderBattery.should.equal(48);
  });

  it('the acknowledged re-send announces nothing', async function () {
    await post(status(0, { identifier: 'idm-status-quiet' })).expect(200);
    var events = [];
    function seen (event) { if (event && event.type === 'devicestatus') events.push(event); }
    self.ctx.bus.on('data-update', seen);
    try {
      await post(status(1, { identifier: 'idm-status-quiet' })).expect(200);
    } finally {
      self.ctx.bus.removeListener('data-update', seen);
    }
    // CHANGED EXPECTATION (slice 4, ID-Q2): the merge is announced, with the status as merged.
    events.length.should.equal(1);
    events[0].changes.length.should.equal(1);
    events[0].changes[0].identifier.should.equal('idm-status-quiet');
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

  it('a batch of stored, new, repeated and unidentified statuses stores each identifier once, the first copy', async function () {
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
    // CHANGED EXPECTATION (slice 4, ID-Q2): the re-send of the stored status is
    // merged into it (40 becomes 42); a repeat within the batch is still not written.
    docs.map(function (d) { return d.uploaderBattery; }).should.eql([42, 43, 44, 45, 46]);
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

  it('when _id and identifier name different stored statuses, identifier decides, and neither is written', async function () {
    var storedHex = '5f3300000000000000000b02';
    var otherHex = '5f3300000000000000000b03';
    await post(status(0, { _id: storedHex, identifier: 'idm-status-d', uploaderBattery: 50 })).expect(200);
    await post(status(5, { _id: otherHex, uploaderBattery: 30 })).expect(200);
    var before = await stored();

    var res = await post(status(1, { _id: otherHex, identifier: 'idm-status-d', uploaderBattery: 49 })).expect(200);

    var docs = await stored();
    // CHANGED EXPECTATION (slice 4, ID-Q2): identifier decides, and the status
    // it names is merged into; the one the _id names is left as it was.
    String(docs[0]._id).should.equal(storedHex);
    docs[0].uploaderBattery.should.equal(49);
    docs[1].should.eql(before[1]);
    String(docs[1]._id).should.equal(otherHex);
    docs[1].uploaderBattery.should.equal(30);
    String(res.body[0]._id).should.equal(storedHex);
  });

  it('a re-send of a deleted status (isValid: false) is acknowledged and leaves it deleted', async function () {
    await post(status(0, { identifier: 'idm-status-deleted' })).expect(200);
    await collection().updateOne({ identifier: 'idm-status-deleted' }, { $set: { isValid: false } });
    var before = await stored({ identifier: 'idm-status-deleted' });
    var res = await post(status(0, { identifier: 'idm-status-deleted' })).expect(200);

    var docs = await stored({ identifier: 'idm-status-deleted' });
    docs.should.eql(before);
    docs[0].isValid.should.equal(false);
    String(res.body[0]._id).should.equal(String(docs[0]._id));
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
