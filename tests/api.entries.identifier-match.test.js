'use strict';

// An entry POSTed again with the `identifier` of a stored entry updates that
// entry, as a v1 treatment with the same `identifier` does.
//
// `identifier` is the client's name for the reading. Entries were matched on
// sysTime + type only, so a re-send of one reading with a corrected time, or
// from a second device whose clock differs, stored a second entry beside the
// first. Now an entry whose `identifier` is already stored updates that entry
// with the later values, and the response names the stored `_id`. An entry
// with a new `identifier`, or with none, is matched on sysTime + type as
// before, so readings that were merged by time still are.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('entries: a re-send with a stored identifier updates that entry', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');
  var DEVICE = 'identifier-match-test';

  // Synthetic values only.
  function sampleEntry (minute, extra) {
    var date = Date.UTC(2021, 4, 9, 6, 0) + minute * 60000;
    return Object.assign({
      type: 'sgv'
      , sgv: 100 + minute
      , date: date
      , dateString: new Date(date).toISOString()
      , device: DEVICE
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.entries_collection);
  }

  function stored (filter) {
    return collection().find(Object.assign({ device: DEVICE }, filter || {})).sort({ date: 1 }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/entries/').set('api-secret', known).send(body);
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
    self.env.uuidHandling = true;
    return dropAll();
  });

  it('the same identifier POSTed twice, 60 s apart, stores one entry with the later values', async function () {
    var first = await post(sampleEntry(0, { identifier: 'idm-entry-a', sgv: 120 })).expect(200);
    var second = await post(sampleEntry(1, { identifier: 'idm-entry-a', sgv: 125 })).expect(200);

    var docs = await stored({ identifier: 'idm-entry-a' });
    docs.length.should.equal(1);
    docs[0].sgv.should.equal(125);
    docs[0].date.should.equal(sampleEntry(1).date);
    docs[0].sysTime.should.equal(new Date(sampleEntry(1).date).toISOString());
    String(second.body[0]._id).should.equal(String(docs[0]._id));
    String(first.body[0]._id).should.equal(String(docs[0]._id));
  });

  it('a different identifier at another time stores a second entry', async function () {
    await post(sampleEntry(0, { identifier: 'idm-entry-b1' })).expect(200);
    await post(sampleEntry(1, { identifier: 'idm-entry-b2' })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs.map(function (d) { return d.identifier; }).should.eql(['idm-entry-b1', 'idm-entry-b2']);
  });

  it('without identifier, entries are matched on sysTime + type only, as before', async function () {
    await post(sampleEntry(0, { sgv: 120 })).expect(200);
    await post(sampleEntry(0, { sgv: 121 })).expect(200);
    await post(sampleEntry(1, { sgv: 120 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs[0].sgv.should.equal(121);
    docs[1].sgv.should.equal(120);
    docs.forEach(function (d) { d.should.not.have.property('identifier'); });
  });

  it('a new identifier at the time of a stored entry still updates that entry', async function () {
    await post(sampleEntry(0, { sgv: 120 })).expect(200);
    await post(sampleEntry(1, { identifier: 'idm-entry-c-old', sgv: 130 })).expect(200);
    await post(sampleEntry(0, { identifier: 'idm-entry-c1', sgv: 121 })).expect(200);
    await post(sampleEntry(1, { identifier: 'idm-entry-c2', sgv: 131 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs[0].identifier.should.equal('idm-entry-c1');
    docs[0].sgv.should.equal(121);
    docs[1].identifier.should.equal('idm-entry-c2');
    docs[1].sgv.should.equal(131);
  });

  it('a batch of stored, new, repeated and unidentified entries stores each reading once', async function () {
    await post(sampleEntry(0, { identifier: 'idm-batch-stored', sgv: 100 })).expect(200);

    var res = await post([
      sampleEntry(2, { identifier: 'idm-batch-stored', sgv: 102 })
      , sampleEntry(3, { identifier: 'idm-batch-new', sgv: 103 })
      , sampleEntry(4, { sgv: 104 })
      , sampleEntry(5, { identifier: 'idm-batch-twice', sgv: 105 })
      , sampleEntry(6, { identifier: 'idm-batch-twice', sgv: 106 })
    ]).expect(200);

    var docs = await stored();
    docs.length.should.equal(4);
    docs.map(function (d) { return d.sgv; }).should.eql([102, 103, 104, 106]);
    var byIdentifier = {};
    docs.forEach(function (d) { if (d.identifier) byIdentifier[d.identifier] = String(d._id); });
    res.body.length.should.equal(5);
    String(res.body[0]._id).should.equal(byIdentifier['idm-batch-stored']);
    String(res.body[3]._id).should.equal(byIdentifier['idm-batch-twice']);
    String(res.body[4]._id).should.equal(byIdentifier['idm-batch-twice']);
  });

  it('an _id without identifier behaves as before', async function () {
    var hex = '5f3200000000000000000a01';
    await post(sampleEntry(0, { _id: hex, sgv: 120 })).expect(200);
    await post(sampleEntry(0, { _id: hex, sgv: 121 })).expect(200);
    await post(sampleEntry(1, { sgv: 122 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs[0]._id.should.be.instanceOf(ObjectID);
    String(docs[0]._id).should.equal(hex);
    docs[0].sgv.should.equal(121);
  });

  it('when _id and identifier name different stored entries, identifier decides', async function () {
    var storedHex = '5f3200000000000000000b02';
    var otherHex = '5f3200000000000000000b03';
    await post(sampleEntry(0, { _id: storedHex, identifier: 'idm-entry-d', sgv: 120 })).expect(200);
    await post(sampleEntry(5, { _id: otherHex, sgv: 150 })).expect(200);

    var res = await post(sampleEntry(1, { _id: otherHex, identifier: 'idm-entry-d', sgv: 121 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    String(docs[0]._id).should.equal(storedHex);
    docs[0].sgv.should.equal(121);
    String(docs[1]._id).should.equal(otherHex);
    docs[1].sgv.should.equal(150);
    String(res.body[0]._id).should.equal(storedHex);
  });

  it('a non-24-hex _id re-sent at another time updates the entry it was stored as (UUID_HANDLING)', async function () {
    var uuid = '6a0e3b52-0000-4000-8000-00000000e001';
    await post(sampleEntry(0, { _id: uuid, sgv: 120 })).expect(200);
    await post(sampleEntry(1, { _id: uuid, sgv: 121 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(1);
    docs[0].identifier.should.equal(uuid);
    docs[0].sgv.should.equal(121);
  });

  it('an entry stored with the value as its _id (15.0.6 and earlier) is updated by that identifier', async function () {
    var uuid = '6a0e3b52-0000-4000-8000-00000000e002';
    var legacy = sampleEntry(0, { _id: uuid, sgv: 120 });
    legacy.sysTime = legacy.dateString;
    await collection().insertOne(legacy);

    var res = await post(sampleEntry(1, { identifier: uuid, sgv: 121 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(1);
    docs[0]._id.should.equal(uuid);
    docs[0].sgv.should.equal(121);
    res.body[0]._id.should.equal(uuid);
  });

  it('with UUID_HANDLING off, a legacy _id is not matched, but an identifier still is', async function () {
    self.env.uuidHandling = false;
    var uuid = '6a0e3b52-0000-4000-8000-00000000e003';
    var legacy = sampleEntry(0, { _id: uuid, sgv: 120 });
    legacy.sysTime = legacy.dateString;
    await collection().insertOne(legacy);

    await post(sampleEntry(1, { identifier: uuid, sgv: 121 })).expect(200);
    await post(sampleEntry(2, { identifier: uuid, sgv: 122 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(2);
    docs[0]._id.should.equal(uuid);
    docs[1].identifier.should.equal(uuid);
    docs[1].sgv.should.equal(122);
  });

  it('a non-string or empty identifier is stored as sent and matched by time, as before', async function () {
    await post(sampleEntry(0, { identifier: '' })).expect(200);
    await post(sampleEntry(1, { identifier: '' })).expect(200);
    await post(sampleEntry(2, { identifier: 7 })).expect(200);
    await post(sampleEntry(3, { identifier: 7 })).expect(200);

    var docs = await stored();
    docs.length.should.equal(4);
  });
});
