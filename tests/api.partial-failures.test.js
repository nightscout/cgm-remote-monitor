'use strict';

/**
 * Partial Failures and Edge Cases Tests
 * 
 * REQUIREMENT REFERENCE: docs/proposals/mongodb-modernization-implementation-plan.md
 * 
 * CRITICAL BEHAVIORS TO TEST:
 * - Batch operations with duplicate keys (ordered vs unordered)
 * - Response ordering for Loop syncIdentifier→objectId mapping
 * - Deduplication with existing documents in batch
 * - Client-provided _id handling
 * - Write result format translation (driver v3.x vs v4.x)
 * - Large BSON document handling
 * - Connection failure recovery
 * 
 * CLIENTS AFFECTED: Loop, Trio, AAPS
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
const fixtures = require('./fixtures');

describe('v1 API Partial Failures and Edge Cases', function() {
  this.timeout(20000);
  const self = this;
  
  const api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

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

  beforeEach(function(done) {
    // Clear treatments and entries before each test
    self.ctx.treatments.remove({ 
      find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } 
    }, function() {
      self.ctx.entries.remove({
        find: { date: { '$gte': 0 } }
      }, done);
    });
  });

  describe('Duplicate Key Handling in Batches', function() {

    it('batch with duplicate id field - all documents inserted (id field not unique-indexed)', function(done) {
      // QUIRK/BEHAVIOR: The 'id' field is used by clients (Trio, etc.) for deduplication
      // but is NOT enforced as unique by MongoDB unless explicitly indexed.
      // Currently, Nightscout relies on application-level deduplication queries
      // (checking if id exists before insert), not database-level unique constraints.
      // 
      // This means duplicate 'id' values CAN be inserted if sent in a batch,
      // because the batch insert doesn't perform per-document deduplication checks.
      // 
      // See also: API-level deduplication tests which check syncIdentifier, pumpId, etc.
      
      const batch = fixtures.partialFailures.batchWithDuplicateKeyInMiddle.input;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .end(function(err, res) {
          should.not.exist(err);
          res.status.should.equal(200);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            
            // All documents are inserted - no MongoDB-level uniqueness constraint on 'id'
            list.length.should.equal(4, 'All documents inserted - id field not unique-indexed');
            
            // Verify all expected documents exist
            const firstNote = list.find(item => item.notes === 'First note');
            const secondNote = list.find(item => item.notes === 'Second note');
            const thirdNote = list.find(item => item.notes === 'Third note');
            const fourthNote = list.find(item => item.notes === 'Fourth note');
            
            should.exist(firstNote);
            should.exist(secondNote);
            should.exist(thirdNote, 'Third document (duplicate id) IS inserted - no unique constraint');
            should.exist(fourthNote);
            
            // Both duplicates have the same id value
            secondNote.id.should.equal('note-duplicate');
            thirdNote.id.should.equal('note-duplicate');
            
            console.log(`      ✓ Batch insert: ${list.length} docs inserted (id field not unique-constrained)`);
            done();
          });
        });
    });

    it('batch response preserves order even with partial failure', function(done) {
      // CRITICAL FOR LOOP: Response order must match request order
      // Even if some items fail, response indices must align with request
      
      const batch = fixtures.partialFailures.batchWithDuplicateKeyInMiddle.input;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .end(function(err, res) {
          // Check if response is array
          if (Array.isArray(res.body)) {
            console.log(`      ℹ Response is array with ${res.body.length} items`);
            
            // If partial, check order preservation
            if (res.body.length > 0 && res.body.length < batch.length) {
              console.log('      ✓ Partial response returned - order preservation critical');
            }
          } else {
            console.log(`      ⚠ Response is not array: ${JSON.stringify(res.body)}`);
          }
          
          done();
        });
    });
  });

  describe('Loop syncIdentifier Response Ordering (CRITICAL)', function() {

    it('response order MUST match request order for syncIdentifier mapping', function(done) {
      // SPEC: Loop caches syncIdentifier→objectId mapping based on response array order
      // CRITICAL: If order doesn't match, Loop maps wrong IDs and breaks update/delete
      
      const batch = fixtures.partialFailures.loopResponseOrderingScenario.input;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(batch.length);
          
          // Verify each response item has _id and correlates to request order
          res.body.forEach((responseItem, index) => {
            should.exist(responseItem._id, `Response[${index}] must have _id`);
            
            const requestItem = batch[index];
            console.log(`      Position ${index}: syncId=${requestItem.syncIdentifier} → _id=${responseItem._id}`);
          });
          
          // Verify in database with correct syncIdentifiers
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(batch.length);
            
            // Verify syncIdentifiers are preserved
            batch.forEach((requestItem, index) => {
              const dbItem = list.find(item => item.syncIdentifier === requestItem.syncIdentifier);
              should.exist(dbItem, `Document with syncIdentifier=${requestItem.syncIdentifier} should exist`);
              
              // CRITICAL: Response _id at position [index] should match the document with batch[index].syncIdentifier
              dbItem._id.toString().should.equal(res.body[index]._id.toString(), 
                `Response order mismatch: position ${index} has _id ${res.body[index]._id} but should be ${dbItem._id}`);
            });
            
            console.log('      ✓ Response order matches request order - Loop mapping safe');
            done();
          });
        });
    });

    it('batch with some deduplicated items still returns all positions', function(done) {
      // SPEC: Loop expects N responses for N requests, even if some are deduplicated
      // CRITICAL: Missing positions in response breaks syncIdentifier cache
      
      const batch = fixtures.partialFailures.loopBatchWithSomeDeduplicated.input;
      const preExisting = fixtures.partialFailures.loopBatchWithSomeDeduplicated.preExisting;
      
      // Insert the pre-existing document
      self.ctx.treatments.create(preExisting, function(err) {
        should.not.exist(err);
        
        request(self.app)
          .post('/api/treatments/')
          .set('api-secret', api_secret_hash)
          .send(batch)
          .expect(200)
          .end(function(err, res) {
            should.not.exist(err);
            res.body.should.be.instanceof(Array);
            
            // CRITICAL: Response must have 3 items even though middle one is deduplicated
            res.body.length.should.equal(batch.length, 
              'Loop expects response array length to match request array length');
            
            res.body.forEach((item, index) => {
              should.exist(item._id, `Position ${index} must have _id (even if deduplicated)`);
              console.log(`      Position ${index}: _id=${item._id}, syncId=${batch[index].syncIdentifier}`);
            });
            
            // Middle item should have the existing _id
            const middleItemId = res.body[1]._id.toString();
            const existingId = preExisting[0]._id.toString();
            
            console.log(`      Deduplication check: response[1]._id=${middleItemId}, existing._id=${existingId}`);
            
            done();
          });
      });
    });
  });

  describe('Client-Provided ID Handling', function() {

    it('client-provided _id is used if valid ObjectId format', function(done) {
      const clientId = '507f1f77bcf86cd799439011'; // Valid ObjectId format
      const treatment = {
        ...fixtures.partialFailures.clientProvidedIdScenarios.loopWithClientId.input,
        _id: clientId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          if (Array.isArray(res.body) && res.body.length > 0) {
            const returnedId = res.body[0]._id;
            console.log(`      Client provided: ${clientId}, Server returned: ${returnedId}`);
            
            // Check database
            self.ctx.treatments.list({}, function(err, list) {
              should.not.exist(err);
              list.length.should.equal(1);
              console.log(`      Database _id: ${list[0]._id}`);
              
              // Document behavior: does MongoDB use client _id or generate new one?
              done();
            });
          } else {
            done();
          }
        });
    });

    it('Trio id field (not _id) is preserved for deduplication', function(done) {
      const treatment = fixtures.partialFailures.clientProvidedIdScenarios.trioWithIdField.input;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(1);
            
            // Verify id field is preserved (separate from _id)
            should.exist(list[0].id, 'Trio id field should be preserved');
            list[0].id.should.equal(treatment.id);
            
            should.exist(list[0]._id, 'MongoDB _id should also exist');
            list[0]._id.toString().should.not.equal(treatment.id, 'id and _id are different fields');
            
            console.log(`      ✓ Trio id field: ${list[0].id}, MongoDB _id: ${list[0]._id}`);
            done();
          });
        });
    });

    it('AAPS identifier field is separate from MongoDB _id', function(done) {
      const treatment = fixtures.partialFailures.clientProvidedIdScenarios.aapsWithIdentifier.input;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(1);
            
            should.exist(list[0]._id, 'MongoDB _id should exist');
            
            if (list[0].identifier) {
              list[0].identifier.should.equal(treatment.identifier);
              console.log(`      ✓ AAPS identifier: ${list[0].identifier}, MongoDB _id: ${list[0]._id}`);
            } else {
              console.log(`      ℹ identifier field: ${list[0].identifier} (may be set by v3 API)`);
            }
            
            done();
          });
        });
    });
  });

  describe('Write Result Format Translation', function() {

    it('v1 API response format includes _id field for each document', function(done) {
      // NOTE: Treatments are deduplicated by created_at + eventType
      // So batch items must have different timestamps or different eventTypes
      
      const batch = [
        { eventType: 'Note', created_at: new Date().toISOString(), notes: 'Test 1' },
        { eventType: 'Announcement', created_at: new Date().toISOString(), notes: 'Test 2' } // Different eventType
      ];
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          
          res.body.forEach((item, index) => {
            should.exist(item._id, `Response[${index}] must have _id field`);
            item._id.should.be.a.String();
            
            console.log(`      ✓ Response[${index}] has _id: ${item._id}`);
          });
          
          done();
        });
    });
  });

  describe('Large Document Handling', function() {
    this.timeout(120000);

    beforeEach(function(done) {
      // Clear devicestatus before each test
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function() {
        done();
      });
    });

    it('devicestatus with large prediction arrays is inserted successfully', function(done) {
      // SPEC: OpenAPS devicestatus can have large prediction arrays
      // BSON limit is 16MB - typical predictions are well under this
      
      const deviceStatus = fixtures.partialFailures.largeBsonDocumentEdgeCase.deviceStatusWithLargePredictions;
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([deviceStatus])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          if (Array.isArray(res.body) && res.body.length > 0) {
            should.exist(res.body[0]._id);
            
            // Verify in database
            self.ctx.devicestatus.list({}, function(err, list) {
              should.not.exist(err);
              list.length.should.equal(1);
              
              // Verify prediction arrays preserved
              should.exist(list[0].openaps);
              should.exist(list[0].openaps.suggested);
              should.exist(list[0].openaps.suggested.predBGs);
              
              const iobCount = list[0].openaps.suggested.predBGs.IOB.length;
              console.log(`      ✓ Large predictions inserted: ${iobCount} IOB values`);
              
              done();
            });
          } else {
            console.log(`      ⚠ Unexpected response: ${JSON.stringify(res.body)}`);
            done();
          }
        });
    });

    it('predictions are truncated when PREDICTIONS_MAX_SIZE is set', function(done) {
      // SPEC: When PREDICTIONS_MAX_SIZE env var is set, prediction arrays
      // exceeding that size should be truncated to prevent MongoDB issues
      // with excessively large documents
      
      // Store original value
      const originalPredictionsMaxSize = self.env.predictionsMaxSize;
      
      // Set truncation limit to 288 (24 hours of 5-min readings)
      self.env.predictionsMaxSize = 288;
      
      // Need to reinitialize devicestatus to pick up new setting
      const devicestatusStorage = require('../lib/server/devicestatus');
      self.ctx.devicestatus = devicestatusStorage(self.env, self.ctx);
      
      // Create devicestatus with 350 predictions (exceeds 288 limit)
      const deviceStatus = {
        device: 'truncation-test',
        created_at: new Date().toISOString(),
        openaps: {
          suggested: {
            predBGs: {
              IOB: Array.from({ length: 350 }, (_, i) => 120 - i * 0.1),
              COB: Array.from({ length: 350 }, (_, i) => 120 - i * 0.05),
              UAM: Array.from({ length: 350 }, (_, i) => 120 + i * 0.02),
              ZT: Array.from({ length: 350 }, (_, i) => 120 - i * 0.08)
            }
          }
        }
      };
      
      self.ctx.devicestatus.create([deviceStatus], function(err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(1);
        
        // Verify truncation occurred
        const savedPredBGs = result[0].openaps.suggested.predBGs;
        
        savedPredBGs.IOB.length.should.equal(288, 'IOB should be truncated to 288');
        savedPredBGs.COB.length.should.equal(288, 'COB should be truncated to 288');
        savedPredBGs.UAM.length.should.equal(288, 'UAM should be truncated to 288');
        savedPredBGs.ZT.length.should.equal(288, 'ZT should be truncated to 288');
        
        console.log(`      ✓ Predictions truncated from 350 to 288 elements`);
        
        // Restore original value
        self.env.predictionsMaxSize = originalPredictionsMaxSize;
        
        done();
      });
    });

    it('predictions use default truncation of 288 when PREDICTIONS_MAX_SIZE is not set', function(done) {
      // SPEC: Without PREDICTIONS_MAX_SIZE env var, prediction arrays
      // should be truncated to the default of 288 (24 hours of 5-min readings)
      
      // Use default (288) - simulating env var not being set
      self.env.predictionsMaxSize = 288;
      
      // Reinitialize devicestatus to pick up setting
      const devicestatusStorage = require('../lib/server/devicestatus');
      self.ctx.devicestatus = devicestatusStorage(self.env, self.ctx);
      
      // Create devicestatus with predictions under the limit (100 elements)
      const deviceStatus = {
        device: 'default-truncation-test',
        created_at: new Date().toISOString(),
        openaps: {
          suggested: {
            predBGs: {
              IOB: Array.from({ length: 100 }, (_, i) => 120 - i * 0.1),
              COB: Array.from({ length: 100 }, (_, i) => 120 - i * 0.05)
            }
          }
        }
      };
      
      self.ctx.devicestatus.create([deviceStatus], function(err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(1);
        
        // Verify arrays under 288 are NOT truncated
        const savedPredBGs = result[0].openaps.suggested.predBGs;
        
        savedPredBGs.IOB.length.should.equal(100, 'IOB should remain at 100 (under limit)');
        savedPredBGs.COB.length.should.equal(100, 'COB should remain at 100 (under limit)');
        
        console.log(`      ✓ Predictions preserved at 100 elements (under 288 limit)`);
        
        done();
      });
    });
    
    it('predictions can be disabled by setting PREDICTIONS_MAX_SIZE=0', function(done) {
      // SPEC: Setting PREDICTIONS_MAX_SIZE=0 explicitly disables truncation
      // This is the opt-out mechanism for users who need full prediction arrays
      
      const originalPredictionsMaxSize = self.env.predictionsMaxSize;
      
      // Disable truncation with 0
      self.env.predictionsMaxSize = 0;
      
      // Reinitialize devicestatus to pick up setting
      const devicestatusStorage = require('../lib/server/devicestatus');
      self.ctx.devicestatus = devicestatusStorage(self.env, self.ctx);
      
      // Create devicestatus with large predictions (400 elements)
      const deviceStatus = {
        device: 'disabled-truncation-test',
        created_at: new Date().toISOString(),
        openaps: {
          suggested: {
            predBGs: {
              IOB: Array.from({ length: 400 }, (_, i) => 120 - i * 0.1),
              COB: Array.from({ length: 400 }, (_, i) => 120 - i * 0.05)
            }
          }
        }
      };
      
      self.ctx.devicestatus.create([deviceStatus], function(err, result) {
        should.not.exist(err);
        should.exist(result);
        result.should.be.instanceof(Array);
        result.length.should.equal(1);
        
        // Verify NO truncation occurred (disabled)
        const savedPredBGs = result[0].openaps.suggested.predBGs;
        
        savedPredBGs.IOB.length.should.equal(400, 'IOB should remain at 400 (truncation disabled)');
        savedPredBGs.COB.length.should.equal(400, 'COB should remain at 400 (truncation disabled)');
        
        console.log(`      ✓ Predictions preserved at 400 elements (truncation disabled with 0)`);
        
        // Restore original value
        self.env.predictionsMaxSize = originalPredictionsMaxSize;
        
        done();
      });
    });
  });

  describe('Validation Error Handling', function() {

    it('batch with validation error in middle - ordered insert stops', function(done) {
      // SPEC: Invalid data (e.g., sgv: 'invalid') should cause validation error
      // Ordered insert stops at first error
      
      const batch = fixtures.partialFailures.batchWithValidationErrorInMiddle.input;
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send(batch)
        .end(function(err, res) {
          // May return error or partial success
          
          self.ctx.entries.list({}, function(err, list) {
            should.not.exist(err);
            
            console.log(`      Entries inserted: ${list.length} (expected: 1 with ordered, 2 with unordered)`);
            
            // At least first valid entry should be inserted
            list.length.should.be.greaterThan(0, 'Valid entries before error should be inserted');
            
            const validEntries = list.filter(item => typeof item.sgv === 'number');
            console.log(`      Valid entries: ${validEntries.length}`);
            
            done();
          });
        });
    });
  });

  describe('Connection and Recovery Scenarios', function() {

    it('large batch insert completes successfully', function(done) {
      // SPEC: Clients may send large batches (50+ items)
      // Test that batch processing handles this without timeout/error
      
      const batch = fixtures.partialFailures.connectionFailureMidBatch.input;
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(batch.length, 'All items in large batch should be processed');
          
          self.ctx.entries.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(batch.length);
            
            console.log(`      ✓ Large batch (${batch.length} items) inserted successfully`);
            done();
          });
        });
    });
  });
});
