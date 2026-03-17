'use strict';

/**
 * Identity Field Test Matrix
 * 
 * Tests how Nightscout handles identity fields from different AID clients.
 * 
 * REQUIREMENT REFERENCE: docs/backlogs/loop-nightscout-upload-testing.md
 * - TEST-ID-001: Loop Override with UUID _id
 * - TEST-ID-002: Loop Override with identifier field
 * - TEST-ID-003: Loop Carb with syncIdentifier (no _id)
 * - TEST-ID-004: AAPS with identifier: null
 * - TEST-ID-005: AAPS with identifier: ObjectId
 * - TEST-ID-006: xDrip+ with uuid + _id fields
 * 
 * v1 API Identity Behavior:
 * - TEST-V1-ID-001: No id field
 * - TEST-V1-ID-002: Valid ObjectId
 * - TEST-V1-ID-003: UUID string (GAP-TREAT-012 scenario)
 * - TEST-V1-ID-004: syncIdentifier field
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('Identity Field Test Matrix', function() {
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
    self.ctx.treatments.remove({ 
      find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } 
    }, done);
  });

  describe('Client Pattern Tests', function() {

    it('TEST-ID-001: Loop Override with UUID _id is promoted to identifier', function(done) {
      const uuid = 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890';
      
      const loopOverride = {
        _id: uuid,
        eventType: 'Temporary Override',
        created_at: new Date().toISOString(),
        enteredBy: 'Loop',
        duration: 60,
        correctionRange: [90, 110],
        reason: 'Test Override'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([loopOverride])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // UUID should be promoted to identifier
          created.identifier.should.equal(uuid);
          
          // _id should be server-generated ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          created._id.should.not.equal(uuid);
          
          console.log('      ✓ Loop UUID _id → identifier promotion');
          done();
        });
    });

    it('TEST-ID-002: Loop Override with identifier field is preserved', function(done) {
      const uuid = 'B2C3D4E5-F6A7-8901-BCDE-F23456789012';
      
      const loopOverride = {
        identifier: uuid,  // Using identifier field directly
        eventType: 'Temporary Override',
        created_at: new Date().toISOString(),
        enteredBy: 'Loop',
        duration: 60,
        correctionRange: [100, 120],
        reason: 'Test Override 2'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([loopOverride])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // identifier should be preserved
          created.identifier.should.equal(uuid);
          
          // _id should be generated ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ identifier field preserved, ObjectId generated');
          done();
        });
    });

    it('TEST-ID-003: Loop Carb with syncIdentifier (no _id) gets ObjectId', function(done) {
      const syncId = 'loop-carb-uuid-' + Date.now();
      
      const loopCarb = {
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
        .send([loopCarb])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // syncIdentifier preserved (not touched by server)
          created.syncIdentifier.should.equal(syncId);
          
          // _id generated as ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          // identifier should NOT be set from syncIdentifier (scope fix)
          // Server only handles UUID _id, not syncIdentifier field
          should.not.exist(created.identifier);
          
          console.log('      ✓ syncIdentifier preserved, identifier NOT copied (scope fix)');
          done();
        });
    });

    it('TEST-ID-004: AAPS with identifier: null gets server-generated id', function(done) {
      // AAPS pattern: sends identifier: null, expects server to generate
      const aapsTreatment = {
        identifier: null,
        eventType: 'Bolus',
        insulin: 2.5,
        created_at: new Date().toISOString(),
        enteredBy: 'AAPS',
        pumpId: 12345,
        pumpType: 'OMNIPOD_DASH',
        pumpSerial: 'ABC123'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([aapsTreatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // _id should be generated ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          // pumpId fields preserved
          created.pumpId.should.equal(12345);
          
          // identifier may be null or set to _id depending on implementation
          console.log(`      _id: ${created._id}`);
          console.log(`      identifier: ${created.identifier || 'null'}`);
          console.log('      ✓ AAPS null identifier → ObjectId generated');
          done();
        });
    });

    it('TEST-ID-005: AAPS with identifier: ObjectId uses provided id', function(done) {
      // AAPS pattern for updates: sends existing identifier
      const existingId = '507f1f77bcf86cd799439011';
      
      const aapsUpdate = {
        identifier: existingId,
        eventType: 'Bolus',
        insulin: 3.0,
        created_at: new Date().toISOString(),
        enteredBy: 'AAPS',
        pumpId: 12345,
        pumpType: 'OMNIPOD_DASH',
        pumpSerial: 'ABC123'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([aapsUpdate])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // identifier should be preserved
          created.identifier.should.equal(existingId);
          
          // _id should match or be generated
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ AAPS ObjectId identifier preserved');
          done();
        });
    });

    it('TEST-ID-006: xDrip+ with uuid + _id fields both preserved', function(done) {
      const xdripUuid = 'xdrip-uuid-' + Date.now();
      const xdripId = '507f1f77bcf86cd799439012';
      
      const xdripEntry = {
        _id: xdripId,
        uuid: xdripUuid,
        eventType: 'BG Check',
        glucose: 120,
        glucoseType: 'Finger',
        created_at: new Date().toISOString(),
        enteredBy: 'xDrip+'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([xdripEntry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // uuid field should be preserved
          created.uuid.should.equal(xdripUuid);
          
          // _id should be ObjectId format
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log(`      uuid: ${created.uuid}`);
          console.log(`      _id: ${created._id}`);
          console.log('      ✓ xDrip+ uuid field preserved');
          done();
        });
    });
  });

  describe('v1 API Identity Behavior', function() {

    it('TEST-V1-ID-001: No id field generates ObjectId', function(done) {
      const treatment = {
        eventType: 'Note',
        notes: 'Test note without id',
        created_at: new Date().toISOString(),
        enteredBy: 'Test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // _id should be generated
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ No id → ObjectId generated');
          done();
        });
    });

    it('TEST-V1-ID-002: Valid ObjectId _id is used as-is', function(done) {
      const objectId = '507f1f77bcf86cd799439013';
      
      const treatment = {
        _id: objectId,
        eventType: 'Note',
        notes: 'Test with valid ObjectId',
        created_at: new Date().toISOString(),
        enteredBy: 'Test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // Should use provided ObjectId
          created._id.should.equal(objectId);
          
          console.log('      ✓ Valid ObjectId used as-is');
          done();
        });
    });

    it('TEST-V1-ID-003: UUID string _id promoted to identifier (REQ-SYNC-072)', function(done) {
      const uuid = 'C3D4E5F6-A7B8-9012-CDEF-345678901234';
      
      const treatment = {
        _id: uuid,
        eventType: 'Temporary Override',
        created_at: new Date().toISOString(),
        enteredBy: 'Loop',
        duration: 60,
        reason: 'UUID test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // REQ-SYNC-072: UUID promoted to identifier
          created.identifier.should.equal(uuid);
          
          // _id should be ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          created._id.should.not.equal(uuid);
          
          console.log('      ✓ UUID _id → identifier (REQ-SYNC-072)');
          done();
        });
    });

    it('TEST-V1-ID-004: syncIdentifier NOT copied to identifier (scope fix)', function(done) {
      const syncId = 'sync-id-' + Date.now();
      
      const treatment = {
        eventType: 'Carb Correction',
        carbs: 20,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // syncIdentifier preserved (not touched by server)
          created.syncIdentifier.should.equal(syncId);
          
          // identifier should NOT be set from syncIdentifier (scope fix)
          // Server only handles UUID _id, not syncIdentifier field
          should.not.exist(created.identifier);
          
          // _id generated
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ syncIdentifier preserved, identifier NOT copied (scope fix)');
          done();
        });
    });
  });

  describe('Deduplication by Identity Fields', function() {

    it('duplicate identifier does not create second document', function(done) {
      const identifier = 'dedup-test-' + Date.now();
      
      const first = {
        identifier: identifier,
        eventType: 'Note',
        notes: 'First',
        created_at: new Date().toISOString(),
        enteredBy: 'Test'
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([first])
        .expect(200)
        .end(function(err) {
          should.not.exist(err);
          
          const second = {
            identifier: identifier,
            eventType: 'Note',
            notes: 'Second (should update)',
            created_at: new Date().toISOString(),
            enteredBy: 'Test'
          };
          
          request(self.app)
            .post('/api/treatments/')
            .set('api-secret', api_secret_hash)
            .send([second])
            .end(function(err) {
              should.not.exist(err);
              
              self.ctx.treatments.list({ find: { identifier: identifier } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1);
                
                console.log('      ✓ Duplicate identifier does not create duplicate');
                done();
              });
            });
        });
    });

    it('different identifiers create separate documents', function(done) {
      const id1 = 'unique-1-' + Date.now();
      const id2 = 'unique-2-' + Date.now();
      
      const batch = [
        { identifier: id1, eventType: 'Note', notes: 'Note 1', created_at: new Date().toISOString(), enteredBy: 'Test' },
        { identifier: id2, eventType: 'Note', notes: 'Note 2', created_at: new Date().toISOString(), enteredBy: 'Test' }
      ];
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(2);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(2);
            
            console.log('      ✓ Different identifiers create separate documents');
            done();
          });
        });
    });
  });
});
