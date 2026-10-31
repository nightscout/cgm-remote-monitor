'use strict';

// One API v1 entries batch that reaches BF-220 and the ID-UNIQUE-INDEX race at
// once. Slot 1 carries an _id another entry holds (BF-220: refused with 409 in
// its slot, and the ordered bulk write resumes past it). Slot 2 carries an
// identifier that another upload stores between this batch's identifier match
// and its write, so its insert gets a duplicate key on identifier_unique, not
// on _id_. BF-220's takenIdAt counts only a duplicate key on _id_ as a taken
// _id; the identifier one is rethrown, and the write step's duplicate-key
// retry (DUPLICATE_IDENTIFIER) runs the write once more, which now matches the
// stored record by identifier and merges slot 2 into it, as a re-send. If
// takenIdAt took any duplicate key for a taken _id, slot 2 would come back as
// a wrong 409 (shown red by break-it).
//
// The race is forced, not hoped for: the other upload's record is stored
// straight to MongoDB at the batch's first bulk write, after the identifier
// match. Its sysTime is one second off slot 2's, so slot 2's upsert (by
// sysTime and type, since no record had its identifier when it was matched)
// cannot reach it, and only the index stops the second record. Synthetic
// values only.

var request = require('supertest');
var should = require('should');
var { Collection, ObjectId } = require('mongodb');
var language = require('../lib/language')();

describe('API v1 entries batch: a taken _id and an identifier race together (BF-220 with ID-UNIQUE-INDEX)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var DEVICE = 'entries-taken-and-race-test';
  var HOLDER = '5f3200000000000000000e72';
  var RACE = 'entries-taken-and-race-1';
  var realBulkWrite = Collection.prototype.bulkWrite;

  function at (minute, second) { return Date.UTC(2021, 7, 8, 8, minute, second || 0); }
  function iso (minute, second) { return new Date(at(minute, second)).toISOString(); }
  function entry (minute, extra) {
    return Object.assign({ type: 'sgv', sgv: 100 + minute, date: at(minute), dateString: iso(minute), device: DEVICE }, extra || {});
  }
  function col () { return self.ctx.store.collection(self.env.entries_collection || 'entries'); }
  async function dropAll () {
    await col().deleteMany({ device: DEVICE });
    await col().deleteMany({ _id: new ObjectId(HOLDER) });
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
      dropAll().then(function () { done(); }, done);
    });
  });
  beforeEach(dropAll);
  afterEach(function () { Collection.prototype.bulkWrite = realBulkWrite; });
  after(dropAll);

  it('slot 1 refused 409 with no _id, slot 2 merged into the record the other upload stored, slots in batch order', async function () {
    should.exist(self.ctx.identifierIndex, 'the index stage ran');
    self.ctx.identifierIndex.mode.should.equal('try');
    await col().insertOne(Object.assign(entry(1), { _id: new ObjectId(HOLDER), sysTime: iso(1) }));

    // The other upload: same identifier, sysTime one second off, a field the
    // batch's slot 2 leaves out. Stored at the batch's first bulk write.
    var other = null;
    var entriesName = col().collectionName;
    Collection.prototype.bulkWrite = async function bulkWrite () {
      if (this.collectionName === entriesName && other === null) {
        other = (await col().insertOne(Object.assign(entry(6), { identifier: RACE, date: at(6, 1), dateString: iso(6, 1)
          , sysTime: iso(6, 1), sgv: 90, noise: 1 }))).insertedId;
      }
      return realBulkWrite.apply(this, arguments);
    };

    var batch = [entry(5), entry(7, { _id: HOLDER }), entry(6, { identifier: RACE }), entry(8)];
    var warned = [];
    var warn = console.warn;
    console.warn = function () { warned.push(Array.prototype.join.call(arguments, ' ')); return warn.apply(console, arguments); };
    var res;
    try {
      res = await request(self.app).post('/api/entries/').set('api-secret', known).send(batch).expect(200);
    } finally { console.warn = warn; }
    Collection.prototype.bulkWrite = realBulkWrite;
    should.exist(other, 'the other upload was stored at the first bulk write');

    res.body.length.should.equal(4);
    should.not.exist(res.body[1]._id, 'slot 1: a refused slot carries no _id');
    res.body[1].refused.status.should.equal(409, 'slot 1 refused');
    should.exist(res.body[2]._id, 'slot 2 is not refused');
    should.not.exist(res.body[2].refused, 'slot 2 is not refused');
    String(res.body[2]._id).should.equal(String(other), 'slot 2 names the record the other upload stored');

    var raced = await col().find({ identifier: RACE }).toArray();
    raced.length.should.equal(1, 'one record holds the identifier');
    raced[0].sgv.should.equal(106, 'slot 2 was applied as its re-send (merged)');
    raced[0].noise.should.equal(1, 'a merge keeps the field slot 2 leaves out');

    var s5 = await col().find({ device: DEVICE, sysTime: iso(5) }).toArray();
    var s8 = await col().find({ device: DEVICE, sysTime: iso(8) }).toArray();
    s5.length.should.equal(1); s8.length.should.equal(1);
    String(res.body[0]._id).should.equal(String(s5[0]._id), 'slot 0 names the record stored for it');
    String(res.body[3]._id).should.equal(String(s8[0]._id), 'slot 3 names the record stored for it');
    (await col().countDocuments({ device: DEVICE, sysTime: iso(7) })).should.equal(0, 'the refused entry is not stored');

    // Recorded for the report (not the contract): the retry runs the batch's
    // write once more, so BF-220's log line is printed once per run.
    warned.filter(function (w) { return /applying this one as its re-send/.test(w); }).length.should.equal(1, 'one retry');
    warned.filter(function (w) { return /refused entry/.test(w); }).forEach(function (w) {
      w.should.equal('API v1 refused entry 1 of the batch: its _id is in use by another record (409)');
    });
    self.refusedLines = warned.filter(function (w) { return /refused entry/.test(w); }).length;
  });

  after(function () {
    if (self.refusedLines !== undefined) console.log('    (BF-220 refused-entry log lines: ' + self.refusedLines + ')');
  });
});
