'use strict';

// ID-BATCH: per-item results in API v1 batch replies (lib/api/shared/batch-reply.js).
//
// What the clients that send v1 arrays need from a reply (ID-BATCH design note
// §2, client lines re-read in the reply lab tools/lab/id-batch-replies):
// - NightscoutKit (Loop): HTTP 200 only; an array with exactly as many
//   elements as it sent; `_id` read per slot, as a string; a slot without
//   `_id` counts as uploaded.
// - xdripswift: an array; each slot matched to a local record by content
//   (created_at, eventType, value).
// - nightscout-connect: the sync bookmark is the newest dateString or
//   created_at in the reply, so a slot must echo its item's and no slot may
//   carry a date the client did not send.
// Default replies are what those clients get; the opt-in
// (Nightscout-Write-Results: items, or ?results=items) is for a client that
// asks. Synthetic values only; every record is dated in March 2020.

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
var TAG = 'id-batch-replies-test';
var T = Date.parse('2020-03-14T09:00:00.000Z');
function at (minutes) { return new Date(T + minutes * 60000).toISOString(); }
function ms (minutes) { return T + minutes * 60000; }
var HEX = '5e6c9a0000000000000000';
function hex (n) { return HEX + ('0' + n.toString(16)).slice(-2); }

describe('ID-BATCH: API v1 batch replies', function () {
  this.timeout(20000);
  var self = this;

  function col (name) { return self.ctx.store.collection(self.env[name + '_collection'] || name); }
  function dropAll () {
    return Promise.all(['treatments', 'entries', 'devicestatus', 'profile', 'food', 'activity'].map(function (name) {
      return col(name).deleteMany({ enteredBy: TAG });
    }));
  }
  // WRITE_IDENTIFIER is read from env.write.identifier, WRITE_VALIDATION
  // from env.writeValidation (lib/server/write-validation.js).
  function setMode (fields) {
    var f = Object.assign({ validation: 'off', identifier: 'lenient' }, fields || {});
    self.env.write = Object.freeze(Object.assign({}, self.env.write, { validation: f.validation, identifier: f.identifier }));
    self.env.writeValidation = f.validation;
  }
  function quiet (work) {
    var log = console.log; var warn = console.warn;
    console.log = function () { }; console.warn = function () { };
    return Promise.resolve().then(work).finally(function () { console.log = log; console.warn = warn; });
  }
  function post (path, body, opts) {
    var o = opts || {};
    return quiet(function () {
      var r = request(self.app).post('/api/' + path + (o.query ? '?' + o.query : '')).set('api-secret', o.secret || known);
      if (o.optIn) r = r.set('Nightscout-Write-Results', o.optIn === true ? 'items' : o.optIn);
      return r.send(body);
    });
  }

  function treatment (minutes, fields) {
    return Object.assign({ eventType: 'Carb Correction', carbs: 10 + minutes, created_at: at(minutes), enteredBy: TAG }, fields);
  }
  function entry (minutes, fields) {
    return Object.assign({ type: 'sgv', sgv: 100 + minutes, date: ms(minutes), dateString: at(minutes), enteredBy: TAG }, fields);
  }
  function status (minutes, fields) {
    return Object.assign({ device: 'id-batch-test', created_at: at(minutes), uploaderBattery: 50 + minutes, enteredBy: TAG }, fields);
  }
  function profile (dia, fields) {
    return Object.assign({ defaultProfile: 'Default', startDate: at(dia), created_at: at(dia), units: 'mg/dl', enteredBy: TAG
      , store: { Default: { dia: dia, carbratio: [{ time: '00:00', value: 30 }], sens: [{ time: '00:00', value: 100 }]
        , basal: [{ time: '00:00', value: 0.1 }], target_low: [{ time: '00:00', value: 100 }]
        , target_high: [{ time: '00:00', value: 120 }], timezone: 'UTC', units: 'mg/dl' } } }, fields);
  }

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    delete process.env.WRITE_IDENTIFIER;
    delete process.env.WRITE_VALIDATION;
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.app = require('express')();
    require('../lib/middleware/configure-request')(self.app);
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      dropAll().then(function () { done(); }, done);
    });
  });
  before(async function () {
    var auth = self.ctx.authorization.storage;
    var name = 'id-batch-profile-create-only';
    if (!auth.roles.some(function (role) { return role.name === name; })) {
      await new Promise(function (resolve, reject) {
        auth.createRole({ name: name, permissions: ['api:profile:read', 'api:profile:create'] }, function (err) { if (err) reject(err); else resolve(); });
      });
    }
    if (!auth.subjects.some(function (subject) { return subject.name === name; })) {
      await new Promise(function (resolve, reject) {
        auth.createSubject({ name: name, roles: [name] }, function (err) { if (err) reject(err); else resolve(); });
      });
    }
    self.creatorToken = auth.subjects.find(function (subject) { return subject.name === name; }).accessToken;
  });
  beforeEach(function () { setMode(); return dropAll(); });
  after(function () { setMode(); return dropAll(); });

  describe('plan() takes only an array as a batch', function () {
    var plan = require('../lib/api/shared/batch-reply').plan;
    it('a string is no item, a lone object is one, an array is itself', function () {
      plan('abcdef', { env: {} }).n.should.equal(0);
      plan(null, { env: {} }).n.should.equal(0);
      var one = plan({ carbs: 5 }, { env: {} });
      one.n.should.equal(1);
      one.accepted.should.eql([{ carbs: 5 }]);
      plan([{ carbs: 1 }, { carbs: 2 }], { env: {} }).n.should.equal(2);
    });
  });

  describe('G1: the default reply (no opt-in) is an array of slots, as before', function () {
    ['treatments', 'entries', 'devicestatus', 'profile'].forEach(function (name) {
      it(name + ': an array, one slot per item, the stored records, no per-item results', async function () {
        var body = { treatments: [treatment(0), treatment(1)], entries: [entry(0), entry(1)]
          , devicestatus: [status(0), status(1)], profile: [profile(3), profile(4)] }[name];
        var res = await post(name + '/', body);
        res.status.should.equal(200);
        Array.isArray(res.body).should.equal(true, 'the default body is an array');
        res.body.length.should.equal(2);
        res.body.forEach(function (slot) {
          slot._id.should.be.a.String();
          slot.should.not.have.properties(['refused', 'outcome', 'warnings', 'items', 'documents']);
        });
        should.not.exist(res.headers.warning);
      });
    });

    it('a non-hex _id still refuses the whole devicestatus batch with 400 (R2 per item is opt-in)', async function () {
      var res = await post('devicestatus/', [status(0), status(1, { _id: 'not-hex' })]);
      res.status.should.equal(400);
      (await col('devicestatus').countDocuments({ enteredBy: TAG })).should.equal(0);
    });

    it('a profile re-send that needs api:profile:update still refuses the whole batch with 401 (decision (iii))', async function () {
      (await post('profile/', profile(3, { _id: hex(1) }))).status.should.equal(200);
      var res = await post('profile/', [profile(5), profile(4, { _id: hex(1) })], { secret: self.creatorToken });
      res.status.should.equal(401);
      (await col('profile').countDocuments({ enteredBy: TAG })).should.equal(1, 'nothing written');
    });
  });

  describe('NightscoutKit (Loop): 200, as many slots as sent, a string _id on every slot not refused', function () {
    it('under WRITE_IDENTIFIER=strict, a refused item keeps its slot: three sent, three answered', async function () {
      setMode({ identifier: 'strict' });
      var sent = [treatment(0, { syncIdentifier: 'loop-a' }), treatment(1, { identifier: 'undefined' }), treatment(2, { syncIdentifier: 'loop-c' })];
      var res = await post('treatments/', sent);
      res.status.should.equal(200, 'Loop accepts only 200');
      res.body.should.be.an.Array();
      res.body.length.should.equal(sent.length, 'the count Loop checks');
      res.body[0]._id.should.be.a.String();
      res.body[2]._id.should.be.a.String();
      res.body[1].should.not.have.property('_id');
      res.body[1].refused.status.should.equal(400);
      res.body.map(function (s) { return s.carbs; }).should.eql([10, 11, 12], 'zipped by position');
    });

    it('entries and device status: as many slots as sent, each with a string _id', async function () {
      var e = await post('entries/', [entry(0), entry(1), entry(2)]);
      e.status.should.equal(200);
      e.body.length.should.equal(3);
      e.body.forEach(function (s) { s._id.should.be.a.String(); });
      var d = await post('devicestatus/', [status(0), status(1)]);
      d.status.should.equal(200);
      d.body.length.should.equal(2);
      d.body.forEach(function (s) { s._id.should.be.a.String(); });
    });

    it('a treatment with preBolus: one slot per sent item, no derived record in the reply (BF-219)', async function () {
      var res = await post('treatments/', [treatment(0), treatment(1, { preBolus: 10, carbs: 30 })]);
      res.status.should.equal(200);
      res.body.length.should.equal(2);
      // The derived record carries only created_at, eventType and carbs (no
      // enteredBy), so it is found by its own created_at: the sent one plus
      // preBolus minutes. Other files' records in the shared database are
      // never counted, and the derived record is removed here, since the
      // cleanup by enteredBy cannot see it.
      var derived = { created_at: at(11), eventType: 'Carb Correction', enteredBy: { $exists: false } };
      try {
        (await col('treatments').countDocuments({ enteredBy: TAG })).should.equal(2, 'both sent items are stored');
        (await col('treatments').countDocuments(derived)).should.equal(1, 'the derived record is stored');
      } finally {
        await col('treatments').deleteMany(derived);
      }
    });
  });

  describe('xdripswift and nightscout-connect: each slot echoes its own item', function () {
    it('treatments: created_at, eventType and carbs echoed slot by slot', async function () {
      var sent = [treatment(0), treatment(5, { eventType: 'Meal Bolus', insulin: 1.5 }), treatment(9)];
      var res = await post('treatments/', sent);
      res.body.forEach(function (slot, i) {
        slot.created_at.should.equal(sent[i].created_at);
        slot.eventType.should.equal(sent[i].eventType);
        slot.carbs.should.equal(sent[i].carbs);
      });
    });

    it('entries: dateString echoed, and the newest date in the reply is the newest sent (the connect bookmark)', async function () {
      var sent = [entry(0), entry(5), entry(10)];
      var res = await post('entries/', sent);
      res.body.map(function (s) { return s.dateString; }).should.eql(sent.map(function (s) { return s.dateString; }));
      var newest = res.body.map(function (s) { return Date.parse(s.dateString); }).reduce(function (a, b) { return Math.max(a, b); });
      newest.should.equal(ms(10));
    });

    it('treatments with preBolus: the newest created_at in the reply is the newest sent', async function () {
      var res = await post('treatments/', [treatment(0, { preBolus: 20, carbs: 40 }), treatment(5)]);
      var newest = res.body.map(function (s) { return Date.parse(s.created_at); }).reduce(function (a, b) { return Math.max(a, b); });
      newest.should.equal(ms(5), 'the derived record at +20 min is not in the reply');
    });
  });

  describe('R3: status', function () {
    it('a partly refused batch answers 200; every item refused answers 400; every item a taken _id answers 200', async function () {
      setMode({ identifier: 'strict' });
      (await post('treatments/', [treatment(0), treatment(1, { identifier: 'null' })])).status.should.equal(200);
      var all = await post('treatments/', [treatment(2, { identifier: 'null' }), treatment(3, { identifier: '' })]);
      all.status.should.equal(400);
      all.body.message.should.equal('identifier: identifier is a placeholder; identifier: identifier is empty');
      setMode();
      await col('entries').insertOne({ _id: new (require('mongodb').ObjectId)(hex(9)), type: 'sgv', sgv: 90, date: ms(-600)
        , dateString: at(-600), sysTime: at(-600), enteredBy: TAG });
      var taken = await post('entries/', [entry(30, { _id: hex(9) })]);
      taken.status.should.equal(200, 'decided: a taken _id is refused 409 in its slot and answered 200');
      taken.body[0].refused.status.should.equal(409);
    });

    it('opt-in: partly refused 200; every item refused 400 with the slots', async function () {
      var part = await post('devicestatus/', [status(0), status(1, { _id: 'not-hex' })], { optIn: true });
      part.status.should.equal(200);
      var all = await post('devicestatus/', [status(2, { _id: 'not-hex' }), status(3, { _id: 'also-not-hex' })], { optIn: true });
      all.status.should.equal(400);
      all.body.documents.length.should.equal(2);
      all.body.items.map(function (i) { return i.outcome; }).should.eql(['refused', 'refused']);
    });
  });

  describe('the opt-in (decision (ii)): Nightscout-Write-Results: items', function () {
    it('answers { items, documents }: one item per submitted index, in order, with outcomes', async function () {
      var res = await post('treatments/', [treatment(0, { identifier: 'opt-a' }), treatment(1, { identifier: 'undefined' })], { optIn: true });
      res.status.should.equal(200);
      res.body.should.have.properties(['items', 'documents']);
      res.body.documents.length.should.equal(2);
      res.body.items.map(function (i) { return i.index; }).should.eql([0, 1]);
      res.body.items[0].outcome.should.equal('inserted');
      res.body.items[0].identifier.should.equal('opt-a');
      String(res.body.items[0]._id).should.equal(String(res.body.documents[0]._id));
      res.body.items[1].warnings.should.eql(['identifier ignored']);
      res.headers.warning.should.equal('299 - "1 identifier ignored"');
    });

    it('?results=items is the same opt-in; any other value is refused 400 before anything is written', async function () {
      var q = await post('entries/', [entry(0)], { query: 'results=items' });
      q.status.should.equal(200);
      q.body.items.length.should.equal(1);
      var bad = await post('entries/', [entry(1)], { optIn: 'slots' });
      bad.status.should.equal(400);
      (await col('entries').countDocuments({ enteredBy: TAG })).should.equal(1, 'the refused request wrote nothing');
    });

    it('R2: a non-hex _id refuses its item, the rest stored', async function () {
      var res = await post('profile/', [profile(3), profile(4, { _id: 'not-hex' }), profile(5)], { optIn: true });
      res.status.should.equal(200);
      res.body.documents[1].refused.should.eql({ status: 400, message: 'Invalid _id format', rules: [{ rule: 'objectid-format', field: '_id' }] });
      res.body.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'refused', 'inserted']);
      res.headers.warning.should.equal('299 - "1 of 3 items refused"');
      (await col('profile').countDocuments({ enteredBy: TAG })).should.equal(2);
    });

    it('(iii): a profile re-send needing api:profile:update is refused 403 in its slot, the new profiles stored', async function () {
      (await post('profile/', profile(3, { _id: hex(2) }))).status.should.equal(200);
      var res = await post('profile/', [profile(5), profile(4, { _id: hex(2) }), profile(6)], { secret: self.creatorToken, optIn: true });
      res.status.should.equal(200);
      res.body.documents[1].refused.status.should.equal(403);
      res.body.documents[1].should.not.have.property('_id');
      res.body.items.map(function (i) { return i.outcome; }).should.eql(['inserted', 'refused', 'inserted']);
      (await col('profile').countDocuments({ enteredBy: TAG })).should.equal(3);
      (await col('profile').findOne({ _id: new (require('mongodb').ObjectId)(hex(2)) })).store.Default.dia.should.equal(3, 'unchanged');
    });

    it('(vi): a device status re-sent by its stored _id is acknowledged, counted, nothing written', async function () {
      (await post('devicestatus/', [status(0, { _id: hex(3) })])).status.should.equal(200);
      var res = await post('devicestatus/', [status(0, { _id: hex(3) }), status(1)], { optIn: true });
      res.status.should.equal(200);
      res.body.items[0].outcome.should.equal('acknowledged');
      res.body.items[0].warnings.should.eql(['acknowledged, not applied']);
      res.body.items[1].outcome.should.equal('inserted');
      res.headers.warning.should.equal('299 - "1 acknowledged, not applied"');
    });

    it('(vi): a treatment re-sent with a deleted record\'s identifier is acknowledged and stays deleted', async function () {
      (await post('treatments/', [treatment(0, { identifier: 'deleted-x' })])).status.should.equal(200);
      await col('treatments').updateOne({ identifier: 'deleted-x' }, { $set: { isValid: false } });
      var res = await post('treatments/', [treatment(0, { identifier: 'deleted-x', carbs: 99 })], { optIn: true });
      res.status.should.equal(200);
      res.body.items[0].outcome.should.equal('acknowledged');
      (await col('treatments').findOne({ identifier: 'deleted-x' })).isValid.should.equal(false);
    });

    it('WRITE_VALIDATION=reject: every Temporary Target refused keeps its slots under the opt-in (400 with the slots)', async function () {
      setMode({ validation: 'reject' });
      var bad = { eventType: 'Temporary Target', targetBottom: 150, targetTop: 120, units: 'mg/dl', duration: 30 };
      var res = await post('treatments/', [treatment(0, bad), treatment(1, bad)], { optIn: true });
      res.status.should.equal(400);
      res.body.documents.length.should.equal(2);
      res.body.documents.forEach(function (d) { d.refused.status.should.equal(400); });
      var plain = await post('treatments/', [treatment(2, bad)]);
      plain.status.should.equal(400);
      plain.body.should.not.have.property('documents', 'the default keeps its 400 message');
    });
  });
});
