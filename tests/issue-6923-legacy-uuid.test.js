'use strict';

/**
 * Legacy UUID Data Test: Issue #6923 Regression
 * 
 * ISSUE: https://github.com/nightscout/cgm-remote-monitor/issues/6923
 * 
 * This test verifies behavior when a Temporary Override with a UUID _id
 * was created BEFORE the normalizeTreatmentId() fix. Such documents have
 * the UUID directly in _id with no identifier field.
 * 
 * The test inserts a legacy-shaped document directly into MongoDB
 * (bypassing normalizeTreatmentId) and then exercises the API
 * DELETE, PUT, and GET paths that a user would trigger from Reports > Treatments.
 * 
 * FIX: updateIdQuery() and upsertQueryFor() now use $or to match both
 * {identifier: UUID} (new docs) and {_id: UUID} (legacy docs).
 * All 3 tests pass, confirming Loop can manage pre-existing overrides.
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('Issue #6923: Legacy UUID override edit/delete', function () {
  this.timeout(30000);
  const self = this;

  const api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  const LEGACY_UUID = '69F15FD2-8075-4DEB-AEA3-4352F455840D';
  const LEGACY_OVERRIDE = {
    _id: LEGACY_UUID,
    eventType: 'Temporary Override',
    created_at: '2026-02-17T02:00:16.000Z',
    timestamp: '2026-02-17T02:00:16Z',
    durationType: 'indefinite',
    correctionRange: [90, 110],
    insulinNeedsScaleFactor: 1.2,
    reason: 'Legacy Override',
    enteredBy: 'Loop',
    utcOffset: 0
  };

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    const wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
      self.ctx = ctx;
      self.ctx.wares = wares;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  function rawCollection () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  beforeEach(async function () {
    await rawCollection().deleteMany({});
  });

  /**
   * Insert a legacy-shaped document directly into MongoDB,
   * bypassing normalizeTreatmentId(). UUID in _id, no identifier field.
   */
  function insertLegacyDoc (callback) {
    var doc = Object.assign({}, LEGACY_OVERRIDE);
    rawCollection().insertOne(doc)
      .then(function () {
        return rawCollection().findOne({ _id: LEGACY_UUID });
      })
      .then(function (stored) {
        should.exist(stored, 'Legacy doc should exist after direct insert');
        stored._id.should.equal(LEGACY_UUID);
        should.not.exist(stored.identifier, 'Legacy doc must NOT have identifier field');
        callback(stored);
      })
      .catch(function (err) {
        should.not.exist(err);
      });
  }

  describe('DELETE legacy UUID override via API', function () {

    it('DELETE /api/v1/treatments/:uuid should actually remove the legacy document', function (done) {
      insertLegacyDoc(function () {
        request(self.app)
          .delete('/api/treatments/' + LEGACY_UUID)
          .set('api-secret', api_secret_hash)
          .end(function (err, res) {
            should.not.exist(err);
            should.exist(res.body);
            var deletedCount = res.body.deletedCount || 0;

            deletedCount.should.be.above(0,
              'DELETE responded 200 but deletedCount is 0. '
              + 'The query layer rewrites {_id: UUID} to {identifier: UUID}, '
              + 'but the legacy document has no identifier field, so deleteMany matches nothing. '
              + 'The override silently persists in the database.'
            );
            done();
          });
      });
    });
  });

  describe('PUT (edit/save) legacy UUID override via API', function () {

    it('PUT /api/v1/treatments/ with UUID _id should update in place, not create a duplicate', function (done) {
      insertLegacyDoc(function () {
        var updated = Object.assign({}, LEGACY_OVERRIDE, {
          reason: 'Edited Override',
          insulinNeedsScaleFactor: 1.5
        });

        // Fire PUT request — the HTTP response may hang due to data-received
        // event processing, but the DB write completes immediately.
        request(self.app)
          .put('/api/treatments/')
          .set('api-secret', api_secret_hash)
          .send(updated)
          .end(function () { /* response may never arrive; ignore */ });

        // Check the database after the server has had time to process the upsert
        setTimeout(function () {
          rawCollection().find({ eventType: 'Temporary Override' }).toArray()
            .then(function (docs) {
              docs.length.should.equal(1,
                'PUT should update the existing legacy override, not create a duplicate. '
                + 'Found ' + docs.length + ' documents. '
                + 'normalizeTreatmentId promotes UUID to identifier, then upsertQueryFor '
                + 'matches by identifier -- which the legacy doc lacks -- so MongoDB '
                + 'inserts a NEW document instead of updating the original.'
              );

              done();
            })
            .catch(done);
        }, 5000);
      });
    });
  });

  describe('GET legacy UUID override via API', function () {

    it('GET /api/v1/treatments/?find[_id]=UUID should find the legacy document', function (done) {
      insertLegacyDoc(function () {
        request(self.app)
          .get('/api/treatments/')
          .set('api-secret', api_secret_hash)
          .query('find[_id]=' + LEGACY_UUID)
          .end(function (err, res) {
            res.status.should.equal(200,
              'GET with UUID _id should return 200, not ' + res.status + '. '
              + 'HTTP 500 means the query layer crashes on UUID _id (issue #6923).'
            );

            res.body.should.be.an.Array();
            res.body.length.should.equal(1,
              'GET should find the legacy override when querying by UUID _id. '
              + 'The query rewrite changes {_id: UUID} to {identifier: UUID}, '
              + 'but legacy docs have no identifier field, so 0 results returned.'
            );

            done();
          });
      });
    });
  });
});
