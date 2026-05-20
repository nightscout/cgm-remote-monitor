'use strict';

var request = require('supertest');
var should = require('should');
var language = require('../lib/language')();

var aapsPatterns = require('./fixtures/aaps-patterns.json');

describe('Concurrent Write Tests - MongoDB 5.x Compatibility', function () {
  this.timeout(30000);
  var self = this;
  var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

  var api = require('../lib/api/');

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    self.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  after(function (done) {
    if (self.ctx && self.ctx.bus) {
      self.ctx.bus.teardown();
    }
    done();
  });

  describe('Simultaneous POST requests to treatments', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('handles 5 simultaneous single object POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var treatment = {
          eventType: 'Note',
          created_at: new Date(baseTime + i * 1000).toISOString(),
          notes: 'concurrent single ' + i
        };

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send(treatment)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
            result.length.should.be.greaterThanOrEqual(1);
          });

          self.ctx.treatments.list({}, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(5);
            done();
          });
        })
        .catch(done);
    });

    it('handles 5 simultaneous array POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var treatments = [
          {
            eventType: 'Note',
            created_at: new Date(baseTime + i * 10000).toISOString(),
            notes: 'concurrent array batch ' + i + ' item 1'
          },
          {
            eventType: 'Note',
            created_at: new Date(baseTime + i * 10000 + 1000).toISOString(),
            notes: 'concurrent array batch ' + i + ' item 2'
          }
        ];

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send(treatments)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          var totalCreated = 0;
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
            totalCreated += result.length;
          });

          totalCreated.should.equal(10);

          self.ctx.treatments.list({}, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(10);
            done();
          });
        })
        .catch(done);
    });

    it('handles rapid sequential POSTs (10 in 100ms)', function (done) {
      var promises = [];
      var baseTime = Date.now();

      function makeRequest(index) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            var treatment = {
              eventType: 'Note',
              created_at: new Date(baseTime + index * 100).toISOString(),
              notes: 'rapid sequential ' + index
            };

            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send(treatment)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          }, index * 10);
        });
      }

      for (var i = 0; i < 10; i++) {
        promises.push(makeRequest(i));
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(10);
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
          });

          self.ctx.treatments.list({}, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(10);
            done();
          });
        })
        .catch(done);
    });
  });

  describe('Simultaneous POST requests to devicestatus', function () {

    beforeEach(function (done) {
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('handles 5 simultaneous single object POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var status = {
          device: 'concurrent-device-' + i,
          created_at: new Date(baseTime + i * 1000).toISOString(),
          uploaderBattery: 80 + i
        };

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/devicestatus/')
              .set('api-secret', known)
              .send(status)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
            result.length.should.equal(1);
          });

          self.ctx.devicestatus.list({}, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(5);
            done();
          });
        })
        .catch(done);
    });

    it('handles 5 simultaneous array POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var statuses = [
          {
            device: 'concurrent-batch-' + i + '-a',
            created_at: new Date(baseTime + i * 10000).toISOString(),
            uploaderBattery: 70 + i
          },
          {
            device: 'concurrent-batch-' + i + '-b',
            created_at: new Date(baseTime + i * 10000 + 1000).toISOString(),
            uploaderBattery: 75 + i
          }
        ];

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/devicestatus/')
              .set('api-secret', known)
              .send(statuses)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          var totalCreated = 0;
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
            totalCreated += result.length;
          });

          totalCreated.should.equal(10);

          self.ctx.devicestatus.list({}, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(10);
            done();
          });
        })
        .catch(done);
    });
  });

  describe('Simultaneous POST requests to entries', function () {

    beforeEach(async function () {
      await self.ctx.entries().deleteMany({});
    });

    afterEach(async function () {
      await self.ctx.entries().deleteMany({});
    });

    it('handles 5 simultaneous single entry POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var entry = {
          type: 'sgv',
          sgv: 100 + i * 5,
          date: baseTime + i * 300000,
          dateString: new Date(baseTime + i * 300000).toISOString()
        };

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/entries/')
              .set('api-secret', known)
              .send(entry)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
          });

          self.ctx.entries.list({ count: 20 }, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(5);
            done();
          });
        })
        .catch(done);
    });

    it('handles 5 simultaneous array entry POSTs', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var entries = [
          {
            type: 'sgv',
            sgv: 100 + i * 10,
            date: baseTime + i * 1000000,
            dateString: new Date(baseTime + i * 1000000).toISOString()
          },
          {
            type: 'sgv',
            sgv: 105 + i * 10,
            date: baseTime + i * 1000000 + 300000,
            dateString: new Date(baseTime + i * 1000000 + 300000).toISOString()
          }
        ];

        promises.push(
          new Promise(function (resolve, reject) {
            request(self.app)
              .post('/api/entries/')
              .set('api-secret', known)
              .send(entries)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(5);
          var totalCreated = 0;
          results.forEach(function (result) {
            result.should.be.instanceof(Array);
            totalCreated += result.length;
          });

          totalCreated.should.equal(10);

          self.ctx.entries.list({ count: 20 }, function (err, list) {
            should.not.exist(err);
            list.length.should.be.greaterThanOrEqual(10);
            done();
          });
        })
        .catch(done);
    });
  });

  describe('Cross-collection concurrent writes', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
          self.ctx.entries().deleteMany({})
            .then(function () {
              done();
            })
            .catch(done);
        });
      });
    });

    afterEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
          self.ctx.entries().deleteMany({})
            .then(function () {
              done();
            })
            .catch(done);
        });
      });
    });

    it('handles simultaneous writes to treatments, devicestatus, and entries', function (done) {
      var baseTime = Date.now();

      var treatmentPromise = new Promise(function (resolve, reject) {
        request(self.app)
          .post('/api/treatments/')
          .set('api-secret', known)
          .send([
            { eventType: 'Note', created_at: new Date(baseTime).toISOString(), notes: 'cross-collection 1' },
            { eventType: 'Note', created_at: new Date(baseTime + 1000).toISOString(), notes: 'cross-collection 2' }
          ])
          .expect(200)
          .end(function (err, res) {
            if (err) return reject(err);
            resolve({ collection: 'treatments', body: res.body });
          });
      });

      var devicestatusPromise = new Promise(function (resolve, reject) {
        request(self.app)
          .post('/api/devicestatus/')
          .set('api-secret', known)
          .send([
            { device: 'cross-device-1', created_at: new Date(baseTime).toISOString(), uploaderBattery: 80 },
            { device: 'cross-device-2', created_at: new Date(baseTime + 1000).toISOString(), uploaderBattery: 75 }
          ])
          .expect(200)
          .end(function (err, res) {
            if (err) return reject(err);
            resolve({ collection: 'devicestatus', body: res.body });
          });
      });

      var entriesPromise = new Promise(function (resolve, reject) {
        request(self.app)
          .post('/api/entries/')
          .set('api-secret', known)
          .send([
            { type: 'sgv', sgv: 120, date: baseTime, dateString: new Date(baseTime).toISOString() },
            { type: 'sgv', sgv: 125, date: baseTime + 300000, dateString: new Date(baseTime + 300000).toISOString() }
          ])
          .expect(200)
          .end(function (err, res) {
            if (err) return reject(err);
            resolve({ collection: 'entries', body: res.body });
          });
      });

      Promise.all([treatmentPromise, devicestatusPromise, entriesPromise])
        .then(function (results) {
          results.length.should.equal(3);

          var treatmentResult = results.find(function (r) { return r.collection === 'treatments'; });
          var devicestatusResult = results.find(function (r) { return r.collection === 'devicestatus'; });
          var entriesResult = results.find(function (r) { return r.collection === 'entries'; });

          treatmentResult.body.should.be.instanceof(Array);
          treatmentResult.body.length.should.equal(2);

          devicestatusResult.body.should.be.instanceof(Array);
          devicestatusResult.body.length.should.equal(2);

          entriesResult.body.should.be.instanceof(Array);
          entriesResult.body.length.should.equal(2);

          done();
        })
        .catch(done);
    });
  });

  describe('Data integrity under concurrent load', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('all documents have unique _id after concurrent inserts', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 10; i++) {
        promises.push(
          new Promise(function (resolve, reject) {
            var treatment = {
              eventType: 'Note',
              created_at: new Date(baseTime + Math.random() * 10000).toISOString(),
              notes: 'unique id test ' + Math.random()
            };

            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send(treatment)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve(res.body[0]._id);
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (ids) {
          ids.length.should.equal(10);

          var uniqueIds = new Set(ids);
          uniqueIds.size.should.equal(10);

          done();
        })
        .catch(done);
    });

    it('response count matches request count under concurrent load', function (done) {
      var promises = [];
      var baseTime = Date.now();

      for (var i = 0; i < 5; i++) {
        var batchSize = 3;
        var treatments = [];

        for (var j = 0; j < batchSize; j++) {
          treatments.push({
            eventType: 'Note',
            created_at: new Date(baseTime + i * 100000 + j * 1000).toISOString(),
            notes: 'batch ' + i + ' item ' + j
          });
        }

        promises.push(
          new Promise(function (resolve, reject) {
            var batch = treatments;
            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send(batch)
              .expect(200)
              .end(function (err, res) {
                if (err) return reject(err);
                resolve({ sent: batch.length, received: res.body.length });
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.forEach(function (result) {
            result.received.should.equal(result.sent);
          });
          done();
        })
        .catch(done);
    });
  });

  describe('AAPS Sync Catch-up Simulation', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { eventType: { '$regex': '^Correction Bolus' } } }, function () {
        done();
      });
    });

    afterEach(function (done) {
      self.ctx.treatments.remove({ find: { eventType: { '$regex': '^Correction Bolus' } } }, function () {
        done();
      });
    });

    it('handles 50 rapid sequential SMB-style POSTs (AAPS offline recovery simulation)', function (done) {
      this.timeout(60000);
      var baseTime = Date.now();
      var successCount = 0;
      var errorCount = 0;
      var totalRequests = 50;
      var completed = 0;

      function makeRequest(index) {
        var smb = {
          eventType: 'Correction Bolus',
          insulin: 0.1 + (Math.random() * 0.4),
          isSMB: true,
          pumpId: 10000 + index,
          pumpType: aapsPatterns.PUMP_IDENTIFIERS.ACCU_CHEK_INSIGHT.pumpType,
          pumpSerial: aapsPatterns.PUMP_IDENTIFIERS.ACCU_CHEK_INSIGHT.pumpSerial,
          created_at: new Date(baseTime + index * 300000).toISOString(),
          notes: 'AAPS sync catch-up ' + index
        };

        request(self.app)
          .post('/api/treatments/')
          .set('api-secret', known)
          .send(smb)
          .end(function (err, res) {
            completed++;
            if (err || res.status !== 200) {
              errorCount++;
            } else {
              successCount++;
            }

            if (completed === totalRequests) {
              successCount.should.equal(totalRequests);
              errorCount.should.equal(0);

              self.ctx.treatments.list({ find: { eventType: 'Correction Bolus' } }, function (listErr, list) {
                should.not.exist(listErr);
                list.length.should.be.greaterThanOrEqual(totalRequests);
                done();
              });
            }
          });
      }

      for (var i = 0; i < totalRequests; i++) {
        setTimeout(makeRequest.bind(null, i), i * 5);
      }
    });

    it('handles 100 rapid sequential SGV-style POSTs to entries', function (done) {
      this.timeout(90000);
      var baseTime = Date.now();
      var successCount = 0;
      var errorCount = 0;
      var totalRequests = 100;
      var completed = 0;

      function makeRequest(index) {
        var sgv = {
          type: 'sgv',
          sgv: 80 + Math.floor(Math.random() * 100),
          date: baseTime + index * 300000,
          dateString: new Date(baseTime + index * 300000).toISOString(),
          device: 'AndroidAPS-DexcomG6',
          direction: ['Flat', 'FortyFiveUp', 'SingleUp', 'FortyFiveDown'][index % 4]
        };

        request(self.app)
          .post('/api/entries/')
          .set('api-secret', known)
          .send(sgv)
          .end(function (err, res) {
            completed++;
            if (err || res.status !== 200) {
              errorCount++;
            } else {
              successCount++;
            }

            if (completed === totalRequests) {
              successCount.should.equal(totalRequests);
              errorCount.should.equal(0);

              self.ctx.entries.list({ find: { device: 'AndroidAPS-DexcomG6' } }, function (listErr, list) {
                should.not.exist(listErr);
                list.length.should.be.greaterThanOrEqual(totalRequests);
                done();
              });
            }
          });
      }

      for (var i = 0; i < totalRequests; i++) {
        setTimeout(makeRequest.bind(null, i), i * 3);
      }
    });

    it('handles concurrent cross-collection sync (treatments + entries + devicestatus)', function (done) {
      this.timeout(60000);
      var baseTime = Date.now();
      var promises = [];

      for (var i = 0; i < 10; i++) {
        promises.push(
          new Promise(function (resolve, reject) {
            var idx = i;
            request(self.app)
              .post('/api/treatments/')
              .set('api-secret', known)
              .send({
                eventType: 'Correction Bolus',
                insulin: 0.2,
                created_at: new Date(baseTime + idx * 60000).toISOString(),
                notes: 'cross-collection treatment ' + idx
              })
              .end(function (err, res) {
                if (err) return reject(err);
                resolve({ type: 'treatment', status: res.status });
              });
          })
        );

        promises.push(
          new Promise(function (resolve, reject) {
            var idx = i;
            request(self.app)
              .post('/api/entries/')
              .set('api-secret', known)
              .send({
                type: 'sgv',
                sgv: 100 + idx * 5,
                date: baseTime + idx * 60000,
                device: 'cross-collection-test'
              })
              .end(function (err, res) {
                if (err) return reject(err);
                resolve({ type: 'entry', status: res.status });
              });
          })
        );

        promises.push(
          new Promise(function (resolve, reject) {
            var idx = i;
            request(self.app)
              .post('/api/devicestatus/')
              .set('api-secret', known)
              .send({
                device: 'cross-collection-device-' + idx,
                created_at: new Date(baseTime + idx * 60000).toISOString(),
                uploaderBattery: 90
              })
              .end(function (err, res) {
                if (err) return reject(err);
                resolve({ type: 'devicestatus', status: res.status });
              });
          })
        );
      }

      Promise.all(promises)
        .then(function (results) {
          results.length.should.equal(30);
          results.forEach(function (result) {
            result.status.should.equal(200);
          });
          done();
        })
        .catch(done);
    });
  });
});
