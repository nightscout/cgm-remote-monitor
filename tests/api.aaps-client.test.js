'use strict';

/**
 * AAPS-Specific Document Format Tests
 * 
 * REQUIREMENT REFERENCE: docs/proposals/mongodb-modernization-implementation-plan.md
 * 
 * AAPS (AndroidAPS) CLIENT CHARACTERISTICS:
 * - Sends individual documents (not batches) most of the time
 * - Uses pumpId, pumpType, pumpSerial for deduplication
 * - Includes rich metadata: app='AAPS', isValid, isSMB flags
 * - Uses v1 API for treatments and entries
 * - Entries include device='AndroidAPS-{CGMModel}'
 * 
 * CRITICAL BEHAVIORS TO TEST:
 * - Single document POST format
 * - Metadata field preservation
 * - Pump-specific deduplication fields
 * - Entry format with device and app fields
 * - Temp basal duration and rate handling
 * 
 * CLIENT: AndroidAPS (AAPS)
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
const fixtures = require('./fixtures');

describe('AAPS Client Document Handling', function() {
  this.timeout(15000);
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

  describe('AAPS Entry Format', function() {

    it('SGV entry with AAPS device metadata is stored correctly', function(done) {
      const entry = fixtures.aaps.sgvEntry;
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([entry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(1);
          should.exist(res.body[0]._id);
          
          // Verify in database
          self.ctx.entries.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(1);
            
            const stored = list[0];
            stored.type.should.equal('sgv');
            stored.sgv.should.equal(entry.sgv);
            stored.device.should.equal(entry.device);
            stored.direction.should.equal(entry.direction);
            stored.app.should.equal('AAPS');
            
            console.log('      ✓ AAPS SGV entry stored with all metadata');
            console.log(`        device: ${stored.device}, app: ${stored.app}, sgv: ${stored.sgv}`);
            done();
          });
        });
    });
  });

  describe('AAPS Treatment Formats', function() {

    it('SMB (Super Micro Bolus) is stored with AAPS metadata', function(done) {
      const treatment = fixtures.aaps.smbBolus;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          should.exist(res.body[0]._id);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(1);
            
            const stored = list[0];
            stored.eventType.should.equal('Correction Bolus');
            stored.insulin.should.equal(treatment.insulin);
            stored.type.should.equal('SMB');
            stored.isSMB.should.equal(true);
            stored.isValid.should.equal(true);
            stored.pumpId.should.equal(treatment.pumpId);
            stored.pumpType.should.equal(treatment.pumpType);
            stored.pumpSerial.should.equal(treatment.pumpSerial);
            stored.app.should.equal('AAPS');
            
            console.log('      ✓ SMB bolus stored with AAPS pump metadata');
            console.log(`        pumpId: ${stored.pumpId}, pumpType: ${stored.pumpType}, insulin: ${stored.insulin}U`);
            done();
          });
        });
    });

    it('Meal Bolus with carbs is stored correctly', function(done) {
      const treatment = fixtures.aaps.mealBolus;
      
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
            
            const stored = list[0];
            stored.eventType.should.equal('Meal Bolus');
            stored.insulin.should.equal(treatment.insulin);
            stored.carbs.should.equal(treatment.carbs);
            stored.type.should.equal('NORMAL');
            stored.isSMB.should.equal(false);
            stored.isValid.should.equal(true);
            stored.pumpId.should.equal(treatment.pumpId);
            
            console.log('      ✓ Meal bolus stored with insulin and carbs');
            console.log(`        insulin: ${stored.insulin}U, carbs: ${stored.carbs}g`);
            done();
          });
        });
    });

    it('Temp Basal with duration and rate is stored correctly', function(done) {
      const treatment = fixtures.aaps.tempBasal;
      
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
            
            const stored = list[0];
            stored.eventType.should.equal('Temp Basal');
            stored.duration.should.equal(treatment.duration);
            stored.rate.should.equal(treatment.rate);
            stored.isValid.should.equal(true);
            
            console.log('      ✓ Temp basal stored with duration and rate');
            console.log(`        duration: ${stored.duration}min, rate: ${stored.rate}U/hr`);
            done();
          });
        });
    });
  });

  describe('AAPS Pump Metadata Preservation', function() {

    it('pumpId, pumpType, pumpSerial are preserved for deduplication', function(done) {
      const treatment = fixtures.aaps.smbBolus;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            const stored = list[0];
            
            // CRITICAL: These fields are used for deduplication
            should.exist(stored.pumpId, 'pumpId must be preserved');
            should.exist(stored.pumpType, 'pumpType must be preserved');
            should.exist(stored.pumpSerial, 'pumpSerial must be preserved');
            
            stored.pumpId.should.equal(treatment.pumpId);
            stored.pumpType.should.equal(treatment.pumpType);
            stored.pumpSerial.should.equal(treatment.pumpSerial);
            
            console.log('      ✓ Pump deduplication fields preserved');
            done();
          });
        });
    });

    it('isValid and isSMB flags are preserved', function(done) {
      const treatment = fixtures.aaps.smbBolus;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            const stored = list[0];
            
            // AAPS uses these flags for filtering and display
            should.exist(stored.isValid, 'isValid flag must be preserved');
            should.exist(stored.isSMB, 'isSMB flag must be preserved');
            
            stored.isValid.should.equal(true);
            stored.isSMB.should.equal(true);
            
            console.log('      ✓ AAPS boolean flags preserved');
            done();
          });
        });
    });
  });

  describe('AAPS Single vs Batch Behavior', function() {

    it('single document wrapped in array is processed correctly', function(done) {
      // AAPS typically sends single documents wrapped in array format
      const treatment = fixtures.aaps.mealBolus;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment]) // Single item in array
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(1);
          should.exist(res.body[0]._id);
          
          console.log('      ✓ Single-item array processed correctly');
          done();
        });
    });

    it('multiple AAPS documents can be batched', function(done) {
      // AAPS could potentially batch multiple treatments
      const batch = [
        fixtures.aaps.smbBolus,
        fixtures.aaps.mealBolus,
        fixtures.aaps.tempBasal
      ];
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          res.body.length.should.equal(batch.length);
          
          self.ctx.treatments.list({}, function(err, list) {
            should.not.exist(err);
            list.length.should.equal(batch.length);
            
            console.log('      ✓ AAPS batch insert works correctly');
            done();
          });
        });
    });
  });

  describe('AAPS Response Format', function() {

    it('response includes _id for AAPS to track inserted documents', function(done) {
      const treatment = fixtures.aaps.smbBolus;
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([treatment])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.should.be.instanceof(Array);
          
          const responseItem = res.body[0];
          should.exist(responseItem._id, 'Response must include _id');
          responseItem._id.should.be.a.String();
          
          console.log(`      ✓ Response _id: ${responseItem._id}`);
          done();
        });
    });
  });

  describe('AAPS utcOffset Handling', function() {

    it('utcOffset is recalculated from dateString timezone info', function(done) {
      // QUIRK/FEATURE: Nightscout recalculates utcOffset from the dateString's timezone
      // See lib/server/entries.js:113 - doc.utcOffset = _sysTime.utcOffset()
      // This means the client's utcOffset value is overwritten with the value
      // parsed from dateString. If dateString is UTC (ends in 'Z'), utcOffset becomes 0.
      
      const entry = {
        type: 'sgv',
        sgv: 120,
        date: Date.now(),
        dateString: '2026-01-18T10:30:00+02:00', // UTC+2 timezone
        device: 'AndroidAPS-DexcomG6',
        direction: 'Flat',
        app: 'AAPS',
        utcOffset: 999 // This will be overwritten to 120 (from +02:00)
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([entry])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          self.ctx.entries.list({}, function(err, list) {
            should.not.exist(err);
            const stored = list[0];
            
            // utcOffset is recalculated from dateString, not preserved from input
            should.exist(stored.utcOffset);
            stored.utcOffset.should.equal(120); // +02:00 = 120 minutes
            
            console.log(`      ✓ utcOffset recalculated from dateString: ${stored.utcOffset} minutes (from ${entry.dateString})`);
            done();
          });
        });
    });
  });
});
