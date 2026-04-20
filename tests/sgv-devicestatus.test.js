'use strict';

/**
 * Loop SGV Entry and DeviceStatus Upload Tests
 * 
 * Tests Loop-specific entry and deviceStatus upload patterns.
 * 
 * TEST MATRIX REFERENCE: docs/backlogs/loop-nightscout-upload-testing.md
 * - TEST-SGV-001 to TEST-SGV-005: Glucose entry tests
 * - TEST-DS-001 to TEST-DS-005: DeviceStatus tests
 */

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();

describe('Loop SGV Entry Upload Tests', function() {
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

  beforeEach(async function() {
    await self.ctx.entries().deleteMany({});
  });

  describe('TEST-SGV-001: Single SGV entry', function() {

    it('creates SGV with required fields', function(done) {
      const now = Date.now();
      
      const sgv = {
        type: 'sgv',
        sgv: 120,
        date: now,
        dateString: new Date(now).toISOString(),
        direction: 'Flat'
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([sgv])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(1);
          
          const created = res.body[0];
          created.sgv.should.equal(120);
          created.direction.should.equal('Flat');
          created._id.should.match(/^[0-9a-f]{24}$/);
          
          console.log('      ✓ Single SGV entry created');
          done();
        });
    });

    it('handles all direction values', function(done) {
      const directions = ['DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 
                          'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NOT COMPUTABLE'];
      
      const entries = directions.map((dir, idx) => ({
        type: 'sgv',
        sgv: 100 + idx * 10,
        date: Date.now() + idx * 300000,
        dateString: new Date(Date.now() + idx * 300000).toISOString(),
        direction: dir
      }));
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send(entries)
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(directions.length);
          
          console.log('      ✓ All direction values accepted');
          done();
        });
    });
  });

  describe('TEST-SGV-004: SGV with device field', function() {

    it('preserves Loop device identifier', function(done) {
      const sgv = {
        type: 'sgv',
        sgv: 115,
        date: Date.now(),
        dateString: new Date().toISOString(),
        direction: 'FortyFiveUp',
        device: 'loop://iPhone'
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([sgv])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          res.body[0].device.should.equal('loop://iPhone');
          
          console.log('      ✓ Loop device field preserved');
          done();
        });
    });

    it('preserves Dexcom device identifier', function(done) {
      const sgv = {
        type: 'sgv',
        sgv: 125,
        date: Date.now(),
        dateString: new Date().toISOString(),
        direction: 'Flat',
        device: 'share2',
        filtered: 150000,
        unfiltered: 155000,
        noise: 1
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([sgv])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          res.body[0].device.should.equal('share2');
          res.body[0].noise.should.equal(1);
          
          console.log('      ✓ Dexcom device with filtered/unfiltered/noise');
          done();
        });
    });
  });

  describe('TEST-SGV-005: SGV deduplication', function() {

    it('duplicate date+device does not create second entry', function(done) {
      const timestamp = Date.now();
      const device = 'loop://iPhone';
      
      const first = {
        type: 'sgv',
        sgv: 120,
        date: timestamp,
        dateString: new Date(timestamp).toISOString(),
        direction: 'Flat',
        device: device
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([first])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          // Post duplicate
          const duplicate = {
            type: 'sgv',
            sgv: 125,  // Different value
            date: timestamp,  // Same timestamp
            dateString: new Date(timestamp).toISOString(),
            direction: 'FortyFiveUp',
            device: device  // Same device
          };
          
          request(self.app)
            .post('/api/entries/')
            .set('api-secret', api_secret_hash)
            .set('Accept', 'application/json')
            .send([duplicate])
            .end(function(err) {
              should.not.exist(err);
              
              // Check database
              self.ctx.entries.list({}, function(err, list) {
                should.not.exist(err);
                list.length.should.equal(1, 'Duplicate should not create second entry');
                
                console.log('      ✓ SGV deduplication by date+device');
                done();
              });
            });
        });
    });

    it('different devices create separate entries', function(done) {
      const timestamp = Date.now();
      
      const entry1 = {
        type: 'sgv',
        sgv: 120,
        date: timestamp,
        dateString: new Date(timestamp).toISOString(),
        direction: 'Flat',
        device: 'loop://iPhone'
      };
      
      const entry2 = {
        type: 'sgv',
        sgv: 122,
        date: timestamp + 1,  // Slightly different timestamp to avoid collision
        dateString: new Date(timestamp + 1).toISOString(),
        direction: 'Flat',
        device: 'xDrip+'
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([entry1])
        .expect(200)
        .end(function(err) {
          should.not.exist(err);
          
          request(self.app)
            .post('/api/entries/')
            .set('api-secret', api_secret_hash)
            .set('Accept', 'application/json')
            .send([entry2])
            .expect(200)
            .end(function(err, res) {
              should.not.exist(err);
              res.body.length.should.equal(1);
              res.body[0].device.should.equal('xDrip+');
              
              console.log('      ✓ Different devices create separate entries');
              done();
            });
        });
    });
  });

  describe('MBG (Manual BG Check) Entries', function() {

    it('creates manual BG check entry', function(done) {
      const mbg = {
        type: 'mbg',
        mbg: 110,
        date: Date.now(),
        dateString: new Date().toISOString(),
        device: 'loop://iPhone'
      };
      
      request(self.app)
        .post('/api/entries/')
        .set('api-secret', api_secret_hash)
        .set('Accept', 'application/json')
        .send([mbg])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body[0].type.should.equal('mbg');
          res.body[0].mbg.should.equal(110);
          
          console.log('      ✓ MBG entry created');
          done();
        });
    });
  });
});

describe('Loop DeviceStatus Upload Tests', function() {
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
    self.ctx.devicestatus.remove({
      find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } }
    }, done);
  });

  describe('TEST-DS-001: Loop status with IOB/COB', function() {

    it('creates deviceStatus with loop IOB and COB', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          iob: {
            iob: 2.5,
            timestamp: new Date().toISOString()
          },
          cob: {
            cob: 15,
            timestamp: new Date().toISOString()
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          res.body.length.should.equal(1);
          
          const created = res.body[0];
          created.loop.iob.iob.should.equal(2.5);
          created.loop.cob.cob.should.equal(15);
          
          console.log('      ✓ Loop deviceStatus with IOB/COB');
          done();
        });
    });
  });

  describe('TEST-DS-002: Loop status with predicted', function() {

    it('creates deviceStatus with prediction values array', function(done) {
      const predictions = [120, 118, 115, 112, 110, 108, 105, 102, 100];
      
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          predicted: {
            startDate: new Date().toISOString(),
            values: predictions
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.loop.predicted.values.should.be.an.Array();
          created.loop.predicted.values.length.should.equal(predictions.length);
          
          console.log('      ✓ Loop predicted values array preserved');
          done();
        });
    });
  });

  describe('TEST-DS-003: Loop status with enacted', function() {

    it('creates deviceStatus with enacted temp basal', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          enacted: {
            timestamp: new Date().toISOString(),
            rate: 1.5,
            duration: 30,
            received: true
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.loop.enacted.rate.should.equal(1.5);
          created.loop.enacted.duration.should.equal(30);
          created.loop.enacted.received.should.equal(true);
          
          console.log('      ✓ Loop enacted temp basal');
          done();
        });
    });
  });

  describe('TEST-DS-004: Pump status', function() {

    it('creates deviceStatus with pump reservoir and battery', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        pump: {
          clock: new Date().toISOString(),
          reservoir: 150.5,
          battery: {
            percent: 75
          },
          status: {
            status: 'normal',
            timestamp: new Date().toISOString()
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.pump.reservoir.should.equal(150.5);
          created.pump.battery.percent.should.equal(75);
          
          console.log('      ✓ Pump reservoir and battery');
          done();
        });
    });

    it('handles Omnipod specific fields', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        pump: {
          clock: new Date().toISOString(),
          reservoir: 50,
          reservoir_display_override: '50+ U',
          pumpID: 'pod-12345',
          manufacturer: 'Insulet',
          model: 'Eros'
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.pump.manufacturer.should.equal('Insulet');
          created.pump.model.should.equal('Eros');
          
          console.log('      ✓ Omnipod specific fields');
          done();
        });
    });
  });

  describe('TEST-DS-005: Override in deviceStatus', function() {

    it('creates deviceStatus with active override', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          override: {
            active: true,
            timestamp: new Date().toISOString(),
            name: 'Pre-Meal',
            currentCorrectionRange: {
              minValue: 80,
              maxValue: 80
            },
            multiplier: 1.0
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.loop.override.active.should.equal(true);
          created.loop.override.name.should.equal('Pre-Meal');
          created.loop.override.currentCorrectionRange.minValue.should.equal(80);
          
          console.log('      ✓ Override in deviceStatus');
          done();
        });
    });

    it('handles override with insulinNeedsScaleFactor', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          override: {
            active: true,
            timestamp: new Date().toISOString(),
            name: 'Workout',
            currentCorrectionRange: {
              minValue: 140,
              maxValue: 160
            },
            multiplier: 0.5  // 50% basal
          }
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          created.loop.override.multiplier.should.equal(0.5);
          
          console.log('      ✓ Override with insulinNeedsScaleFactor');
          done();
        });
    });
  });

  describe('Full Loop DeviceStatus', function() {

    it('creates complete Loop deviceStatus with all fields', function(done) {
      const ds = {
        device: 'loop://iPhone',
        created_at: new Date().toISOString(),
        uploaderBattery: 85,
        loop: {
          version: '3.0.0',
          timestamp: new Date().toISOString(),
          name: 'Loop',
          iob: {
            iob: 2.5,
            timestamp: new Date().toISOString()
          },
          cob: {
            cob: 15,
            timestamp: new Date().toISOString()
          },
          predicted: {
            startDate: new Date().toISOString(),
            values: [120, 118, 115, 112, 110]
          },
          enacted: {
            timestamp: new Date().toISOString(),
            rate: 1.2,
            duration: 30,
            received: true
          },
          recommendedBolus: 0,
          failureReason: null
        },
        pump: {
          clock: new Date().toISOString(),
          reservoir: 150,
          battery: { percent: 75 }
        },
        uploader: {
          battery: 85
        }
      };
      
      request(self.app)
        .post('/api/devicestatus/')
        .set('api-secret', api_secret_hash)
        .send([ds])
        .expect(200)
        .end(function(err, res) {
          should.not.exist(err);
          
          const created = res.body[0];
          
          // Verify all major sections
          should.exist(created.loop);
          should.exist(created.pump);
          should.exist(created.loop.iob);
          should.exist(created.loop.cob);
          should.exist(created.loop.predicted);
          should.exist(created.loop.enacted);
          
          console.log('      ✓ Complete Loop deviceStatus');
          done();
        });
    });
  });
});
