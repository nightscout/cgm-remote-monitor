'use strict';

// One API v1 entries batch that reaches slice 3 and BF-220 at once (the #8879
// merge of dev 37b2280f). Slot 0 re-sends the identifier of a deleted entry
// (slice 3: acknowledged with the stored _id, not written, not announced);
// slot 1 carries an _id another entry holds (BF-220: refused with 409 in its
// slot); slots 2 and 3 are new. Slot 0 has no bulk operation, so operation
// indexes are one less than batch indexes: the refused slot, each stored
// slot's _id, the log line and the announcement must all use batch indexes.
// Mapping refused operations back without that offset puts an _id in the
// refused slot and names the wrong record (shown red at the merge by
// break-it). Every test goes through HTTP against the booted server.
// Synthetic values only.

var request = require('supertest');
var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('API v1 entries batch: a deleted re-send and a taken _id together (slice 3 with BF-220)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var DEVICE = 'entries-deleted-and-taken-test';
  var HOLDER = '5f3200000000000000000e71';
  var IDENT = 'entries-deleted-and-taken-1';
  var updates = [];

  function at (minute) { return Date.UTC(2021, 7, 7, 8, minute); }
  function iso (minute) { return new Date(at(minute)).toISOString(); }
  function entry (minute, extra) {
    return Object.assign({ type: 'sgv', sgv: 100 + minute, date: at(minute), dateString: iso(minute), device: DEVICE }, extra || {});
  }
  function col () { return self.ctx.store.collection(self.env.entries_collection || 'entries'); }
  async function dropAll () {
    await col().deleteMany({ device: DEVICE });
    await col().deleteMany({ _id: new ObjectID(HOLDER) });
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
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      ctx.bus.on('data-update', function (ev) { if (ev.type === 'entries') updates.push(ev); });
      dropAll().then(function () { done(); }, done);
    });
  });
  beforeEach(function () { updates = []; return dropAll(); });
  after(dropAll);

  it('slot 0 acknowledged, slot 1 refused 409, slots 2-3 stored under their own _id; only 2-3 announced', async function () {
    var deleted = await col().insertOne(Object.assign(entry(0, { identifier: IDENT }), { sysTime: iso(0), isValid: false, srvModified: 1, srvCreated: 1 }));
    await col().insertOne(Object.assign(entry(1), { _id: new ObjectID(HOLDER), sysTime: iso(1) }));
    var batch = [entry(5, { identifier: IDENT }), entry(6, { _id: HOLDER }), entry(7), entry(8)];
    var warned = [];
    var warn = console.warn;
    console.warn = function () { warned.push(Array.prototype.join.call(arguments, ' ')); return warn.apply(console, arguments); };
    var res;
    try {
      res = await request(self.app).post('/api/entries/').set('api-secret', known).send(batch).expect(200);
    } finally { console.warn = warn; }
    res.body.length.should.equal(4);
    warned.filter(function (w) { return /refused entry/.test(w); }).should.eql(
      ['API v1 refused entry 1 of the batch: its _id is in use by another record (409)'], 'the log names the batch index');
    String(res.body[0]._id).should.equal(String(deleted.insertedId), 'slot 0: the deleted entry\'s _id (acknowledged)');
    should.not.exist(res.body[1]._id);
    res.body[1].refused.status.should.equal(409, 'slot 1 refused');
    var s7 = await col().find({ device: DEVICE, sysTime: iso(7) }).toArray();
    var s8 = await col().find({ device: DEVICE, sysTime: iso(8) }).toArray();
    s7.length.should.equal(1); s8.length.should.equal(1);
    String(res.body[2]._id).should.equal(String(s7[0]._id), 'slot 2 names the record stored for it');
    String(res.body[3]._id).should.equal(String(s8[0]._id), 'slot 3 names the record stored for it');
    (await col().countDocuments({ device: DEVICE, sysTime: iso(6) })).should.equal(0, 'refused entry not stored');
    var still = await col().findOne({ _id: deleted.insertedId });
    still.isValid.should.equal(false, 'the deleted entry stays deleted');
    var announced = [].concat.apply([], updates.map(function (u) { return u.changes; })).map(function (e) { return e.sgv; }).sort();
    announced.should.eql([107, 108], 'only the stored entries are announced');
  });

  it('every entry acknowledged-not-written: nothing announced', async function () {
    await col().insertOne(Object.assign(entry(0, { identifier: IDENT }), { sysTime: iso(0), isValid: false, srvModified: 1, srvCreated: 1 }));
    await request(self.app).post('/api/entries/').set('api-secret', known).send([entry(5, { identifier: IDENT })]).expect(200);
    updates.length.should.equal(0);
  });
});
