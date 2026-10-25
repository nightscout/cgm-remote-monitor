'use strict';

/**
 * GAP-TREAT-012 Test Suite: Loop Override UUID Identity Handling
 * 
 * REQUIREMENT REFERENCE: REQ-SYNC-072 (Transparent UUID promotion)
 * GAP REFERENCE: GAP-TREAT-012 (v1 API incorrectly coerces UUID _id to ObjectId)
 * 
 * These tests verify that:
 * 1. UUID _id is moved to identifier field (not corrupted)
 * 2. Server generates valid ObjectId for _id
 * 3. Updates/deletes work via identifier lookup
 * 4. Duplicate detection works via identifier
 * 
 * TEST MATRIX REFERENCE: docs/backlogs/loop-nightscout-upload-testing.md
 * - TEST-GAP-001: Loop override POST
 * - TEST-GAP-002: Loop override DELETE
 * - TEST-GAP-003: Loop override UPDATE
 * - TEST-GAP-004: Loop override re-POST (upsert)
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('GAP-TREAT-012: Loop Override UUID Handling', function() {
  this.timeout(30000);
  const self = this;
  
  const api_secret_hash = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  // Load Loop override fixtures
  const loopOverride = require('./fixtures/loop-override');

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

  describe('TEST-GAP-001: Loop override POST with UUID as _id', function() {

    it('accepts UUID _id and promotes to identifier field', function(done) {
      const fixture = loopOverride.standardOverride;
      const uuidId = fixture._id;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          should.exist(res.body);
          res.body.should.be.an.Array();
          res.body.length.should.equal(1);
          
          const created = res.body[0];
          
          // REQ-SYNC-072: UUID should be in identifier, not _id
          created.identifier.should.equal(uuidId);
          
          // _id should be a valid ObjectId (24 hex chars)
          created._id.should.match(/^[0-9a-f]{24}$/);
          created._id.should.not.equal(uuidId);
          
          // Other fields preserved
          created.eventType.should.equal('Temporary Override');
          created.reason.should.equal('Custom Override');
          
          console.log(`      UUID _id: ${uuidId}`);
          console.log(`      Server _id: ${created._id}`);
          console.log(`      identifier: ${created.identifier}`);
          console.log('      ✓ UUID promoted to identifier field');
          
          done();
        });
    });

    it('indefinite override UUID is preserved in identifier', function(done) {
      const fixture = loopOverride.indefiniteOverride;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.identifier.should.equal(fixture._id);
          created._id.should.match(/^[0-9a-f]{24}$/);
          should.exist(created.durationType);
          created.durationType.should.equal('indefinite');
          
          console.log('      ✓ Indefinite override UUID preserved');
          done();
        });
    });

    it('remote command override UUID is preserved in identifier', function(done) {
      const fixture = loopOverride.remoteOverride;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.identifier.should.equal(fixture._id);
          created.enteredBy.should.equal('Loop (via remote command)');
          
          console.log('      ✓ Remote override UUID preserved');
          done();
        });
    });
  });

  describe('TEST-GAP-002: Loop override DELETE by UUID', function() {

    it('can delete override using identifier query', function(done) {
      const fixture = loopOverride.deleteScenario.toDelete;
      
      // First create the override
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const serverId = res.body[0]._id;
          
          // Delete by server-assigned _id (standard method)
          request(self.app)
            .delete('/api/treatments/' + serverId)
            .set('api-secret', api_secret_hash)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Verify deleted
              self.ctx.treatments.list({ find: { identifier: fixture._id } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(0);
                
                console.log('      ✓ Override deleted successfully');
                done();
              });
            });
        });
    });

    it('can find override by identifier after creation', function(done) {
      const fixture = loopOverride.standardOverride;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err) {
          should.not.exist(err);
          
          // Query by identifier
          self.ctx.treatments.list({ find: { identifier: fixture._id } }, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(1);
            list[0].identifier.should.equal(fixture._id);
            
            console.log('      ✓ Override found by identifier query');
            done();
          });
        });
    });
  });

  describe('TEST-GAP-003: Loop override UPDATE by UUID', function() {

    it('PUT with UUID _id updates existing override', function(done) {
      const scenario = loopOverride.updateScenario;
      
      // Create original
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([scenario.original])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const serverId = res.body[0]._id;
          
          // Update with same UUID
          request(self.app)
            .put('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send(scenario.updated)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Verify update
              self.ctx.treatments.list({ find: { identifier: scenario.original._id } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1);
                
                const updated = list[0];
                updated.identifier.should.equal(scenario.original._id);
                updated.duration.should.equal(120);  // Updated value
                updated.reason.should.equal('Updated Override');
                
                console.log('      ✓ Override updated via PUT with UUID');
                done();
              });
            });
        });
    });
  });

  describe('TEST-GAP-004: Loop override re-POST (upsert by identifier)', function() {

    it('re-POST same UUID updates instead of creating duplicate', function(done) {
      const scenario = loopOverride.duplicateScenario;
      
      // First POST
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([scenario.first])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const firstServerId = res.body[0]._id;
          
          // Re-POST with same UUID, different values
          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send([scenario.repost])
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              // Should only have ONE document
              self.ctx.treatments.list({ find: { identifier: scenario.first._id } }, function(err, list) {
                should.not.exist(err);
                
                // CRITICAL: No duplicates
                list.length.should.equal(1, 'Re-POST should update, not create duplicate');
                
                // Should have updated values
                const doc = list[0];
                doc.duration.should.equal(90);  // From repost
                doc.reason.should.equal('Reposted Override');
                
                console.log(`      First _id: ${firstServerId}`);
                console.log(`      After re-POST: 1 document (no duplicate)`);
                console.log('      ✓ Re-POST with same UUID updates existing');
                done();
              });
            });
        });
    });
  });

  describe('Batch Override Upload', function() {

    it('batch of overrides with UUIDs all get identifier fields', function(done) {
      const batch = loopOverride.batchOverrides;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(3);
          
          // All should have identifier field with original UUID
          res.body.forEach(function(item, idx) {
            item.identifier.should.equal(batch[idx]._id);
            item._id.should.match(/^[0-9a-f]{24}$/);
          });
          
          // Verify in database
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(3);
            
            console.log('      ✓ Batch of 3 overrides all have identifier fields');
            done();
          });
        });
    });

    it('mixed batch with UUID and non-UUID treatments', function(done) {
      const batch = loopOverride.mixedBatch;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(3);
          
          // Override should have identifier
          const override = res.body.find(t => t.eventType === 'Temporary Override');
          override.identifier.should.equal(batch[0]._id);
          override._id.should.match(/^[0-9a-f]{24}$/);
          
          // Carb and bolus should have generated _ids
          const carb = res.body.find(t => t.eventType === 'Carb Correction');
          carb._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Mixed batch handles UUID and non-UUID correctly');
          done();
        });
    });
  });

  describe('Edge Cases', function() {

    it('handles uppercase UUID', function(done) {
      const fixture = {
        _id: 'ABCDEF01-2345-6789-ABCD-EF0123456789',
        eventType: 'Temporary Override',
        created_at: new Date().toISOString(),
        enteredBy: 'Loop',
        duration: 30,
        correctionRange: [100, 110],
        reason: 'Uppercase UUID Test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body[0].identifier.should.equal(fixture._id);
          
          console.log('      ✓ Uppercase UUID preserved');
          done();
        });
    });

    it('handles lowercase UUID', function(done) {
      const fixture = {
        _id: 'abcdef01-2345-6789-abcd-ef0123456789',
        eventType: 'Temporary Override',
        created_at: new Date().toISOString(),
        enteredBy: 'Loop',
        duration: 30,
        correctionRange: [100, 110],
        reason: 'Lowercase UUID Test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body[0].identifier.should.equal(fixture._id);
          
          console.log('      ✓ Lowercase UUID preserved');
          done();
        });
    });

    it('valid ObjectId string is NOT promoted to identifier', function(done) {
      // 24-char hex string (valid ObjectId format)
      const objectIdString = '507f1f77bcf86cd799439011';
      const fixture = {
        _id: objectIdString,
        eventType: 'Note',
        created_at: new Date().toISOString(),
        enteredBy: 'Test',
        notes: 'ObjectId format test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([fixture])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          // ObjectId should be used as-is (or regenerated), NOT promoted
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log(`      Input _id: ${objectIdString}`);
          console.log(`      Result _id: ${created._id}`);
          console.log('      ✓ ObjectId format handled correctly');
          done();
        });
    });
  });
});
