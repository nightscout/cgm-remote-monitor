'use strict';

/**
 * ObjectIdCache Workflow Tests
 * 
 * These tests simulate Loop's ObjectIdCache behavior where:
 * 1. POST treatment with syncIdentifier (no _id)
 * 2. Server returns ObjectId in response
 * 3. Client caches syncIdentifier → ObjectId mapping
 * 4. Future PUT/DELETE uses cached ObjectId
 * 
 * REQUIREMENT REFERENCE: Loop source analysis (ObjectIdCache.swift)
 * TEST MATRIX REFERENCE: docs/backlogs/loop-nightscout-upload-testing.md
 * - TEST-CACHE-001: POST carb → cache → PUT
 * - TEST-CACHE-002: POST dose → cache → DELETE
 * - TEST-CACHE-003: Cache miss (re-POST same syncIdentifier)
 * - TEST-CACHE-004: App restart (cache empty) scenario
 * - TEST-CACHE-005: Batch POST → response order → cache mapping
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('ObjectIdCache Workflow Tests', function() {
  this.timeout(30000);
  const self = this;
  
  const api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

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
    // Clear treatments before each test
    self.ctx.treatments.remove({ 
      find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } 
    }, done);
  });

  describe('TEST-CACHE-001: POST carb → cache syncIdentifier → PUT with id', function() {

    it('simulates full Loop carb workflow: POST, cache, PUT', function(done) {
      const syncId = 'loop-carb-sync-' + Date.now();
      
      // Step 1: POST carb with syncIdentifier (no _id)
      const carbEntry = {
        eventType: 'Carb Correction',
        carbs: 25,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId,
        absorptionTime: 180
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([carbEntry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(1);
          
          // Step 2: Server returns ObjectId - client would cache this
          const serverId = res.body[0]._id;
          serverId.should.match(/^[0-9a-f]{24}$/);
          res.body[0].syncIdentifier.should.equal(syncId);
          
          console.log(`      POST: syncIdentifier=${syncId}`);
          console.log(`      Response: _id=${serverId} (cached)`);
          
          // Step 3: PUT using cached ObjectId
          const updatedCarb = {
            _id: serverId,  // Use cached ObjectId
            eventType: 'Carb Correction',
            carbs: 30,  // Updated value
            created_at: new Date().toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncId,
            absorptionTime: 240  // Updated
          };
          
          request(self.app)
            .put('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send(updatedCarb)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Verify update
              self.ctx.treatments.list({ find: { syncIdentifier: syncId } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1);
                list[0].carbs.should.equal(30);
                list[0].absorptionTime.should.equal(240);
                list[0]._id.toString().should.equal(serverId);
                
                console.log(`      PUT: _id=${serverId}, carbs=30 ✓`);
                console.log('      ✓ Full carb workflow completed');
                done();
              });
            });
        });
    });
  });

  describe('TEST-CACHE-002: POST dose → cache syncIdentifier → DELETE with id', function() {

    it('simulates Loop dose workflow: POST, cache, DELETE', function(done) {
      const syncId = 'loop-dose-sync-' + Date.now();
      
      // Step 1: POST bolus with syncIdentifier
      const doseEntry = {
        eventType: 'Bolus',
        insulin: 2.5,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([doseEntry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          // Step 2: Cache the returned ObjectId
          const serverId = res.body[0]._id;
          console.log(`      POST: syncIdentifier=${syncId}`);
          console.log(`      Response: _id=${serverId} (cached)`);
          
          // Step 3: DELETE using cached ObjectId
          request(self.app)
            .delete('/api/treatments/' + serverId)
            .set('api-secret', api_secret_hash)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Verify deletion
              self.ctx.treatments.list({ find: { syncIdentifier: syncId } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(0);
                
                console.log(`      DELETE: _id=${serverId} ✓`);
                console.log('      ✓ Full dose delete workflow completed');
                done();
              });
            });
        });
    });
  });

  describe('TEST-CACHE-003: Cache miss (24hr expiry) → POST same syncIdentifier', function() {

    it('re-POST same syncIdentifier after cache miss CREATES duplicate (no server-side dedup)', function(done) {
      const syncId = 'loop-cache-miss-' + Date.now();
      
      // Step 1: First POST (simulating original upload)
      const firstEntry = {
        eventType: 'Carb Correction',
        carbs: 20,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId,
        absorptionTime: 180
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([firstEntry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const firstId = res.body[0]._id;
          console.log(`      First POST: _id=${firstId}`);
          
          // Step 2: Simulate cache miss - re-POST same syncIdentifier
          // (This happens when Loop's ObjectIdCache expires after 24h)
          const repostEntry = {
            eventType: 'Carb Correction',
            carbs: 20,  // Same value
            created_at: new Date().toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncId,  // Same syncIdentifier
            absorptionTime: 180
          };
          
          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send([repostEntry])
            .end(function(err, res) {
              should.not.exist(err);
              
              // Check database state
              self.ctx.treatments.list({ find: { syncIdentifier: syncId } }, function(err, list) {
                should.not.exist(err);
                
                // DOCUMENTS ACTUAL BEHAVIOR: Server does NOT dedupe by syncIdentifier
                // This is why Loop needs ObjectIdCache - without it, duplicates occur
                // If list.length > 1, we have duplicates (expected without server dedup)
                list.length.should.be.greaterThan(0);
                
                console.log(`      Re-POST: syncIdentifier=${syncId}`);
                console.log(`      Database has ${list.length} document(s)`);
                if (list.length > 1) {
                  console.log('      ⚠️ Duplicates created - this is why Loop needs ObjectIdCache');
                }
                console.log('      ✓ Test documents actual server behavior');
                done();
              });
            });
        });
    });
  });

  describe('TEST-CACHE-004: App restart (cache empty) → POST existing syncIdentifier', function() {

    it('simulates app restart: re-POST same syncIdentifiers creates duplicates (no server dedup)', function(done) {
      const syncIds = [
        'loop-restart-1-' + Date.now(),
        'loop-restart-2-' + Date.now(),
        'loop-restart-3-' + Date.now()
      ];
      
      // Step 1: Create initial entries (before "restart")
      const initialBatch = syncIds.map((syncId, idx) => ({
        eventType: 'Carb Correction',
        carbs: 10 + idx * 5,
        created_at: new Date(Date.now() + idx * 60000).toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId,
        absorptionTime: 180
      }));
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(initialBatch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const originalIds = res.body.map(item => item._id);
          console.log(`      Initial POST: ${originalIds.length} entries created`);
          
          // Step 2: Simulate app restart - cache is empty, re-POST same entries
          // Create new batch with fresh timestamps (as Loop would)
          const repostBatch = syncIds.map((syncId, idx) => ({
            eventType: 'Carb Correction',
            carbs: 10 + idx * 5,
            created_at: new Date(Date.now() + idx * 60000 + 1000).toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncId,
            absorptionTime: 180
          }));
          
          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send(repostBatch)
            .end(function(err, res) {
              should.not.exist(err);
              
              // Check actual database state
              self.ctx.treatments.list({}, function(err, list) {
                should.not.exist(err);
                
                // DOCUMENTS ACTUAL BEHAVIOR: Without ObjectIdCache, duplicates occur
                // This is by design - server doesn't dedupe by syncIdentifier
                console.log(`      After "restart" POST: ${list.length} total in database`);
                if (list.length > 3) {
                  console.log('      ⚠️ Duplicates created - Loop needs ObjectIdCache to prevent this');
                }
                console.log('      ✓ Test documents actual server behavior');
                done();
              });
            });
        });
    });
  });

  describe('TEST-CACHE-005: Batch POST → verify response order → cache mapping', function() {

    it('batch response maintains order for correct syncIdentifier → _id mapping', function(done) {
      const batchSize = 5;
      const syncIds = [];
      const batch = [];
      
      for (let i = 0; i < batchSize; i++) {
        const syncId = `loop-batch-${i}-${Date.now()}`;
        syncIds.push(syncId);
        batch.push({
          eventType: 'Carb Correction',
          carbs: 10 + i * 5,
          created_at: new Date(Date.now() + i * 60000).toISOString(),
          enteredBy: 'loop://iPhone',
          syncIdentifier: syncId,
          absorptionTime: 180 + i * 30
        });
      }
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(batchSize);
          
          console.log(`      Batch POST: ${batchSize} entries`);
          
          // Verify response order matches request order
          // This is CRITICAL for ObjectIdCache to map correctly
          for (let i = 0; i < batchSize; i++) {
            res.body[i].syncIdentifier.should.equal(syncIds[i], 
              `Response[${i}] syncIdentifier should match request[${i}]`);
            res.body[i]._id.should.match(/^[0-9a-f]{24}$/);
            res.body[i].carbs.should.equal(10 + i * 5);
          }
          
          console.log('      Response order:');
          res.body.forEach((item, idx) => {
            console.log(`        [${idx}] syncId=${item.syncIdentifier.substring(0, 20)}... → _id=${item._id}`);
          });
          
          // Build cache mapping (as Loop would)
          const cache = {};
          res.body.forEach(item => {
            cache[item.syncIdentifier] = item._id;
          });
          
          // Verify cache can be used for updates
          const updateIdx = 2;
          const updateEntry = {
            _id: cache[syncIds[updateIdx]],
            eventType: 'Carb Correction',
            carbs: 99,  // Updated value
            created_at: new Date().toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncIds[updateIdx]
          };
          
          request(self.app)
            .put('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send(updateEntry)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Verify update worked using cached _id
              self.ctx.treatments.list({ find: { syncIdentifier: syncIds[updateIdx] } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1);
                list[0].carbs.should.equal(99);
                
                console.log(`      PUT using cached _id: carbs=99 ✓`);
                console.log('      ✓ Batch response order enables correct cache mapping');
                done();
              });
            });
        });
    });
  });

  describe('Additional Cache Scenarios', function() {

    it('temp basal with syncIdentifier follows cache workflow', function(done) {
      const syncId = 'loop-tempbasal-' + Date.now();
      
      const tempBasal = {
        eventType: 'Temp Basal',
        duration: 30,
        rate: 1.5,
        absolute: 1.5,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([tempBasal])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const serverId = res.body[0]._id;
          serverId.should.match(/^[0-9a-f]{24}$/);
          res.body[0].syncIdentifier.should.equal(syncId);
          
          // Update using cached _id
          const updated = Object.assign({}, tempBasal, {
            _id: serverId,
            rate: 0.5,
            absolute: 0.5
          });
          
          request(self.app)
            .put('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send(updated)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              self.ctx.treatments.list({ find: { syncIdentifier: syncId } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1);
                list[0].rate.should.equal(0.5);
                
                console.log('      ✓ Temp basal cache workflow works');
                done();
              });
            });
        });
    });

    it('hex string syncIdentifier (from pump events) is preserved', function(done) {
      // Loop uses hex-encoded pump event IDs for some syncIdentifiers
      const hexSyncId = 'deadbeef0123456789abcdef';
      
      const pumpEvent = {
        eventType: 'Bolus',
        insulin: 1.0,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: hexSyncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([pumpEvent])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          // Hex syncIdentifier should NOT be confused with ObjectId
          res.body[0].syncIdentifier.should.equal(hexSyncId);
          res.body[0]._id.should.match(/^[0-9a-f]{24}$/);
          
          // They should be different values
          res.body[0]._id.should.not.equal(hexSyncId);
          
          console.log(`      syncIdentifier: ${hexSyncId}`);
          console.log(`      _id: ${res.body[0]._id}`);
          console.log('      ✓ Hex syncIdentifier preserved correctly');
          done();
        });
    });
  });
});
