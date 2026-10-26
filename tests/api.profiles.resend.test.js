'use strict';

// A profile re-sent with its own `_id` is merged into the stored profile and
// answered with the `_id` it is stored under (BF-166).
//
// POST /api/v1/profile with the `_id` of a profile already stored failed the
// whole request with 500 on the duplicate key, and the in-process create
// (nightscout-connect's internal output) passed the duplicate-key error to
// its callback. The write contract's re-send rule (decided 2026-10-12) is a
// merge: the fields sent are written, the fields left out are kept, and a
// re-send that changes nothing writes nothing. A PUT still replaces. A field
// sent as null is stored as null, as $set does today.

var request = require('supertest');
require('should');
var ObjectID = require('mongodb').ObjectId;
var language = require('../lib/language')();

describe('Profiles API: a profile re-sent with its own _id (BF-166)', function () {
  this.timeout(15000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
  var MARK = 'profile-resend-test';
  var n = 0;

  function nextHex () {
    n += 1;
    return '5f1b0000000000000000' + ('000' + n.toString(16)).slice(-4);
  }

  function sampleProfile (dia, extra) {
    // Synthetic values only.
    return Object.assign({
      defaultProfile: 'Default'
      , store: {
        Default: {
          dia: dia
          , carbratio: [{ time: '00:00', value: 30, timeAsSeconds: 0 }]
          , sens: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , basal: [{ time: '00:00', value: 0.1, timeAsSeconds: 0 }]
          , target_low: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , target_high: [{ time: '00:00', value: 100, timeAsSeconds: 0 }]
          , timezone: 'UTC'
          , units: 'mg/dl'
        }
      }
      , startDate: '2021-03-05T00:00:00.000Z'
      , units: 'mg/dl'
      , enteredBy: MARK
    }, extra || {});
  }

  function collection () {
    return self.ctx.store.collection(self.env.profile_collection);
  }

  function storedFor (hex) {
    return collection().find({ _id: { $in: [new ObjectID(hex), hex.toLowerCase(), hex.toUpperCase()] } }).toArray();
  }

  function post (body) {
    return request(self.app).post('/api/profile/').set('api-secret', known).send(body);
  }

  function postAsCreator (body) {
    return request(self.app).post('/api/profile/').set('api-secret', self.creatorToken).send(body);
  }

  function createInProcess (docs) {
    return new Promise(function (resolve, reject) {
      self.ctx.profile.create(docs, function (err, created) {
        if (err) return reject(err);
        resolve(created);
      });
    });
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
      collection().deleteMany({ enteredBy: MARK }).then(function () { done(); }, done);
    });
  });

  before(async function () {
    var auth = self.ctx.authorization.storage;
    var name = 'profile-resend-create-only';
    if (!auth.roles.some(function (role) { return role.name === name; })) {
      await new Promise(function (resolve, reject) {
        auth.createRole({ name: name, permissions: ['api:profile:read', 'api:profile:create'] },
          function (err) { if (err) reject(err); else resolve(); });
      });
    }
    if (!auth.subjects.some(function (subject) { return subject.name === name; })) {
      await new Promise(function (resolve, reject) {
        auth.createSubject({ name: name, roles: [name] },
          function (err) { if (err) reject(err); else resolve(); });
      });
    }
    self.creatorToken = auth.subjects.find(function (subject) { return subject.name === name; }).accessToken;
  });

  after(function () {
    return collection().deleteMany({ enteredBy: MARK });
  });

  it('create permission permits a new profile and its identical retry without changing history', async function () {
    var hex = nextHex();
    await postAsCreator(sampleProfile(5, { _id: hex })).expect(200);
    var before = (await storedFor(hex))[0];
    var retry = await postAsCreator(sampleProfile(5, { _id: hex })).expect(200);
    retry.body[0]._id.should.equal(hex);
    (await storedFor(hex)).should.eql([before]);
  });

  it('create permission cannot change an existing profile through POST or PUT', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex })).expect(200);
    var before = (await storedFor(hex))[0];
    await request(self.app).put('/api/profile/').set('api-secret', self.creatorToken)
      .send(sampleProfile(6, { _id: hex })).expect(401);
    await postAsCreator(sampleProfile(6, { _id: hex })).expect(401);
    (await storedFor(hex)).should.eql([before]);
  });

  it('create permission cannot merge into a legacy string ID through an upper-case re-send', async function () {
    var hex = nextHex();
    await collection().insertOne(sampleProfile(5, { _id: hex }));
    var before = (await storedFor(hex))[0];
    await postAsCreator(sampleProfile(6, { _id: hex.toUpperCase() })).expect(401);
    (await storedFor(hex)).should.eql([before]);
  });

  [false, true].forEach(function (newFirst) {
    it('refuses a mixed batch before any write with the new profile ' + (newFirst ? 'first' : 'last'), async function () {
      var hex = nextHex();
      var fresh = nextHex();
      await post(sampleProfile(5, { _id: hex })).expect(200);
      var before = (await storedFor(hex))[0];
      var docs = [sampleProfile(6, { _id: hex }), sampleProfile(4, { _id: fresh })];
      if (newFirst) docs.reverse();
      await postAsCreator(docs).expect(401);
      (await storedFor(hex)).should.eql([before]);
      (await storedFor(fresh)).should.eql([]);
    });
  });

  it('checks every existing-profile re-send, including a change after an identical retry', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex })).expect(200);
    var before = (await storedFor(hex))[0];
    await postAsCreator([sampleProfile(5, { _id: hex }), sampleProfile(6, { _id: hex })]).expect(401);
    (await storedFor(hex)).should.eql([before]);
  });

  it('create permission can merge repeated new IDs within the same upload', async function () {
    var hex = nextHex();
    await postAsCreator([sampleProfile(5, { _id: hex, kept: 'first' }), sampleProfile(6, { _id: hex })]).expect(200);
    var stored = await storedFor(hex);
    stored.length.should.equal(1);
    stored[0].store.Default.dia.should.equal(6);
    stored[0].kept.should.equal('first');
  });

  ['lower', 'upper'].forEach(function (spelling) {
    it('a POST re-sending a stored profile\'s _id in ' + spelling + ' case answers 200 with the stored _id', async function () {
      var hex = nextHex();
      await post(sampleProfile(5, { _id: hex })).expect(200);

      var sent = spelling === 'upper' ? hex.toUpperCase() : hex;
      var res = await post(sampleProfile(5, { _id: sent })).expect(200);
      res.body.should.have.length(1);
      res.body[0]._id.should.equal(hex);

      var stored = await storedFor(hex);
      stored.length.should.equal(1);
      (stored[0]._id instanceof ObjectID).should.equal(true);
    });
  });

  it('a differing re-send updates the fields it sends and keeps the ones it leaves out', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex, kept: 'only in the first upload' })).expect(200);
    var before = (await storedFor(hex))[0];

    await post(sampleProfile(6, { _id: hex, units: 'mmol' })).expect(200);

    var stored = await storedFor(hex);
    stored.length.should.equal(1);
    stored[0].store.Default.dia.should.equal(6);
    stored[0].units.should.equal('mmol');
    stored[0].kept.should.equal('only in the first upload');
    stored[0].created_at.should.equal(before.created_at);
    stored[0].srvCreated.should.equal(before.srvCreated);
    stored[0].srvModified.should.be.above(before.srvModified);
  });

  it('an identical re-send writes nothing: srvModified does not move', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex })).expect(200);
    var before = (await storedFor(hex))[0];

    await post(sampleProfile(5, { _id: hex })).expect(200);

    var after = (await storedFor(hex))[0];
    after.srvModified.should.equal(before.srvModified);
    after.created_at.should.equal(before.created_at);
  });

  it('a field re-sent as null is stored as null (no RFC 7386 removal)', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex, kept: 'value' })).expect(200);
    await post(sampleProfile(5, { _id: hex, kept: null })).expect(200);
    var stored = (await storedFor(hex))[0];
    stored.should.have.property('kept', null);
  });

  it('a PUT still replaces the whole profile', async function () {
    var hex = nextHex();
    await post(sampleProfile(5, { _id: hex, kept: 'value' })).expect(200);
    await request(self.app).put('/api/profile/').set('api-secret', known)
      .send(sampleProfile(7, { _id: hex })).expect(200);
    var stored = await storedFor(hex);
    stored.length.should.equal(1);
    stored[0].store.Default.dia.should.equal(7);
    stored[0].should.not.have.property('kept');
  });

  it('a batch that re-sends one profile and adds another stores the new one', async function () {
    var stored = nextHex();
    var fresh = nextHex();
    await post(sampleProfile(5, { _id: stored })).expect(200);

    var res = await post([sampleProfile(5, { _id: stored }), sampleProfile(6, { _id: fresh })]).expect(200);
    res.body.map(function (doc) { return doc._id; }).should.eql([stored, fresh]);
    (await storedFor(stored)).length.should.equal(1);
    var added = await storedFor(fresh);
    added.length.should.equal(1);
    added[0].store.Default.dia.should.equal(6);
  });

  it('the same new _id twice in one batch is stored once, with the second merged in', async function () {
    var hex = nextHex();
    await post([sampleProfile(5, { _id: hex, kept: 'first' }), sampleProfile(6, { _id: hex })]).expect(200);
    var stored = await storedFor(hex);
    stored.length.should.equal(1);
    stored[0].store.Default.dia.should.equal(6);
    stored[0].kept.should.equal('first');
  });

  it('a profile stored with a lower-case string _id and re-sent in upper case is merged, not copied', async function () {
    var hex = nextHex();
    await collection().insertOne(sampleProfile(5, { _id: hex }));

    var res = await post(sampleProfile(6, { _id: hex.toUpperCase() })).expect(200);
    res.body[0]._id.should.equal(hex);
    var stored = await storedFor(hex);
    stored.length.should.equal(1);
    (typeof stored[0]._id).should.equal('string');
    stored[0].store.Default.dia.should.equal(6);
  });

  it('an in-process re-send with the stored ObjectId answers its callback without an error', async function () {
    var id = new ObjectID(nextHex());
    await createInProcess([sampleProfile(5, { _id: id })]);
    var created = await createInProcess([sampleProfile(6, { _id: id })]);
    String(created[0]._id).should.equal(id.toHexString());
    var stored = await collection().find({ _id: id }).toArray();
    stored.length.should.equal(1);
    stored[0].store.Default.dia.should.equal(6);
  });

  it('an in-process re-send with a hex string answers its callback with the stored _id', async function () {
    var hex = nextHex();
    await createInProcess([sampleProfile(5, { _id: hex })]);
    var created = await createInProcess(sampleProfile(5, { _id: hex }));
    String(created[0]._id).should.equal(hex);
    (await storedFor(hex)).length.should.equal(1);
  });

  it('a new profile without _id is still stored and answered with a new _id (control)', async function () {
    var res = await post(sampleProfile(4)).expect(200);
    String(res.body[0]._id).should.match(/^[0-9a-f]{24}$/);
    (await storedFor(String(res.body[0]._id))).length.should.equal(1);
  });
});
