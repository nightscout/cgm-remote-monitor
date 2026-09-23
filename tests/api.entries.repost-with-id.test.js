'use strict';

// An entry POSTed again with its own `_id` updates the stored entry.
//
// Entries are deduplicated on sysTime + type: a POST of a reading at the time
// and type of a stored one updates that entry. A POST carrying a 24-hex `_id`
// also wrote the `_id` into that update, so when the stored entry's `_id` was
// not that exact ObjectId - it was stored as the string by 15.0.6 or earlier,
// or the stored reading at that time has another id - MongoDB refused the
// write (an `_id` cannot change) and the POST answered 500. The same POST
// without `_id` updated the entry. A POST with an `_id` now behaves like one
// without: the stored entry keeps its `_id`, and a new entry is stored with
// the `_id` it was sent with.
//
// The response gives each entry the `_id` it is stored under: for an entry
// that updated a stored one, that entry's own `_id`, whether the POST carried
// another `_id` or none (docs/proposals/TEST-IMPLEMENTATION-SUMMARY.md 6.1.2:
// every item in the response has an `_id`).

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('entries: a re-POST carrying an _id updates the stored entry', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var api = require('../lib/api/');

  var HEX = {
    legacy: '5f3100000000000000000b01'
    , legacyUpper: '5F3100000000000000000B02'
    , other: '5f3100000000000000000b03'
    , otherSent: '5f3100000000000000000a03'
    , same: '5f3100000000000000000b04'
    , fresh: '5f3100000000000000000a05'
    , batchStored: '5f3100000000000000000b06'
    , batchFresh: '5f3100000000000000000a06'
  };

  // Synthetic values only.
  function sampleEntry (minute, extra) {
    var date = Date.UTC(2021, 4, 5, 6, minute);
    return Object.assign({
      type: 'sgv'
      , sgv: 100 + minute
      , date: date
      , dateString: new Date(date).toISOString()
      , device: 'repost-with-id-test'
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.entries_collection);
  }

  function seed (minute, id, extra) {
    var doc = sampleEntry(minute, extra);
    doc._id = id;
    doc.sysTime = doc.dateString;
    return collection().insertOne(doc);
  }

  function atMinute (minute) {
    return collection().find({ sysTime: new Date(Date.UTC(2021, 4, 5, 6, minute)).toISOString(), type: 'sgv' }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/entries/').set('api-secret', known).send(body);
  }

  function dropAll () {
    return collection().deleteMany({ device: 'repost-with-id-test' });
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

  it('with the hex _id of an entry stored as a string, updates that entry', async function () {
    await seed(1, HEX.legacy);
    await post(sampleEntry(1, { _id: HEX.legacy, sgv: 150 })).expect(200);
    var docs = await atMinute(1);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.legacy);
    docs[0].sgv.should.equal(150);
  });

  it('with the lower-case _id of an entry stored as an upper-case string, updates that entry', async function () {
    await seed(2, HEX.legacyUpper);
    await post(sampleEntry(2, { _id: HEX.legacyUpper.toLowerCase(), sgv: 151 })).expect(200);
    var docs = await atMinute(2);
    docs.length.should.equal(1);
    docs[0]._id.should.equal(HEX.legacyUpper);
    docs[0].sgv.should.equal(151);
  });

  it('with a different _id than the entry stored at that time and type, updates that entry and keeps its _id', async function () {
    await seed(3, new ObjectID(HEX.other));
    await post(sampleEntry(3, { _id: HEX.otherSent, sgv: 152 })).expect(200);
    var docs = await atMinute(3);
    docs.length.should.equal(1);
    String(docs[0]._id).should.equal(HEX.other);
    docs[0].sgv.should.equal(152);
  });

  it('with the _id the entry is already stored under, updates it (control)', async function () {
    await seed(4, new ObjectID(HEX.same));
    await post(sampleEntry(4, { _id: HEX.same, sgv: 153 })).expect(200);
    var docs = await atMinute(4);
    docs.length.should.equal(1);
    (docs[0]._id instanceof ObjectID).should.equal(true);
    String(docs[0]._id).should.equal(HEX.same);
    docs[0].sgv.should.equal(153);
  });

  it('a new entry with a 24-hex _id is stored with that ObjectId (control)', async function () {
    await post(sampleEntry(5, { _id: HEX.fresh })).expect(200);
    var docs = await atMinute(5);
    docs.length.should.equal(1);
    (docs[0]._id instanceof ObjectID).should.equal(true);
    String(docs[0]._id).should.equal(HEX.fresh);
  });

  it('a batch holding a re-sent string-stored entry and a new one stores both', async function () {
    await seed(6, HEX.batchStored);
    await post([
      sampleEntry(6, { _id: HEX.batchStored, sgv: 160 })
      , sampleEntry(7, { _id: HEX.batchFresh, sgv: 161 })
    ]).expect(200);
    var six = await atMinute(6);
    var seven = await atMinute(7);
    six.length.should.equal(1);
    six[0]._id.should.equal(HEX.batchStored);
    six[0].sgv.should.equal(160);
    seven.length.should.equal(1);
    String(seven[0]._id).should.equal(HEX.batchFresh);
    (seven[0]._id instanceof ObjectID).should.equal(true);
  });

  it('an entry without a type, POSTed with a 24-hex _id, is stored with that ObjectId (control)', async function () {
    var body = sampleEntry(9, { _id: HEX.fresh.replace('a05', 'a09') });
    delete body.type;
    await post(body).expect(200);
    var docs = await collection().find({ _id: new ObjectID(HEX.fresh.replace('a05', 'a09')) }).toArray();
    docs.length.should.equal(1);
    docs[0].sgv.should.equal(109);
  });

  describe('the response _id', function () {

    it('is the stored _id when the POST carried a different one', async function () {
      await seed(20, new ObjectID(HEX.other.replace('b03', 'b20')));
      var res = await post(sampleEntry(20, { _id: HEX.otherSent.replace('a03', 'a20') })).expect(200);
      res.body.length.should.equal(1);
      res.body[0]._id.should.equal(HEX.other.replace('b03', 'b20'));
    });

    it('is the stored _id when the POST carried none', async function () {
      await seed(21, new ObjectID(HEX.other.replace('b03', 'b21')));
      var res = await post(sampleEntry(21)).expect(200);
      res.body.length.should.equal(1);
      res.body[0]._id.should.equal(HEX.other.replace('b03', 'b21'));
    });

    it('is the stored string _id of an entry stored as a string', async function () {
      await seed(22, HEX.legacyUpper.replace('B02', 'B22'));
      var res = await post(sampleEntry(22, { _id: HEX.legacyUpper.replace('B02', 'B22').toLowerCase() })).expect(200);
      res.body[0]._id.should.equal(HEX.legacyUpper.replace('B02', 'B22'));
    });

    it('is each entry\'s own stored _id in a batch mixing matched and new entries, in order', async function () {
      var stored = [HEX.other.replace('b03', 'b23'), HEX.other.replace('b03', 'b25')];
      await seed(23, new ObjectID(stored[0]));
      await seed(25, stored[1]);
      var res = await post([
        sampleEntry(23)
        , sampleEntry(24, { _id: HEX.fresh.replace('a05', 'a24') })
        , sampleEntry(25, { _id: HEX.otherSent.replace('a03', 'a25') })
        , sampleEntry(26)
      ]).expect(200);
      res.body.length.should.equal(4);
      res.body[0]._id.should.equal(stored[0]);
      res.body[1]._id.should.equal(HEX.fresh.replace('a05', 'a24'));
      res.body[2]._id.should.equal(stored[1]);
      var fourth = await atMinute(26);
      fourth.length.should.equal(1);
      res.body[3]._id.should.equal(String(fourth[0]._id));
    });

    it('is the first entry\'s _id for a second entry at the same time and type in one batch', async function () {
      var res = await post([sampleEntry(27, { sgv: 170 }), sampleEntry(27, { sgv: 171 })]).expect(200);
      var docs = await atMinute(27);
      docs.length.should.equal(1);
      res.body[0]._id.should.equal(String(docs[0]._id));
      res.body[1]._id.should.equal(String(docs[0]._id));
    });

    describe('reads', function () {
      var finds;
      var original;
      var failFind;

      beforeEach(function () {
        finds = [];
        failFind = false;
        original = self.ctx.store.collection;
        var entriesName = self.env.entries_collection;
        self.ctx.store.collection = function (name) {
          var col = original.apply(this, arguments);
          if (name !== entriesName) return col;
          return new Proxy(col, {
            get: function (target, prop) {
              if (prop === 'find') {
                return function (filter) {
                  finds.push(filter);
                  if (failFind) throw new Error('test read failure');
                  return target.find.apply(target, arguments);
                };
              }
              var value = target[prop];
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
        };
      });

      afterEach(function () {
        self.ctx.store.collection = original;
      });

      it('one read for a batch of several matched entries', async function () {
        await seed(30, new ObjectID(HEX.other.replace('b03', 'b30')));
        await seed(31, new ObjectID(HEX.other.replace('b03', 'b31')));
        await seed(32, HEX.other.replace('b03', 'b32'));
        var res = await post([sampleEntry(30), sampleEntry(31), sampleEntry(32)]).expect(200);
        finds.length.should.equal(1);
        res.body.map(function (e) { return e._id; }).should.eql([
          HEX.other.replace('b03', 'b30'), HEX.other.replace('b03', 'b31'), HEX.other.replace('b03', 'b32')]);
      });

      it('no read for a batch of new entries', async function () {
        await post([sampleEntry(33), sampleEntry(34, { _id: HEX.fresh.replace('a05', 'a34') })]).expect(200);
        finds.length.should.equal(0);
      });

      it('the read asks only for the matched entries', async function () {
        await seed(35, new ObjectID(HEX.other.replace('b03', 'b35')));
        await post([sampleEntry(35), sampleEntry(36)]).expect(200);
        finds.length.should.equal(1);
        finds[0].$or.length.should.equal(1);
        finds[0].$or[0].sysTime.$eq.should.equal(new Date(Date.UTC(2021, 4, 5, 6, 35)).toISOString());
      });

      it('a failed read-back still answers 200 with the entries stored', async function () {
        await seed(37, new ObjectID(HEX.other.replace('b03', 'b37')));
        failFind = true;
        await post([sampleEntry(37, { sgv: 180 })]).expect(200);
        failFind = false;
        var docs = await atMinute(37);
        docs.length.should.equal(1);
        docs[0].sgv.should.equal(180);
      });
    });

    it('is the sent _id for a new entry (control)', async function () {
      var res = await post(sampleEntry(28, { _id: HEX.fresh.replace('a05', 'a28') })).expect(200);
      res.body[0]._id.should.equal(HEX.fresh.replace('a05', 'a28'));
    });
  });

  it('without an _id, updates the stored entry (control)', async function () {
    await seed(8, HEX.legacy.replace('b01', 'b08'));
    await post(sampleEntry(8, { sgv: 162 })).expect(200);
    var docs = await atMinute(8);
    docs.length.should.equal(1);
    docs[0].sgv.should.equal(162);
  });
});
