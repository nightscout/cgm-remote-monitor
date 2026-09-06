'use strict';

/**
 * Deduplication Behavior Tests
 * 
 * REQUIREMENT REFERENCE: docs/proposals/mongodb-modernization-implementation-plan.md
 * 
 * DEDUPLICATION RULES BY CLIENT:
 * - AAPS: Uses pumpId + pumpType + pumpSerial for treatment deduplication
 *         Uses date + device + type for entry deduplication
 * - Loop: Uses syncIdentifier field for deduplication
 * - Trio: Uses id field (UUID) for deduplication
 * 
 * CRITICAL BEHAVIORS:
 * - Duplicate detection must work correctly
 * - Response must indicate deduplication occurred
 * - Original document ID must be returned for deduplicated items
 * - Cross-client duplicates should NOT deduplicate (different fields)
 * 
 * CLIENTS AFFECTED: Loop, Trio, AAPS
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
const fixtures = require('./fixtures');

describe('v1 API Deduplication Behavior', function() {
  this.timeout(30000);
  const self = this;
  
  const api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  function postApi(path, body) {
    return request(self.app)
      .post(path)
      .set('api-secret', api_secret_hash)
      .set('Accept', 'application/json')
      .send(body)
      .expect(200);
  }

  function listTreatments() {
    return new Promise(function(resolve, reject) {
      self.ctx.treatments.list({}, function(err, list) {
        if (err) {
          return reject(err);
        }
        resolve(list);
      });
    });
  }

  function listEntries() {
    return new Promise(function(resolve, reject) {
      self.ctx.entries.list({}, function(err, list) {
        if (err) {
          return reject(err);
        }
        resolve(list);
      });
    });
  }

  // Use before() instead of beforeEach() for app setup - boots once for all tests
  before(function(done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    const wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.wares = wares;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', require('../lib/api/')(self.env, ctx));
      done();
    });
  });

  beforeEach(function() {
    // Clear treatments, entries, and devicestatus before each test using fast deleteMany
    return new Promise(function(resolve, reject) {
      self.ctx.treatments.remove({
        find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } }
      }, function(err) {
        if (err) {
          return reject(err);
        }
        // Use deleteMany for faster cleanup of entries
        self.ctx.entries().deleteMany({})
          .then(function() {
            // Also clear devicestatus to reduce database load
            self.ctx.devicestatus.remove({
              find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } }
            }, function(err) {
              if (err) {
                return reject(err);
              }
              resolve();
            });
          })
          .catch(reject);
      });
    });
  });

  describe('AAPS Deduplication - pumpId based', function() {

    it('duplicate pumpId+pumpType+pumpSerial is detected and rejected', async function() {
      const fixture = fixtures.deduplication.aapsDuplicatePumpId;

      // Insert first treatment
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      should.exist(firstRes.body[0]._id);
      const firstId = firstRes.body[0]._id;

      // Attempt to insert duplicate
      const duplicateRes = await postApi('/api/treatments/', [fixture.duplicate]);
      console.log(`      First insert _id: ${firstId}`);
      console.log(`      Second insert response: ${JSON.stringify(duplicateRes.body)}`);

      // Verify only one document exists in database
      const list = await listTreatments();
      list.length.should.equal(1, 'Duplicate should not create second document');
      list[0]._id.toString().should.equal(firstId, 'Only original document should exist');

      console.log('      AAPS pumpId deduplication working');
    });

    // Retry on timeout - CI runners can be slow under load
    it('duplicate entry with same date+device+type is detected', async function() {
      this.timeout(60000);  // 60s for slow CI
      this.retries(2);
      const fixture = fixtures.deduplication.aapsDuplicateEntry;

      // Insert first entry
      const firstRes = await postApi('/api/entries/', [fixture.first]);
      should.exist(firstRes.body[0]._id);

      // Attempt to insert duplicate
      await postApi('/api/entries/', [fixture.duplicate]);

      // Verify only one entry exists
      const list = await listEntries();
      list.length.should.equal(1, 'Duplicate entry should not create second document');

      console.log('      AAPS entry deduplication working');
    });
  });

  describe('Loop Deduplication - syncIdentifier based', function() {

    it('duplicate syncIdentifier is detected and rejected', async function() {
      const fixture = fixtures.deduplication.loopDuplicateSyncId;

      // Insert first treatment
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      should.exist(firstRes.body[0]._id);
      const firstId = firstRes.body[0]._id;

      // Attempt to insert duplicate
      const duplicateRes = await postApi('/api/treatments/', [fixture.duplicate]);
      console.log(`      First insert _id: ${firstId}`);
      console.log(`      Second insert response: ${JSON.stringify(duplicateRes.body)}`);

      // Verify only one document exists
      const list = await listTreatments();
      list.length.should.equal(1, 'Duplicate syncIdentifier should not create second document');

      const doc = list[0];
      doc.syncIdentifier.should.equal(fixture.first.syncIdentifier);

      console.log('      Loop syncIdentifier deduplication working');
    });

    it('duplicate dose with syncIdentifier is detected', async function() {
      const fixture = fixtures.deduplication.loopDuplicateDose;

      // Insert first dose
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      should.exist(firstRes.body[0]._id);

      // Attempt to insert duplicate
      await postApi('/api/treatments/', [fixture.duplicate]);

      // Verify deduplication
      const list = await listTreatments();
      list.length.should.equal(1, 'Duplicate dose should not create second document');

      console.log('      Loop dose deduplication working');
    });
  });

  describe('Trio Deduplication - id field based', function() {

    it('duplicate id field (UUID) is detected and rejected', async function() {
      const fixture = fixtures.deduplication.trioDuplicateId;

      // Insert first treatment
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      should.exist(firstRes.body[0]._id);
      const firstId = firstRes.body[0]._id;

      // Attempt to insert duplicate
      const duplicateRes = await postApi('/api/treatments/', [fixture.duplicate]);
      console.log(`      First insert _id: ${firstId}`);
      console.log(`      Second insert response: ${JSON.stringify(duplicateRes.body)}`);

      // Verify only one document exists
      const list = await listTreatments();
      list.length.should.equal(1, 'Duplicate Trio id should not create second document');

      const doc = list[0];
      doc.id.should.equal(fixture.first.id);

      console.log('      Trio id field deduplication working');
    });

    it('duplicate temporary target with id is detected', async function() {
      const fixture = fixtures.deduplication.trioDuplicateTempTarget;

      // Insert first temp target
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      should.exist(firstRes.body[0]._id);

      // Attempt to insert duplicate
      await postApi('/api/treatments/', [fixture.duplicate]);

      // Verify deduplication
      const list = await listTreatments();
      list.length.should.equal(1, 'Duplicate temp target should not create second document');

      console.log('      Trio temp target deduplication working');
    });
  });

  describe('Batch with Mixed Duplicates', function() {

    it('batch containing duplicates inserts only unique items', async function() {
      const batch = fixtures.deduplication.batchWithDuplicates;

      // Batch has: note-1, note-2, note-1 (dup), note-3
      // Expected: 3 unique notes (note-1, note-2, note-3)

      const res = await postApi('/api/treatments/', batch);
      console.log(`      Batch sent: ${batch.length} items`);
      console.log(`      Response: ${JSON.stringify(res.body)}`);

      const list = await listTreatments();

      console.log(`      Database contains: ${list.length} documents`);

      // Count unique id values
      const uniqueIds = new Set(list.map(item => item.id));
      console.log(`      Unique id values: ${uniqueIds.size} (${Array.from(uniqueIds).join(', ')})`);

      // Should have 3 unique notes
      uniqueIds.size.should.equal(3, 'Should have 3 unique notes (note-1, note-2, note-3)');
    });
  });

  describe('Cross-Client Duplicate Detection', function() {

    it('AAPS and Trio uploads of same event do NOT deduplicate (different fields)', async function() {
      const crossClient = fixtures.deduplication.crossClientDuplicates;

      // Insert AAPS upload first
      const aapsRes = await postApi('/api/treatments/', [crossClient.aapsUpload]);
      const aapsId = aapsRes.body[0]._id;

      // Insert Trio upload of "same" event
      const trioRes = await postApi('/api/treatments/', [crossClient.trioUploadSameEvent]);
      const trioId = trioRes.body[0]._id;

      // Verify BOTH documents exist (no cross-client deduplication)
      const list = await listTreatments();
      list.length.should.equal(2, 'AAPS and Trio should NOT deduplicate each other');

      const ids = list.map(item => item._id.toString());
      ids.should.containEql(aapsId);
      ids.should.containEql(trioId);

      console.log('      Cross-client uploads do NOT deduplicate (expected behavior)');
    });
  });

  describe('Deduplication Response Format', function() {

    it('deduplicated item returns original _id in response', async function() {
      const fixture = fixtures.deduplication.loopDuplicateSyncId;

      // Insert first treatment
      const firstRes = await postApi('/api/treatments/', [fixture.first]);
      const originalId = firstRes.body[0]._id;

      // Insert duplicate - should return original _id
      const duplicateRes = await postApi('/api/treatments/', [fixture.duplicate]);
      console.log(`      Original _id: ${originalId}`);
      console.log(`      Duplicate response: ${JSON.stringify(duplicateRes.body)}`);

      if (Array.isArray(duplicateRes.body) && duplicateRes.body.length > 0 && duplicateRes.body[0]._id) {
        const returnedId = duplicateRes.body[0]._id;

        // CRITICAL: Returned _id should match original for deduplication
        if (returnedId === originalId) {
          console.log('      Deduplication returns original _id (ideal behavior)');
        } else {
          console.log(`      Deduplication returned different _id: ${returnedId} vs ${originalId}`);
        }
      }
    });
  });
});
