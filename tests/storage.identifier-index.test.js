'use strict';

// ID-UNIQUE-INDEX (maintainer, 2026-10-30): the partial unique index on
// `identifier` per collection, under WRITE_IDENTIFIER_INDEX=try|require|off,
// and the operator tool that reports and resolves the records that block it.
//
// The index covers the records whose identifier is a non-empty string,
// soft-deleted ones included. Records with an empty, null, absent or
// non-string identifier are left out, so any number of them can be stored.
// Under `try` stored duplicates leave the collection without the index; their
// counts (never the values) are logged and shown on the status page. Under
// `require` they stop the boot. Under `off` nothing is built.
//
// Synthetic values only.

var should = require('should');
var request = require('supertest');
var language = require('../lib/language')();
var identifierIndex = require('../lib/storage/identifier-index');
var tool = require('../tools/identifier-duplicates');
var { ObjectId } = require('mongodb');

var ID = 'a7c0ffee-0000-4000-8000-00000000d001';
var OTHER = 'a7c0ffee-0000-4000-8000-00000000d002';

function bootWith (mode) {
  var saved = process.env.WRITE_IDENTIFIER_INDEX;
  if (mode === undefined) delete process.env.WRITE_IDENTIFIER_INDEX;
  else process.env.WRITE_IDENTIFIER_INDEX = mode;
  process.env.API_SECRET = 'this is my long pass phrase';
  var env = require('../lib/server/env')();
  if (saved === undefined) delete process.env.WRITE_IDENTIFIER_INDEX;
  else process.env.WRITE_IDENTIFIER_INDEX = saved;
  env.settings.authDefaultRoles = 'readable';
  env.settings.enable = ['careportal', 'api'];
  return new Promise(function (resolve) {
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) { resolve({ env: env, ctx: ctx }); });
  });
}

describe('ID-UNIQUE-INDEX: the partial unique index on identifier', function () {
  this.timeout(30000);
  var self = this;

  function col (name) {
    return self.ctx.store.collection(self.env[name + '_collection']);
  }

  async function dropIdentifierIndexes () {
    for (var name of ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings']) {
      try { await col(name).dropIndex(identifierIndex.INDEX_NAME); } catch { /* not there */ }
    }
  }

  async function clean () {
    for (var name of ['treatments', 'devicestatus', 'food']) {
      await col(name).deleteMany({ idxTest: true });
    }
  }

  before(async function () {
    var booted = await bootWith(undefined);
    self.env = booted.env;
    self.ctx = booted.ctx;
    await clean();
    await dropIdentifierIndexes();
  });

  after(async function () {
    await clean();
    await dropIdentifierIndexes();
  });

  describe('which records the index covers', function () {
    var probe;

    beforeEach(async function () {
      probe = self.ctx.store.collection('identifier_index_probe');
      await probe.deleteMany({});
      try { await probe.dropIndex(identifierIndex.INDEX_NAME); } catch { /* not there */ }
    });

    after(async function () {
      try { await probe.drop(); } catch { /* gone */ }
    });

    it('is built over records without a string identifier, any number of each', async function () {
      await probe.insertMany([
        { v: 1 }, { v: 2 }
        , { identifier: null }, { identifier: null }
        , { identifier: '' }, { identifier: '' }
        , { identifier: 5 }, { identifier: 5 }
      ]);
      var status = await identifierIndex.ensure([{ name: 'probe', collection: probe }], 'try', { log: { warn: function () {} } });
      status.collections.probe.state.should.equal('built');
      status.ready.should.equal(true);
      await probe.insertMany([{ identifier: null }, { identifier: '' }, { v: 3 }]);
      (await probe.countDocuments({})).should.equal(11);
    });

    it('counts an identifier array by element, as the index keys it: arrays sharing "" block the build', async function () {
      // An array holding a non-empty string is covered, and then each of its
      // elements is a key, "" and null included (BF-215-era stored values).
      await probe.insertMany([{ identifier: ['', 'a'] }, { identifier: ['', 'b'] }, { identifier: '' }]);
      var counts = await identifierIndex.duplicateCounts(probe);
      counts.should.eql({ identifiers: 1, records: 2 });
      var status = await identifierIndex.ensure([{ name: 'probe', collection: probe }], 'try', { log: { warn: function () {} } });
      // The two arrays are also counted as stored non-string identifiers.
      status.collections.probe.should.eql({ state: 'blocked', identifiers: 1, records: 2, nonString: 2 });
    });

    it('refuses a second record with one identifier, a soft-deleted one included', async function () {
      await identifierIndex.ensure([{ name: 'probe', collection: probe }], 'try');
      await probe.insertOne({ identifier: ID, isValid: false });
      var err = await probe.insertOne({ identifier: ID }).then(function () { return null; }, function (e) { return e; });
      should.exist(err);
      identifierIndex.isDuplicateIdentifier(err).should.equal(true);
      var other = await probe.insertOne({ _id: 'same', identifier: OTHER }).then(function () {
        return probe.insertOne({ _id: 'same', identifier: 'another' });
      }).then(function () { return null; }, function (e) { return e; });
      should.exist(other);
      identifierIndex.isDuplicateIdentifier(other).should.equal(false, 'a duplicate _id is not one');
    });
  });

  describe('try, require and off at boot', function () {
    afterEach(async function () {
      await clean();
    });

    it('try with no duplicates: every collection has the index', async function () {
      var booted = await bootWith('try');
      booted.ctx.identifierIndex.ready.should.equal(true);
      Object.keys(booted.ctx.identifierIndex.collections).sort().should.eql(
        ['activity', 'devicestatus', 'entries', 'food', 'profile', 'settings', 'treatments']);
      should.exist(await identifierIndex.existingIndex(col('treatments')));
    });

    it('try with stored duplicates: logs the counts, shows them on the status page, and runs without the index', async function () {
      await dropIdentifierIndexes();
      await col('treatments').insertMany([
        { identifier: ID, eventType: 'Note', created_at: '2019-05-11T07:40:00.000Z', idxTest: true }
        , { identifier: ID, eventType: 'Note', created_at: '2019-05-11T07:42:00.000Z', idxTest: true }
        , { identifier: ID, eventType: 'Note', created_at: '2019-05-11T07:44:00.000Z', idxTest: true, isValid: false }
        , { identifier: OTHER, eventType: 'Note', created_at: '2019-05-11T07:40:00.000Z', idxTest: true }
        , { identifier: OTHER, eventType: 'Note', created_at: '2019-05-11T07:41:00.000Z', idxTest: true }
      ]);
      var warnings = [];
      var realWarn = console.warn;
      console.warn = function (line) { warnings.push(String(line)); };
      var booted;
      try {
        booted = await bootWith('try');
      } finally {
        console.warn = realWarn;
      }
      should.not.exist(booted.ctx.bootErrors && booted.ctx.bootErrors[0]);
      var status = booted.ctx.identifierIndex;
      status.ready.should.equal(false);
      status.collections.treatments.should.eql({ state: 'blocked', identifiers: 2, records: 5 });
      status.collections.devicestatus.state.should.be.oneOf('built', 'present');
      should.not.exist(await identifierIndex.existingIndex(col('treatments')));
      var line = warnings.filter(function (w) { return w.indexOf('identifier index on treatments') !== -1; });
      line.length.should.equal(1);
      line[0].should.containEql('2 identifier(s) are each held by more than one record (5 records)');
      line[0].should.not.containEql(ID);
      line[0].should.not.containEql(OTHER);

      var app = require('express')();
      app.enable('api');
      app.use('/api', require('../lib/api/')(booted.env, booted.ctx));
      var res = await request(app).get('/api/status.json').set('api-secret', require('crypto')
        .createHash('sha1').update('this is my long pass phrase').digest('hex')).expect(200);
      res.body.identifierIndex.ready.should.equal(false);
      res.body.identifierIndex.collections.treatments.should.eql({ state: 'blocked', duplicateIdentifiers: 2, duplicateRecords: 5 });
      JSON.stringify(res.body.identifierIndex).should.not.containEql(ID);
      (booted.ctx.adminnotifies.getNotifies ? booted.ctx.adminnotifies.getNotifies() : booted.ctx.adminnotifies.notifies || [])
        .some(function (n) { return n.title === 'Records share an identifier'; }).should.equal(true);
    });

    it('try counts stored identifiers that are not strings on their own line, counts only', async function () {
      await dropIdentifierIndexes();
      await col('treatments').insertMany([
        { identifier: ['a7c0ffee-array'], eventType: 'Note', idxTest: true }
        , { identifier: null, eventType: 'Note', idxTest: true }
        , { identifier: 42, eventType: 'Note', idxTest: true }
        , { identifier: ID, eventType: 'Note', idxTest: true }
      ]);
      var warnings = [];
      var realWarn = console.warn;
      console.warn = function (line) { warnings.push(String(line)); };
      var booted;
      try {
        booted = await bootWith('try');
      } finally {
        console.warn = realWarn;
      }
      var status = booted.ctx.identifierIndex;
      status.collections.treatments.state.should.equal('built');
      status.collections.treatments.nonString.should.equal(3);
      var line = warnings.filter(function (w) { return w.indexOf('identifier index on treatments: 3 record(s) store an identifier that is not') !== -1; });
      line.length.should.equal(1);
      line[0].should.not.containEql('a7c0ffee-array');
      identifierIndex.summary(status).collections.treatments.should.eql({ state: 'built', nonStringIdentifiers: 3 });
    });

    it('an identifier array is not stored: writes treat a non-string identifier as absent (slice 2)', async function () {
      var booted = await bootWith('try');
      var app = require('express')();
      app.enable('api');
      booted.ctx.ddata = require('../lib/data/ddata')();
      app.use('/api', require('../lib/api/')(booted.env, booted.ctx));
      await request(app).post('/api/treatments/').set('api-secret', require('crypto')
        .createHash('sha1').update('this is my long pass phrase').digest('hex'))
        .send([{ identifier: ['a'], eventType: 'Note', notes: 'array identifier', created_at: '2019-05-11T07:40:00.000Z', idxTest: true }])
        .expect(200);
      var docs = await col('treatments').find({ idxTest: true, notes: 'array identifier' }).toArray();
      docs.length.should.equal(1);
      docs[0].should.not.have.property('identifier');
    });

    it('require with stored duplicates: refuses to start', async function () {
      await dropIdentifierIndexes();
      await col('food').insertMany([
        { identifier: ID, name: 'a', idxTest: true }, { identifier: ID, name: 'b', idxTest: true }
      ]);
      var booted = await bootWith('require');
      should.exist(booted.ctx.bootErrors);
      booted.ctx.bootErrors.length.should.be.above(0);
      booted.ctx.bootErrors[0].desc.should.containEql('WRITE_IDENTIFIER_INDEX=require');
      JSON.stringify(booted.ctx.bootErrors).should.containEql('identifier index on food: 1 identifier(s)');
      JSON.stringify(booted.ctx.bootErrors).should.not.containEql(ID);
    });

    it('require with no duplicates: starts, with the index', async function () {
      await dropIdentifierIndexes();
      var booted = await bootWith('require');
      should.not.exist(booted.ctx.bootErrors && booted.ctx.bootErrors[0]);
      booted.ctx.identifierIndex.ready.should.equal(true);
    });

    it('off: builds nothing', async function () {
      await dropIdentifierIndexes();
      var booted = await bootWith('off');
      booted.ctx.identifierIndex.mode.should.equal('off');
      should.not.exist(await identifierIndex.existingIndex(col('treatments')));
      should.not.exist(await identifierIndex.existingIndex(col('entries')));
    });

    it('an unknown value refuses to start', async function () {
      var booted = await bootWith('maybe');
      should.exist(booted.ctx.bootErrors);
      JSON.stringify(booted.ctx.bootErrors).should.containEql('WRITE_IDENTIFIER_INDEX must be one of try, require, off');
    });
  });

  describe('the operator tool', function () {
    afterEach(async function () {
      await clean();
    });

    it('reports the groups, then resolves them by the P4 pick: twins removed, other records kept without the identifier', async function () {
      await dropIdentifierIndexes();
      var older = new ObjectId('5cd67e000000000000000001');
      var newer = new ObjectId('5cd67e000000000000000002');
      await col('treatments').insertMany([
        { _id: older, identifier: ID, eventType: 'Carb Correction', carbs: 12, idxTest: true }
        , { _id: newer, identifier: ID, eventType: 'Carb Correction', carbs: 20, idxTest: true }
        , { _id: newer.toHexString(), identifier: ID, eventType: 'Carb Correction', carbs: 20, idxTest: true }
      ]);
      var names = tool.collectionNames(self.env);
      var report = await tool.run(self.ctx.store.db, names, ['treatments']);
      report.treatments.identifiers.should.equal(1);
      report.treatments.records.should.equal(3);
      report.treatments.groups[0].pick.should.eql(newer);
      report.treatments.groups[0].others.map(function (o) { return o.action; }).sort().should.eql(['release', 'remove-twin']);
      report.treatments.applied.should.equal(false);
      (await col('treatments').countDocuments({ idxTest: true, identifier: ID })).should.equal(3);

      var resolved = await tool.run(self.ctx.store.db, names, ['treatments'], { resolve: true, apply: true });
      resolved.treatments.applied.should.equal(true);
      var docs = await col('treatments').find({ idxTest: true }).sort({ _id: 1 }).toArray();
      docs.length.should.equal(2);
      docs[0]._id.should.eql(older);
      should.not.exist(docs[0].identifier);
      docs[0].identifierReleased.should.equal(ID);
      docs[0].carbs.should.equal(12);
      docs[1]._id.should.eql(newer);
      docs[1].identifier.should.equal(ID);

      var again = await tool.run(self.ctx.store.db, names, ['treatments']);
      again.treatments.identifiers.should.equal(0);
      var status = await identifierIndex.ensure([{ name: 'treatments', collection: col('treatments') }], 'try');
      status.collections.treatments.state.should.equal('built');
    });

    it('keeps the identifier on a live record over a newer soft-deleted one', async function () {
      await dropIdentifierIndexes();
      var live = new ObjectId('5cd67e000000000000000011');
      var deleted = new ObjectId('5cd67e000000000000000012');
      await col('treatments').insertMany([
        { _id: live, identifier: ID, eventType: 'Carb Correction', carbs: 12, idxTest: true }
        , { _id: deleted, identifier: ID, eventType: 'Carb Correction', carbs: 20, isValid: false, idxTest: true }
      ]);
      var names = tool.collectionNames(self.env);
      var report = await tool.run(self.ctx.store.db, names, ['treatments']);
      report.treatments.groups[0].pick.should.eql(live);
      await tool.run(self.ctx.store.db, names, ['treatments'], { resolve: true, apply: true });
      (await col('treatments').findOne({ _id: live })).identifier.should.equal(ID);
      var gone = await col('treatments').findOne({ _id: deleted });
      should.not.exist(gone.identifier);
      gone.identifierReleased.should.equal(ID);
    });

    it('with no live holder, P4 picks among the deleted ones (the newest)', async function () {
      await dropIdentifierIndexes();
      var older = new ObjectId('5cd67e000000000000000021');
      var newer = new ObjectId('5cd67e000000000000000022');
      await col('treatments').insertMany([
        { _id: older, identifier: ID, eventType: 'Note', isValid: false, idxTest: true }
        , { _id: newer, identifier: ID, eventType: 'Note', isValid: false, idxTest: true }
      ]);
      var report = await tool.run(self.ctx.store.db, tool.collectionNames(self.env), ['treatments']);
      report.treatments.groups[0].pick.should.eql(newer);
    });

    it('reports stored non-string identifiers and unsets them only with --apply', async function () {
      await dropIdentifierIndexes();
      await col('treatments').insertMany([
        { identifier: ['', 'a'], eventType: 'Note', idxTest: true }
        , { identifier: ['', 'b'], eventType: 'Note', idxTest: true }
        , { identifier: 7, eventType: 'Note', idxTest: true }
      ]);
      var names = tool.collectionNames(self.env);
      var report = await tool.run(self.ctx.store.db, names, ['treatments']);
      report.treatments.nonString.should.equal(3);
      report.treatments.identifiers.should.equal(1, 'the arrays share the key ""');
      var dry = await tool.run(self.ctx.store.db, names, ['treatments'], { resolve: true });
      dry.treatments.nonStringReleased.should.equal(0);
      (await col('treatments').countDocuments({ idxTest: true, identifier: { $exists: true } })).should.equal(3);
      var applied = await tool.run(self.ctx.store.db, names, ['treatments'], { resolve: true, apply: true });
      applied.treatments.nonStringReleased.should.equal(3);
      applied.treatments.identifiers.should.equal(0);
      var docs = await col('treatments').find({ idxTest: true }).toArray();
      docs.forEach(function (doc) {
        doc.should.not.have.property('identifier');
        should.exist(doc.identifierReleased);
      });
      var status = await identifierIndex.ensure([{ name: 'treatments', collection: col('treatments') }], 'try');
      status.collections.treatments.state.should.equal('built');
    });
  });
});
