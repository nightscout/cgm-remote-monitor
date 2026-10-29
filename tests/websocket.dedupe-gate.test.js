'use strict';

// The dedupe gate for WC-STEP-PATCH slice 6: what the socket's dbAdd,
// dbUpdate and dbUpdateUnset do today, written down before slice 6 moves
// them into the write step (lib/storage/write-intent.js) and retires idMatch.
// Release 1 changes no behaviour, so every fixture here must stay green
// through that move.
//
// Each fixture asserts four things: the socket reply, the stored records, and
// exactly the `data-update` and `data-received` events on the bus (op, type,
// changes), in order. A silently wrong dedupe is a lost or a duplicated
// treatment, so a fixture that only counted records would miss half of it.
//
// A fixture marked "today's behaviour; see report" records what the code does
// where it differs from the rule as it was described for the gate; it is
// information, not a decision.
//
// Synthetic values only; every record is dated in May 2019.

var should = require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('websocket: dedupe gate for the write step (WC-STEP-PATCH slice 6)', function () {
  this.timeout(15000);
  var self = this;
  var http = require('http');
  var io = require('socket.io-client');
  var hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var FROM = '2019-05-01T00:00:00.000Z';
  var TO = '2019-06-01T00:00:00.000Z';
  var TAG = 'ws-dedupe-gate';

  // Fixture times: T is the stored record; offsets are in milliseconds.
  var T_MS = Date.parse('2019-05-10T07:40:00.000Z');
  function at (offset) {
    return new Date(T_MS + (offset || 0)).toISOString();
  }

  var IDS = {
    updateOid: '5f42abcdef0000000000c001'
    , updateTwins: '5f42abcdef0000000000c002'
    , updateString: '5f42abcdef0000000000c003'
    , updateMissing: '5f42abcdef0000000000c004'
    , unsetTwins: '5f42abcdef0000000000c005'
    , unsetOid: '5f42abcdef0000000000c006'
  };
  var CUSTOM = 'ws-dedupe-gate-custom-id';

  function col (name) {
    return self.ctx.store.collection(self.env[(name || 'treatments') + '_collection']);
  }

  function stored (name) {
    return col(name).find({ created_at: { $gte: FROM, $lt: TO } }).sort({ created_at: 1, _id: 1 }).toArray();
  }

  function dropAll () {
    var ids = [CUSTOM];
    Object.keys(IDS).forEach(function (k) { ids.push(new ObjectID(IDS[k]), IDS[k]); });
    return Promise.all(['treatments', 'devicestatus', 'profile'].map(function (name) {
      return col(name).deleteMany({ $or: [{ created_at: { $gte: FROM, $lt: TO } }, { _id: { $in: ids } }] });
    }));
  }

  // The runtime form of stored records, as the socket puts them on the bus.
  function runtime (docs) {
    return self.ctx.ddata.processRawDataForRuntime(docs);
  }

  // Emit a socket event and collect the bus events it causes, up to its reply
  // and for a short while after, so a late event is caught too.
  function send (event, data) {
    var events = [];
    function onUpdate (payload) {
      events.push({ event: 'data-update', payload: JSON.parse(JSON.stringify(payload)) });
    }
    function onReceived () {
      events.push({ event: 'data-received' });
    }
    self.ctx.bus.on('data-update', onUpdate);
    self.ctx.bus.on('data-received', onReceived);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('no reply to ' + event)); }, 5000);
      self.socket.emit(event, data, function (reply) {
        clearTimeout(timer);
        setTimeout(function () { resolve(reply); }, 50);
      });
    }).then(function (reply) {
      return { reply: reply, events: events };
    }).finally(function () {
      self.ctx.bus.removeListener('data-update', onUpdate);
      self.ctx.bus.removeListener('data-received', onReceived);
    });
  }

  function dbAdd (collection, data) {
    return send('dbAdd', { collection: collection, data: data });
  }

  // The events of a dbAdd that inserted (or replaced) these stored records.
  function insertEvents (type, docs) {
    var events = [];
    docs.forEach(function (doc) {
      events.push({ event: 'data-update', payload: { type: type, op: 'update', changes: runtime([doc]) } });
      events.push({ event: 'data-received' });
    });
    return events;
  }

  function plain (doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  async function seed (name, doc) {
    var copy = Object.assign({ srvModified: 1557000000000, srvCreated: 1557000000000 }, doc);
    var result = await col(name).insertOne(copy);
    return Object.assign({ _id: result.insertedId }, copy);
  }

  function treatment (offset, fields) {
    return Object.assign({ eventType: 'Meal Bolus', created_at: at(offset), enteredBy: TAG }, fields);
  }

  // The AndroidAPS NSClient (v1) temp basal shape.
  function temp (offset, fields) {
    return Object.assign({ eventType: 'Temp Basal', created_at: at(offset), enteredBy: TAG }, fields);
  }

  // An exact match answers with the stored record and changes nothing: no
  // write, no event.
  async function shouldBeExactMatch (name, result, before) {
    result.reply.should.eql([plain(before)]);
    result.events.should.eql([]);
    (await stored(name)).map(plain).should.eql([plain(before)]);
  }

  // A similar match moves the stored record to the sent created_at, stamps
  // srvModified, and announces only data-received.
  async function shouldBeSimilarMatch (result, before, sentAt) {
    var after = await stored();
    after.length.should.equal(1);
    var expected = Object.assign(plain(before), { created_at: sentAt, srvModified: after[0].srvModified });
    plain(after[0]).should.eql(expected);
    after[0].srvModified.should.be.above(before.srvModified);
    result.reply.should.eql([expected]);
    result.events.should.eql([{ event: 'data-received' }]);
  }

  // A second record was stored for the sent one, beside the earlier one.
  async function shouldBeInserted (name, result, before, sent) {
    var after = await stored(name);
    after.length.should.equal(before.length + 1);
    var added = after.filter(function (doc) {
      return !before.some(function (b) { return String(b._id) === String(doc._id); });
    });
    added.length.should.equal(1);
    var expected = Object.assign({}, sent, { _id: added[0]._id, srvModified: added[0].srvModified, srvCreated: added[0].srvCreated });
    plain(added[0]).should.eql(plain(expected));
    added[0].srvCreated.should.equal(added[0].srvModified);
    before.forEach(function (doc) {
      plain(after.find(function (a) { return String(a._id) === String(doc._id); })).should.eql(plain(doc));
    });
    result.reply.should.eql([plain(added[0])]);
    result.events.should.eql(insertEvents(name, [added[0]]));
    return added[0];
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.WRITE_VALIDATION;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      var server = http.createServer(require('express')());
      require('../lib/server/websocket')(self.env, ctx, server);
      server.listen(0, function () {
        self.server = server;
        self.socket = io('http://localhost:' + server.address().port, { transports: ['websocket'], reconnection: false });
        self.socket.on('connect', function () {
          self.socket.emit('authorize', { client: 'test', secret: hash }, function (auth) {
            if (!auth || !auth.read || !auth.write || !auth.write_treatment) return done(new Error('not authorized to read and write'));
            done();
          });
        });
        self.socket.on('connect_error', done);
      });
    });
  });

  beforeEach(function () {
    self.env.writeValidation = 'off';
    return dropAll();
  });

  after(function (done) {
    self.env.writeValidation = 'off';
    if (self.socket) self.socket.disconnect();
    dropAll().then(function () {
      if (self.server) return self.server.close(function () { done(); });
      done();
    }, done);
  });

  describe('treatments: 1. exact match on NSCLIENT_ID', function () {

    it('answers a re-send with the stored record, a minute and an amount apart', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-1' }));
      var result = await dbAdd('treatments', treatment(60000, { carbs: 25, NSCLIENT_ID: 'nsc-1' }));
      await shouldBeExactMatch('treatments', result, before);
    });

    it('matches on NSCLIENT_ID alone, whatever the eventType', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-1' }));
      var result = await dbAdd('treatments', treatment(0, { eventType: 'Note', notes: 'x', NSCLIENT_ID: 'nsc-1' }));
      await shouldBeExactMatch('treatments', result, before);
    });

    it('stores a record with another NSCLIENT_ID at the same time, type and amount', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-1' }));
      var sent = treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-2' });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });
  });

  describe('treatments: 2. exact match on the fallback key (BF-121)', function () {

    it('answers a re-send with no client identity by created_at + eventType', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var result = await dbAdd('treatments', treatment(0, { carbs: 25 }));
      await shouldBeExactMatch('treatments', result, before);
    });

    it('answers a re-send with the same client identity (syncIdentifier)', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, syncIdentifier: 'sync-a' }));
      var result = await dbAdd('treatments', treatment(0, { carbs: 25, syncIdentifier: 'sync-a' }));
      await shouldBeExactMatch('treatments', result, before);
    });

    // today's behaviour; see report. The fallback key keeps a record with
    // another identity apart, but the similar match has no identity rule
    // (only NSCLIENT_ID), so the second entry is taken for the first.
    it('takes an entry with another syncIdentifier, same time, type and carbs, for the stored one (similar match)', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, syncIdentifier: 'sync-a' }));
      var result = await dbAdd('treatments', treatment(0, { carbs: 20, syncIdentifier: 'sync-b' }));
      await shouldBeSimilarMatch(result, before, at(0));
    });

    // today's behaviour; see report. Same as above, for a write with no
    // identity against a stored record that has one.
    it('takes an entry with no identity, same time, type and carbs, for a stored entry with one (similar match)', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, syncIdentifier: 'sync-a' }));
      var result = await dbAdd('treatments', treatment(0, { carbs: 20 }));
      await shouldBeSimilarMatch(result, before, at(0));
    });

    it('stores an entry with another syncIdentifier and another amount at the same time', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, syncIdentifier: 'sync-a' }));
      var sent = treatment(0, { carbs: 30, syncIdentifier: 'sync-b' });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });
  });

  describe('treatments: 3. the similar match, within 2 s inclusive', function () {

    it('matches a record sent exactly 2000 ms later (stored at the lower edge)', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var result = await dbAdd('treatments', treatment(2000, { carbs: 20 }));
      await shouldBeSimilarMatch(result, before, at(2000));
    });

    it('stores a record sent 2001 ms later', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(2001, { carbs: 20 });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });

    it('matches a record sent exactly 2000 ms earlier (stored at the upper edge)', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var result = await dbAdd('treatments', treatment(-2000, { carbs: 20 }));
      await shouldBeSimilarMatch(result, before, at(-2000));
    });

    it('stores a record sent 2001 ms earlier', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(-2001, { carbs: 20 });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });

    it('stores a record 1 s later with another amount', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(1000, { carbs: 25 });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });

    it('matches a stored record with the same NSCLIENT_ID only', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(1000, { carbs: 20, NSCLIENT_ID: 'nsc-1' });
      var result = await dbAdd('treatments', sent);
      await shouldBeInserted('treatments', result, [before], sent);
    });

    // today's behaviour; see report. An amount the write does not carry is
    // not a key, so a write with no insulin matches a stored bolus.
    it('matches a stored 1 U bolus by a write with no insulin field', async function () {
      var before = await seed('treatments', treatment(0, { eventType: 'Correction Bolus', insulin: 1 }));
      var result = await dbAdd('treatments', treatment(1000, { eventType: 'Correction Bolus' }));
      await shouldBeSimilarMatch(result, before, at(1000));
    });
  });

  describe('treatments: 4. a zero in the similar match (BF-09)', function () {

    describe('absolute, percent and duration 0 must be equal', function () {

      it('matches a zero temp (suspend) re-sent 1 s later', async function () {
        var before = await seed('treatments', temp(0, { absolute: 0, duration: 30 }));
        var result = await dbAdd('treatments', temp(1000, { absolute: 0, duration: 30 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('stores a zero temp 1 s after a 1.2 U/h temp of the same duration', async function () {
        var before = await seed('treatments', temp(0, { absolute: 1.2, duration: 30 }));
        var sent = temp(1000, { absolute: 0, duration: 30 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });

      it('stores a zero temp 1 s after a percent temp, which has no absolute', async function () {
        var before = await seed('treatments', temp(0, { percent: 50, duration: 30 }));
        var sent = temp(1000, { absolute: 0, duration: 30 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });

      it('matches a percent 0 temp re-sent 1 s later', async function () {
        var before = await seed('treatments', temp(0, { percent: 0, duration: 30 }));
        var result = await dbAdd('treatments', temp(1000, { percent: 0, duration: 30 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('stores a percent 0 temp 1 s after a 150 % temp', async function () {
        var before = await seed('treatments', temp(0, { percent: 50, duration: 30 }));
        var sent = temp(1000, { percent: 0, duration: 30 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });

      it('stores a percent 0 temp 1 s after an absolute temp, which has no percent', async function () {
        var before = await seed('treatments', temp(0, { absolute: 1.2, duration: 30 }));
        var sent = temp(1000, { percent: 0, duration: 30 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });

      it('matches a cancel (duration 0) re-sent 1 s later', async function () {
        var before = await seed('treatments', temp(0, { duration: 0 }));
        var result = await dbAdd('treatments', temp(1000, { duration: 0 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('stores a cancel (duration 0) 1 s after a 30 min temp', async function () {
        var before = await seed('treatments', temp(0, { duration: 30 }));
        var sent = temp(1000, { duration: 0 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });
    });

    describe('insulin and carbs 0 mean none: they match none or absent, never an amount', function () {

      it('matches a zero bolus to a stored zero bolus', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Correction Bolus', insulin: 0 }));
        var result = await dbAdd('treatments', treatment(1000, { eventType: 'Correction Bolus', insulin: 0 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('matches a zero bolus to a stored record with no insulin', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Correction Bolus' }));
        var result = await dbAdd('treatments', treatment(1000, { eventType: 'Correction Bolus', insulin: 0 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('stores a zero bolus 1 s after a 1 U bolus', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Correction Bolus', insulin: 1 }));
        var sent = treatment(1000, { eventType: 'Correction Bolus', insulin: 0 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });

      it('matches a zero carb entry to a stored zero carb entry', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Carb Correction', carbs: 0 }));
        var result = await dbAdd('treatments', treatment(1000, { eventType: 'Carb Correction', carbs: 0 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('matches a zero carb entry to a stored record with no carbs', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Carb Correction' }));
        var result = await dbAdd('treatments', treatment(1000, { eventType: 'Carb Correction', carbs: 0 }));
        await shouldBeSimilarMatch(result, before, at(1000));
      });

      it('stores a zero carb entry 1 s after a 20 g entry', async function () {
        var before = await seed('treatments', treatment(0, { eventType: 'Carb Correction', carbs: 20 }));
        var sent = treatment(1000, { eventType: 'Carb Correction', carbs: 0 });
        await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
      });
    });
  });

  describe('treatments: 5. another eventType is another record', function () {

    it('stores a Carb Correction at the same time and carbs as a Meal Bolus', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(0, { eventType: 'Carb Correction', carbs: 20 });
      await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
    });

    it('stores a Carb Correction 1 s after a Meal Bolus with the same carbs', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20 }));
      var sent = treatment(1000, { eventType: 'Carb Correction', carbs: 20 });
      await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
    });
  });

  describe('treatments: 6. a soft-deleted record (isValid: false) is never a match', function () {

    it('on NSCLIENT_ID', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-1', isValid: false }));
      var sent = treatment(0, { carbs: 20, NSCLIENT_ID: 'nsc-1' });
      await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
    });

    it('on the fallback key', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, isValid: false }));
      var sent = treatment(0, { carbs: 20 });
      await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
    });

    it('in the similar match', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, isValid: false }));
      var sent = treatment(1000, { carbs: 20 });
      await shouldBeInserted('treatments', await dbAdd('treatments', sent), [before], sent);
    });
  });

  describe('treatments: 7. a similar match updates only created_at and srvModified', function () {

    it('keeps every other stored field, whatever else the write carries', async function () {
      var before = await seed('treatments', treatment(0, { carbs: 20, notes: 'stored note', enteredBy: TAG + '-stored', foodType: 'pasta' }));
      var result = await dbAdd('treatments', treatment(1500, { carbs: 20, notes: 'sent note', foodType: 'rice', absorptionTime: 180 }));
      await shouldBeSimilarMatch(result, before, at(1500));
      var after = (await stored())[0];
      Object.keys(plain(after)).sort().should.eql(Object.keys(plain(before)).sort());
      after.notes.should.equal('stored note');
      after.srvCreated.should.equal(before.srvCreated);
    });
  });

  describe('treatments: 8. WRITE_VALIDATION refusals keep their reply slot (reject)', function () {
    var MESSAGE_ORDER = 'Temporary Target: targetBottom must not be above targetTop';
    var MESSAGE_MMOL = 'Temporary Target: targetBottom is labelled units mmol but is above 30, so it is a mg/dL value: send units mg/dl, or targetBottom in mmol/L; '
      + 'targetTop is labelled units mmol but is above 30, so it is a mg/dL value: send units mg/dl, or targetTop in mmol/L';

    function target (offset, fields) {
      return Object.assign({ eventType: 'Temporary Target', created_at: at(offset), enteredBy: TAG, duration: 60 }, fields);
    }

    function refusalSlot (sent, message, rules) {
      return Object.assign(plain(sent), { refused: { status: 400, message: message, rules: rules } });
    }

    var ORDER_RULES = [{ rule: 'tt-order', field: 'targetBottom' }];
    var MMOL_RULES = [{ rule: 'tt-units-plausible', field: 'targetBottom' }, { rule: 'tt-units-plausible', field: 'targetTop' }];

    beforeEach(function () {
      self.env.writeValidation = 'reject';
    });

    it('a single refused record is answered with its refusal, nothing stored or announced', async function () {
      var sent = target(0, { targetTop: 100, targetBottom: 120, units: 'mg/dl' });
      var result = await dbAdd('treatments', sent);
      result.reply.should.eql([refusalSlot(sent, MESSAGE_ORDER, ORDER_RULES)]);
      result.events.should.eql([]);
      (await stored()).should.eql([]);
    });

    it('a single record whose similar match is an invalid stored target is refused in its slot', async function () {
      var before = await seed('treatments', target(0, { targetTop: 150, targetBottom: 140, units: 'mmol' }));
      var sent = target(1000, { targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      var result = await dbAdd('treatments', sent);
      result.reply.should.eql([refusalSlot(sent, MESSAGE_MMOL, MMOL_RULES)]);
      result.events.should.eql([]);
      (await stored()).map(plain).should.eql([plain(before)]);
    });

    it('a batch answers each item in its own slot: stored, refused, refused late, stored', async function () {
      var invalidStored = await seed('treatments', target(0, { targetTop: 150, targetBottom: 140, units: 'mmol' }));
      var first = target(-60000, { targetTop: 120, targetBottom: 110, units: 'mg/dl' });
      var refused = target(-30000, { targetTop: 100, targetBottom: 120, units: 'mg/dl' });
      var late = target(1000, { targetTop: 150, targetBottom: 140, units: 'mg/dl' });
      var last = target(60000, { targetTop: 130, targetBottom: 120, units: 'mg/dl' });
      var result = await dbAdd('treatments', [first, refused, late, last]);

      var after = await stored();
      after.length.should.equal(3);
      plain(after[1]).should.eql(plain(invalidStored));
      result.reply.should.eql([
        plain(after[0])
        , refusalSlot(refused, MESSAGE_ORDER, ORDER_RULES)
        , refusalSlot(late, MESSAGE_MMOL, MMOL_RULES)
        , plain(after[2])
      ]);
      after[0].created_at.should.equal(first.created_at);
      after[2].created_at.should.equal(last.created_at);
      result.events.should.eql(insertEvents('treatments', [after[0], after[2]]));
    });

    // today's behaviour; see report. In reject mode the similar match's
    // created_at update is a validated update (lib/storage/validated-update.js),
    // which also stores the derived durationInMilliseconds and endmills of a
    // Temporary Target. The reply carries neither: it is the record as read
    // before the update, with created_at and srvModified set.
    it('a valid re-send of a valid stored target is a similar match that also stores the derived duration fields', async function () {
      var before = await seed('treatments', target(0, { targetTop: 120, targetBottom: 110, units: 'mg/dl' }));
      var result = await dbAdd('treatments', target(1000, { targetTop: 120, targetBottom: 110, units: 'mg/dl' }));
      var after = await stored();
      after.length.should.equal(1);
      var replied = Object.assign(plain(before), { created_at: at(1000), srvModified: after[0].srvModified });
      plain(after[0]).should.eql(Object.assign({}, replied, {
        durationInMilliseconds: 3600000
        , endmills: T_MS + 1000 + 3600000
      }));
      after[0].srvModified.should.be.above(before.srvModified);
      result.reply.should.eql([replied]);
      result.events.should.eql([{ event: 'data-received' }]);
    });

    it('in off mode, the same similar match updates only created_at and srvModified', async function () {
      self.env.writeValidation = 'off';
      var before = await seed('treatments', target(0, { targetTop: 120, targetBottom: 110, units: 'mg/dl' }));
      var result = await dbAdd('treatments', target(1000, { targetTop: 120, targetBottom: 110, units: 'mg/dl' }));
      await shouldBeSimilarMatch(result, before, at(1000));
    });
  });

  describe('devicestatus: exact match on NSCLIENT_ID or created_at', function () {

    function status (offset, fields) {
      return Object.assign({ device: TAG, created_at: at(offset), uploaderBattery: 50 }, fields);
    }

    it('answers a re-send by NSCLIENT_ID, whatever its created_at', async function () {
      var before = await seed('devicestatus', status(0, { NSCLIENT_ID: 'nsc-ds-1' }));
      var result = await dbAdd('devicestatus', status(60000, { NSCLIENT_ID: 'nsc-ds-1', uploaderBattery: 40 }));
      await shouldBeExactMatch('devicestatus', result, before);
    });

    it('stores a record with another NSCLIENT_ID at the same created_at', async function () {
      var before = await seed('devicestatus', status(0, { NSCLIENT_ID: 'nsc-ds-1' }));
      var sent = status(0, { NSCLIENT_ID: 'nsc-ds-2' });
      await shouldBeInserted('devicestatus', await dbAdd('devicestatus', sent), [before], sent);
    });

    it('answers a re-send with no NSCLIENT_ID by created_at', async function () {
      var before = await seed('devicestatus', status(0));
      var result = await dbAdd('devicestatus', status(0, { uploaderBattery: 40 }));
      await shouldBeExactMatch('devicestatus', result, before);
    });

    it('stores a record 1 ms apart: there is no similar match', async function () {
      var before = await seed('devicestatus', status(0));
      var sent = status(1);
      await shouldBeInserted('devicestatus', await dbAdd('devicestatus', sent), [before], sent);
    });

    it('never matches a soft-deleted record', async function () {
      var before = await seed('devicestatus', status(0, { NSCLIENT_ID: 'nsc-ds-1', isValid: false }));
      var sent = status(0, { NSCLIENT_ID: 'nsc-ds-1' });
      await shouldBeInserted('devicestatus', await dbAdd('devicestatus', sent), [before], sent);
    });
  });

  describe('profile: replaced on NSCLIENT_ID or startDate', function () {

    function profile (fields) {
      return Object.assign({ defaultProfile: TAG, created_at: at(0), startDate: at(0), units: 'mg/dl', store: {} }, fields);
    }

    // The stored profile is replaced by the sent one: same _id, srvCreated
    // carried, a new srvModified; announced as an update.
    async function shouldBeReplaced (result, before, sent) {
      var after = await stored('profile');
      after.length.should.equal(1);
      var expected = Object.assign(plain(sent), { _id: plain(before)._id, srvCreated: before.srvCreated, srvModified: after[0].srvModified });
      plain(after[0]).should.eql(expected);
      after[0].srvModified.should.be.above(before.srvModified);
      result.reply.should.eql([expected]);
      result.events.should.eql(insertEvents('profile', [after[0]]));
    }

    it('replaces the stored profile with the same NSCLIENT_ID', async function () {
      var before = await seed('profile', profile({ NSCLIENT_ID: 'nsc-p-1', startDate: at(-60000), units: 'mmol' }));
      var sent = profile({ NSCLIENT_ID: 'nsc-p-1' });
      await shouldBeReplaced(await dbAdd('profile', sent), before, sent);
    });

    it('replaces the stored profile with the same startDate when no NSCLIENT_ID is sent', async function () {
      var before = await seed('profile', profile({ units: 'mmol', NSCLIENT_ID: 'nsc-p-1' }));
      var sent = profile({});
      await shouldBeReplaced(await dbAdd('profile', sent), before, sent);
    });

    it('stores a profile with another startDate', async function () {
      var before = await seed('profile', profile({}));
      var sent = profile({ startDate: at(1) });
      await shouldBeInserted('profile', await dbAdd('profile', sent), [before], sent);
    });

    it('stores a profile with neither NSCLIENT_ID nor startDate', async function () {
      var before = await seed('profile', profile({}));
      var sent = profile({});
      delete sent.startDate;
      await shouldBeInserted('profile', await dbAdd('profile', sent), [before], sent);
    });

    // today's behaviour; see report. The profile match has no isValid rule:
    // a soft-deleted profile is matched and replaced, and the replacement
    // (which does not carry isValid: false) brings it back.
    it('replaces a soft-deleted profile with the same NSCLIENT_ID', async function () {
      var before = await seed('profile', profile({ NSCLIENT_ID: 'nsc-p-1', isValid: false }));
      var sent = profile({ NSCLIENT_ID: 'nsc-p-1' });
      await shouldBeReplaced(await dbAdd('profile', sent), before, sent);
    });
  });

  describe('dbUpdate and dbUpdateUnset: the records an _id names (idMatch)', function () {

    async function seedWithId (id, fields) {
      return seed('treatments', treatment(0, Object.assign({ _id: id, notes: 'before' }, fields)));
    }

    function update (id, data) {
      return send('dbUpdate', { collection: 'treatments', _id: id, data: data });
    }

    function unset (id, data) {
      return send('dbUpdateUnset', { collection: 'treatments', _id: id, data: data });
    }

    // The events of an update: the record read back by the _id (one, even
    // when twins were updated), then data-received.
    function updateEvents (doc) {
      return [{ event: 'data-update', payload: { type: 'treatments', op: 'update', changes: runtime([doc]) } }
        , { event: 'data-received' }];
    }

    it('dbUpdate by a 24-hex _id reaches the record stored with the ObjectId', async function () {
      var before = await seedWithId(new ObjectID(IDS.updateOid));
      var result = await update(IDS.updateOid, { notes: 'after' });
      var after = await stored();
      after.length.should.equal(1);
      plain(after[0]).should.eql(Object.assign(plain(before), { notes: 'after', srvModified: after[0].srvModified }));
      after[0].srvModified.should.be.above(before.srvModified);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql(updateEvents(after[0]));
    });

    it('dbUpdate by a 24-hex _id reaches the string twin stored beside it', async function () {
      var oid = await seedWithId(new ObjectID(IDS.updateTwins));
      var str = await seedWithId(IDS.updateTwins, { created_at: at(1) });
      var result = await update(IDS.updateTwins, { notes: 'after' });
      var after = await col().find({ _id: { $in: [oid._id, str._id] } }).toArray();
      after.length.should.equal(2);
      after.forEach(function (doc) { doc.notes.should.equal('after'); });
      result.reply.should.eql({ result: 'success' });
      var announced = await col().findOne({ _id: { $in: [oid._id, str._id] } });
      result.events.should.eql(updateEvents(announced));
    });

    it('dbUpdate by a 24-hex _id reaches a record stored with the string only', async function () {
      var before = await seedWithId(IDS.updateString);
      var result = await update(IDS.updateString, { notes: 'after' });
      var after = await stored();
      plain(after).should.eql([Object.assign(plain(before), { notes: 'after', srvModified: after[0].srvModified })]);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql(updateEvents(after[0]));
    });

    it('dbUpdate by a custom string _id reaches that record only', async function () {
      var before = await seedWithId(CUSTOM);
      var other = await seed('treatments', treatment(1, { notes: 'before' }));
      var result = await update(CUSTOM, { notes: 'after' });
      var after = await stored();
      plain(after).should.eql([
        Object.assign(plain(before), { notes: 'after', srvModified: after[0].srvModified })
        , plain(other)
      ]);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql(updateEvents(after[0]));
    });

    it('dbUpdate by an _id that names nothing answers success and announces only data-received', async function () {
      var other = await seed('treatments', treatment(0, { notes: 'before' }));
      var result = await update(IDS.updateMissing, { notes: 'after' });
      plain(await stored()).should.eql([plain(other)]);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql([{ event: 'data-received' }]);
    });

    it('dbUpdateUnset by a 24-hex _id reaches the ObjectId record', async function () {
      var before = await seedWithId(new ObjectID(IDS.unsetOid), { foodType: 'pasta' });
      var result = await unset(IDS.unsetOid, { foodType: 1 });
      var after = await stored();
      var expected = Object.assign(plain(before), { srvModified: after[0].srvModified });
      delete expected.foodType;
      plain(after).should.eql([expected]);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql(updateEvents(after[0]));
    });

    it('dbUpdateUnset by a 24-hex _id reaches the string twin stored beside it', async function () {
      var oid = await seedWithId(new ObjectID(IDS.unsetTwins), { foodType: 'pasta' });
      var str = await seedWithId(IDS.unsetTwins, { created_at: at(1), foodType: 'pasta' });
      var result = await unset(IDS.unsetTwins, { foodType: 1 });
      var after = await col().find({ _id: { $in: [oid._id, str._id] } }).toArray();
      after.length.should.equal(2);
      after.forEach(function (doc) { should.not.exist(doc.foodType); });
      result.reply.should.eql({ result: 'success' });
      var announced = await col().findOne({ _id: { $in: [oid._id, str._id] } });
      result.events.should.eql(updateEvents(announced));
    });

    it('dbUpdateUnset by a custom string _id reaches that record only', async function () {
      var before = await seedWithId(CUSTOM, { foodType: 'pasta' });
      var other = await seed('treatments', treatment(1, { foodType: 'pasta' }));
      var result = await unset(CUSTOM, { foodType: 1 });
      var after = await stored();
      var expected = Object.assign(plain(before), { srvModified: after[0].srvModified });
      delete expected.foodType;
      plain(after).should.eql([expected, plain(other)]);
      result.reply.should.eql({ result: 'success' });
      result.events.should.eql(updateEvents(after[0]));
    });
  });
});
