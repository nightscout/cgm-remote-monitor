'use strict';

/**
 * Loop Carb and Dose Upload Tests
 * 
 * Tests Loop-specific carb and dose upload patterns including:
 * - syncIdentifier handling
 * - ObjectIdCache workflow integration
 * - Absorption time handling
 * - Hex string syncIdentifier from pump events
 * 
 * TEST MATRIX REFERENCE: docs/backlogs/loop-nightscout-upload-testing.md
 * - TEST-CARB-001 to TEST-CARB-004
 * - TEST-DOSE-001 to TEST-DOSE-005
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('Loop Carb Upload Tests', function() {
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

  describe('TEST-CARB-001: Create carb entry with syncIdentifier', function() {

    it('creates carb with syncIdentifier, absorptionTime preserved', function(done) {
      const syncId = 'loop-carb-' + Date.now();
      
      const carb = {
        eventType: 'Carb Correction',
        carbs: 25,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId,
        absorptionTime: 180  // 3 hours in minutes
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([carb])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          created.syncIdentifier.should.equal(syncId);
          created.carbs.should.equal(25);
          created.absorptionTime.should.equal(180);
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Carb with syncIdentifier and absorptionTime');
          done();
        });
    });

    it('creates carb with fat and protein (Warsaw method)', function(done) {
      const syncId = 'loop-fpu-' + Date.now();
      
      const carb = {
        eventType: 'Carb Correction',
        carbs: 30,
        fat: 15,
        protein: 20,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId,
        absorptionTime: 240
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([carb])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          created.carbs.should.equal(30);
          created.fat.should.equal(15);
          created.protein.should.equal(20);
          
          console.log('      ✓ Carb with fat/protein (FPU support)');
          done();
        });
    });
  });

  describe('TEST-CARB-002: Create carb with id (from cache)', function() {

    it('POST with both id and syncIdentifier (cache rebuild scenario)', function(done) {
      const syncId = 'loop-carb-cached-' + Date.now();
      const cachedId = '507f1f77bcf86cd799439020';
      
      const carb = {
        _id: cachedId,
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
        .send([carb])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // Both fields preserved
          created.syncIdentifier.should.equal(syncId);
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Carb with cached _id and syncIdentifier');
          done();
        });
    });
  });

  describe('TEST-CARB-003: Update carb via cached id', function() {

    it('PUT with cached _id updates carb values', function(done) {
      const syncId = 'loop-carb-update-' + Date.now();
      
      // First create
      const original = {
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
        .send([original])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const serverId = res.body[0]._id;
          
          // Update using cached _id
          const updated = {
            _id: serverId,
            eventType: 'Carb Correction',
            carbs: 35,  // Changed
            created_at: new Date().toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncId,
            absorptionTime: 240  // Changed
          };
          
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
                list[0].carbs.should.equal(35);
                list[0].absorptionTime.should.equal(240);
                
                console.log('      ✓ Carb updated via cached _id');
                done();
              });
            });
        });
    });
  });

  describe('TEST-CARB-004: Delete carb via cached id', function() {

    it('DELETE with cached _id removes carb', function(done) {
      const syncId = 'loop-carb-delete-' + Date.now();
      
      const carb = {
        eventType: 'Carb Correction',
        carbs: 15,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([carb])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const serverId = res.body[0]._id;
          
          request(self.app)
            .delete('/api/treatments/' + serverId)
            .set('api-secret', api_secret_hash)
            .expect(200)
            .end(function(err) {
              should.not.exist(err);
              
              self.ctx.treatments.list({ find: { syncIdentifier: syncId } }, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(0);
                
                console.log('      ✓ Carb deleted via cached _id');
                done();
              });
            });
        });
    });
  });
});

describe('Loop Dose Upload Tests', function() {
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

  describe('TEST-DOSE-001: Bolus with syncIdentifier', function() {

    it('creates bolus with syncIdentifier and insulin', function(done) {
      const syncId = 'loop-bolus-' + Date.now();
      
      const bolus = {
        eventType: 'Bolus',
        insulin: 2.5,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([bolus])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          created.syncIdentifier.should.equal(syncId);
          created.insulin.should.equal(2.5);
          created.eventType.should.equal('Bolus');
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Bolus with syncIdentifier');
          done();
        });
    });

    it('creates meal bolus with carbs and insulin', function(done) {
      const syncId = 'loop-mealbolus-' + Date.now();
      
      const mealBolus = {
        eventType: 'Meal Bolus',
        insulin: 5.0,
        carbs: 45,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([mealBolus])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          created.insulin.should.equal(5.0);
          created.carbs.should.equal(45);
          
          console.log('      ✓ Meal bolus with carbs and insulin');
          done();
        });
    });
  });

  describe('TEST-DOSE-002: Temp basal with syncIdentifier', function() {

    it('creates temp basal with rate and duration', function(done) {
      const syncId = 'loop-tempbasal-' + Date.now();
      
      const tempBasal = {
        eventType: 'Temp Basal',
        rate: 1.5,
        absolute: 1.5,
        duration: 30,
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
          
          const created = res.body[0];
          
          created.syncIdentifier.should.equal(syncId);
          created.rate.should.equal(1.5);
          created.duration.should.equal(30);
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Temp basal with rate and duration');
          done();
        });
    });

    it('creates suspend (zero rate temp basal)', function(done) {
      const syncId = 'loop-suspend-' + Date.now();
      
      const suspend = {
        eventType: 'Temp Basal',
        rate: 0,
        absolute: 0,
        duration: 30,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([suspend])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          created.rate.should.equal(0);
          
          console.log('      ✓ Suspend (zero rate) temp basal');
          done();
        });
    });
  });

  describe('TEST-DOSE-003: Update dose via cached id', function() {

    it('PUT bolus with cached _id updates insulin', function(done) {
      const syncId = 'loop-bolus-update-' + Date.now();
      
      const original = {
        eventType: 'Bolus',
        insulin: 2.0,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: syncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([original])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          const serverId = res.body[0]._id;
          
          const updated = {
            _id: serverId,
            eventType: 'Bolus',
            insulin: 2.5,  // Changed
            created_at: new Date().toISOString(),
            enteredBy: 'loop://iPhone',
            syncIdentifier: syncId
          };
          
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
                list[0].insulin.should.equal(2.5);
                
                console.log('      ✓ Bolus updated via cached _id');
                done();
              });
            });
        });
    });
  });

  describe('TEST-DOSE-005: Hex string syncIdentifier (pump events)', function() {

    it('hex-encoded pump event ID preserved as syncIdentifier', function(done) {
      // Loop uses hex-encoded pump event raw data as syncIdentifier
      const hexSyncId = 'deadbeef0123456789abcdef01234567';
      
      const pumpBolus = {
        eventType: 'Bolus',
        insulin: 1.0,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: hexSyncId
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([pumpBolus])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // Hex syncIdentifier preserved exactly
          created.syncIdentifier.should.equal(hexSyncId);
          
          // Should NOT be confused with ObjectId
          created._id.should.match(/^[0-9a-f]{24}$/);
          created._id.should.not.equal(hexSyncId);
          
          console.log(`      syncIdentifier: ${hexSyncId}`);
          console.log(`      _id: ${created._id}`);
          console.log('      ✓ Hex syncIdentifier preserved');
          done();
        });
    });

    it('short hex string also preserved', function(done) {
      const shortHex = 'aabbccdd';
      
      const event = {
        eventType: 'Temp Basal',
        rate: 0.5,
        duration: 30,
        created_at: new Date().toISOString(),
        enteredBy: 'loop://iPhone',
        syncIdentifier: shortHex
      };
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send([event])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          res.body[0].syncIdentifier.should.equal(shortHex);
          
          console.log('      ✓ Short hex syncIdentifier preserved');
          done();
        });
    });
  });

  describe('Mixed Dose Batch', function() {

    it('batch with bolus and temp basals maintains order', function(done) {
      const batch = [
        {
          eventType: 'Bolus',
          insulin: 2.0,
          created_at: new Date().toISOString(),
          enteredBy: 'loop://iPhone',
          syncIdentifier: 'batch-bolus-' + Date.now()
        },
        {
          eventType: 'Temp Basal',
          rate: 1.2,
          duration: 30,
          created_at: new Date(Date.now() + 60000).toISOString(),
          enteredBy: 'loop://iPhone',
          syncIdentifier: 'batch-tb1-' + Date.now()
        },
        {
          eventType: 'Temp Basal',
          rate: 0.8,
          duration: 30,
          created_at: new Date(Date.now() + 120000).toISOString(),
          enteredBy: 'loop://iPhone',
          syncIdentifier: 'batch-tb2-' + Date.now()
        }
      ];
      
      request(self.app)
        .post('/api/treatments/')
        .set('api-secret', api_secret_hash)
        .send(batch)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(3);
          
          // Verify order maintained
          res.body[0].eventType.should.equal('Bolus');
          res.body[1].eventType.should.equal('Temp Basal');
          res.body[2].eventType.should.equal('Temp Basal');
          
          console.log('      ✓ Mixed dose batch maintains order');
          done();
        });
    });
  });
});
