'use strict';

var should = require('should');
var language = require('../lib/language')();
var testHelpers = require('./lib/test-helpers');
var waitForConditionWithWarning = testHelpers.waitForConditionWithWarning;

describe('WebSocket Shape Handling - dbAdd Single vs Array Input', function () {
  this.timeout(15000);
  var self = this;
  
  var http = require('http');
  var io = require('socket.io-client');

  // Use before() instead of beforeEach() for app setup - boots once for all tests
  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];
    
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      
      var app = require('express')();
      app.enable('api');
      
      var server = http.createServer(app);
      
      require('../lib/server/websocket')(self.env, ctx, server);
      
      server.listen(0, function () {
        self.port = server.address().port;
        self.server = server;
        done();
      });
    });
  });

  after(function (done) {
    if (self.server) {
      self.server.close(done);
    } else {
      done();
    }
  });

  afterEach(function (done) {
    if (self.socket) {
      self.socket.disconnect();
      self.socket = null;
    }
    done();
  });

  function connectAndAuthorize(callback) {
    var socket = io('http://localhost:' + self.port, {
      transports: ['websocket'],
      reconnection: false
    });
    
    socket.on('connect', function () {
      socket.emit('authorize', {
        client: 'test',
        secret: 'b723e97aa97846eb92d5264f084b2823f57c4aa1'
      }, function (authResult) {
        self.socket = socket;
        callback(null, socket, authResult);
      });
    });
    
    socket.on('connect_error', function (err) {
      callback(err);
    });
  }

  function treatmentsCollection() {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function foodCollection() {
    return self.ctx.food();
  }

  describe('dbAdd with treatments collection', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbAdd accepts single object for treatments', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        authResult.read.should.equal(true);
        authResult.write_treatment.should.equal(true);
        
        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: {
            eventType: 'Note',
            created_at: now,
            notes: 'ws single object test'
          }
        }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          result.length.should.be.greaterThanOrEqual(1);
          result[0].notes.should.equal('ws single object test');
          done();
        });
      });
    });

    it('dbAdd with array input for treatments - current behavior test', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: [
            { eventType: 'Note', created_at: new Date(now).toISOString(), notes: 'ws array item 1' },
            { eventType: 'Note', created_at: new Date(now + 1000).toISOString(), notes: 'ws array item 2' }
          ]
        }, function (result) {
          console.log('dbAdd array result:', JSON.stringify(result));
          should.exist(result);
          done();
        });
      });
    });
  });

  describe('dbAdd with devicestatus collection', function () {
    
    beforeEach(function (done) {
      self.ctx.devicestatus.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbAdd accepts single object for devicestatus', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'devicestatus',
          data: {
            device: 'ws-test-device',
            created_at: now,
            uploaderBattery: 99
          }
        }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          result.length.should.equal(1);
          result[0].uploaderBattery.should.equal(99);
          done();
        });
      });
    });

    it('dbAdd with array input for devicestatus - current behavior test', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        socket.emit('dbAdd', {
          collection: 'devicestatus',
          data: [
            { device: 'ws-device-1', created_at: new Date(now).toISOString(), uploaderBattery: 80 },
            { device: 'ws-device-2', created_at: new Date(now + 1000).toISOString(), uploaderBattery: 75 }
          ]
        }, function (result) {
          console.log('dbAdd devicestatus array result:', JSON.stringify(result));
          should.exist(result);
          done();
        });
      });
    });
  });

  describe('dbAdd with entries collection', function () {
    
    it('dbAdd accepts single object for entries', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        socket.emit('dbAdd', {
          collection: 'entries',
          data: {
            type: 'sgv',
            sgv: 120,
            date: now,
            dateString: new Date(now).toISOString()
          }
        }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          done();
        });
      });
    });

    it('dbAdd with array input for entries - current behavior test', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        socket.emit('dbAdd', {
          collection: 'entries',
          data: [
            { type: 'sgv', sgv: 115, date: now, dateString: new Date(now).toISOString() },
            { type: 'sgv', sgv: 120, date: now + 300000, dateString: new Date(now + 300000).toISOString() }
          ]
        }, function (result) {
          console.log('dbAdd entries array result:', JSON.stringify(result));
          should.exist(result);
          done();
        });
      });
    });
  });

  describe('dbUpdate operations', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbUpdate modifies single treatment', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: {
            eventType: 'Note',
            created_at: now,
            notes: 'original note'
          }
        }, function (addResult) {
          should.exist(addResult);
          addResult.length.should.be.greaterThanOrEqual(1);
          
          var treatmentId = addResult[0]._id;
          
          socket.emit('dbUpdate', {
            collection: 'treatments',
            _id: treatmentId,
            data: {
              notes: 'updated note'
            }
          }, function (updateResult) {
            should.exist(updateResult);
            updateResult.result.should.equal('success');
            done();
          });
        });
      });
    });

    it('dbUpdate supports custom string _id values', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var legacyId = 'legacy-string-id-update';
        var createdAt = new Date().toISOString();

        treatmentsCollection().insertOne({
          _id: legacyId,
          eventType: 'Note',
          created_at: createdAt,
          notes: 'legacy original'
        }).then(function () {

          socket.emit('dbUpdate', {
            collection: 'treatments',
            _id: legacyId,
            data: {
              notes: 'legacy updated'
            }
          }, function (updateResult) {
            should.exist(updateResult);
            updateResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.notes.should.equal('legacy updated');
              },
              done: done,
              operationName: 'verify websocket dbUpdate with custom string _id'
            });
          });
        }).catch(done);
      });
    });
  });

  describe('dbUpdateUnset operations', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbUpdateUnset supports custom string _id values', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var legacyId = 'legacy-string-id-unset';
        var createdAt = new Date().toISOString();

        treatmentsCollection().insertOne({
          _id: legacyId,
          eventType: 'Note',
          created_at: createdAt,
          notes: 'remove me'
        }).then(function () {

          socket.emit('dbUpdateUnset', {
            collection: 'treatments',
            _id: legacyId,
            data: {
              notes: 1
            }
          }, function (updateResult) {
            should.exist(updateResult);
            updateResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                should.not.exist(doc.notes);
              },
              done: done,
              operationName: 'verify websocket dbUpdateUnset with custom string _id'
            });
          });
        }).catch(done);
      });
    });
  });

  describe('dbRemove operations', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbRemove deletes single treatment', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: {
            eventType: 'Note',
            created_at: now,
            notes: 'to be deleted'
          }
        }, function (addResult) {
          should.exist(addResult);
          addResult.length.should.be.greaterThanOrEqual(1);
          
          var treatmentId = addResult[0]._id;
          
          socket.emit('dbRemove', {
            collection: 'treatments',
            _id: treatmentId
          }, function (removeResult) {
            should.exist(removeResult);
            removeResult.result.should.equal('success');
            done();
          });
        });
      });
    });

    it('dbRemove supports custom string _id values', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var legacyId = 'legacy-string-id-remove';
        var createdAt = new Date().toISOString();

        treatmentsCollection().insertOne({
          _id: legacyId,
          eventType: 'Note',
          created_at: createdAt,
          notes: 'delete me'
        }).then(function () {

          socket.emit('dbRemove', {
            collection: 'treatments',
            _id: legacyId
          }, function (removeResult) {
            should.exist(removeResult);
            removeResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.not.exist(doc);
              },
              done: done,
              operationName: 'verify websocket dbRemove with custom string _id'
            });
          });
        }).catch(done);
      });
    });
  });

  describe('dbAdd dedupe operations', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('dbAdd dedupe updates custom string _id records without ObjectId conversion', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var legacyId = 'legacy-string-id-dedupe';
        var originalCreatedAt = new Date().toISOString();
        var dedupedCreatedAt = new Date(Date.now() + 1000).toISOString();

        treatmentsCollection().insertOne({
          _id: legacyId,
          eventType: 'Note',
          created_at: originalCreatedAt,
          notes: 'existing legacy note'
        }).then(function () {

          socket.emit('dbAdd', {
            collection: 'treatments',
            data: {
              eventType: 'Note',
              created_at: dedupedCreatedAt,
              notes: 'incoming legacy note'
            }
          }, function (result) {
            should.exist(result);
            result.should.be.instanceof(Array);
            result.length.should.equal(1);
            result[0]._id.should.equal(legacyId);

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.created_at.should.equal(dedupedCreatedAt);
              },
              done: done,
              operationName: 'verify websocket dbAdd dedupe with custom string _id'
            });
          });
        }).catch(done);
      });
    });
  });

  describe('dbAdd profile collection (AAPS V1 sync)', function () {

    function profileCollection() {
      return self.ctx.store.collection(self.env.profile_collection);
    }

    beforeEach(async function () {
      await profileCollection().deleteMany({ defaultProfile: 'aaps-test' });
    });

    function aapsProfile(startDateMs, overrides) {
      var iso = new Date(startDateMs).toISOString();
      return Object.assign({
        defaultProfile: 'aaps-test',
        date: startDateMs,
        created_at: iso,
        startDate: iso,
        units: 'mg/dl',
        store: {
          'aaps-test': {
            dia: 5,
            carbratio: [{ time: '00:00', value: 10 }],
            sens: [{ time: '00:00', value: 50 }],
            basal: [{ time: '00:00', value: 0.5 }],
            target_low: [{ time: '00:00', value: 100 }],
            target_high: [{ time: '00:00', value: 120 }],
            timezone: 'UTC'
          }
        }
      }, overrides || {});
    }

    it('first AAPS-shaped profile dbAdd inserts a new document', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var profile = aapsProfile(Date.now());
        socket.emit('dbAdd', { collection: 'profile', data: profile }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          result.length.should.equal(1);
          should.exist(result[0]._id);

          waitForConditionWithWarning({
            condition: function (cb) {
              profileCollection().find({ defaultProfile: 'aaps-test' }).toArray()
                .then(function (docs) { cb(null, docs); }).catch(cb);
            },
            assertion: function (docs) {
              docs.length.should.equal(1);
              docs[0].startDate.should.equal(profile.startDate);
            },
            done: done,
            operationName: 'verify first AAPS profile insert'
          });
        });
      });
    });

    it('repeated AAPS profile dbAdd with same startDate REPLACES instead of duplicating', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var ts = Date.now();
        var first = aapsProfile(ts);
        // second send: same startDate (e.g. user re-saves quickly), edited carb ratio
        var second = aapsProfile(ts);
        second.store['aaps-test'].carbratio[0].value = 12;

        socket.emit('dbAdd', { collection: 'profile', data: first }, function (firstResult) {
          should.exist(firstResult);
          firstResult.length.should.equal(1);
          var firstId = firstResult[0]._id;

          socket.emit('dbAdd', { collection: 'profile', data: second }, function (secondResult) {
            should.exist(secondResult);
            secondResult.length.should.equal(1);
            // The dedup branch returns the EXISTING _id so AAPS sees a stable id
            String(secondResult[0]._id).should.equal(String(firstId));

            waitForConditionWithWarning({
              condition: function (cb) {
                profileCollection().find({ defaultProfile: 'aaps-test' }).toArray()
                  .then(function (docs) { cb(null, docs); }).catch(cb);
              },
              assertion: function (docs) {
                docs.length.should.equal(1);
                docs[0].store['aaps-test'].carbratio[0].value.should.equal(12);
              },
              done: done,
              operationName: 'verify AAPS profile dedup replaces in place'
            });
          });
        });
      });
    });

    it('AAPS profile dbAdd with different startDate inserts a new document and last() returns newest', function (done) {
      connectAndAuthorize(function (err, socket) {
        if (err) return done(err);

        var older = aapsProfile(Date.now() - 60000);
        older.store['aaps-test'].carbratio[0].value = 8;
        var newer = aapsProfile(Date.now());
        newer.store['aaps-test'].carbratio[0].value = 14;

        socket.emit('dbAdd', { collection: 'profile', data: older }, function (r1) {
          should.exist(r1);
          socket.emit('dbAdd', { collection: 'profile', data: newer }, function (r2) {
            should.exist(r2);

            waitForConditionWithWarning({
              condition: function (cb) {
                profileCollection().find({ defaultProfile: 'aaps-test' }).toArray()
                  .then(function (docs) { cb(null, docs); }).catch(cb);
              },
              assertion: function (docs) {
                docs.length.should.equal(2);
              },
              done: function (err) {
                if (err) return done(err);
                self.ctx.profile.last(function (lastErr, lastDocs) {
                  if (lastErr) return done(lastErr);
                  lastDocs.length.should.equal(1);
                  lastDocs[0].store['aaps-test'].carbratio[0].value.should.equal(14);
                  done();
                });
              },
              operationName: 'verify AAPS profile distinct startDate inserts and last() returns newest'
            });
          });
        });
      });
    });
  });

  describe('generic collection raw write watchpoints', function () {

    beforeEach(async function () {
      await foodCollection().deleteMany({});
    });

    it('dbAdd preserves custom string _id values for generic collections', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        authResult.write.should.equal(true);

        var legacyId = 'legacy-food-id-add';
        socket.emit('dbAdd', {
          collection: 'food',
          data: {
            _id: legacyId,
            name: 'ws food',
            carbs: 15
          }
        }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          result.length.should.equal(1);
          result[0]._id.should.equal(legacyId);

          waitForConditionWithWarning({
            condition: function (cb) {
              foodCollection().findOne({ _id: legacyId })
                .then(function (doc) { cb(null, doc); })
                .catch(cb);
            },
            assertion: function (doc) {
              should.exist(doc);
              doc.name.should.equal('ws food');
              doc.carbs.should.equal(15);
            },
            done: done,
            operationName: 'verify websocket dbAdd generic collection custom string _id'
          });
        });
      });
    });

    it('dbUpdate supports custom string _id values for generic collections', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        authResult.write.should.equal(true);

        var legacyId = 'legacy-food-id-update';
        foodCollection().insertOne({
          _id: legacyId,
          name: 'original food',
          carbs: 10,
          protein: 2
        }).then(function () {
          socket.emit('dbUpdate', {
            collection: 'food',
            _id: legacyId,
            data: {
              carbs: 18,
              protein: 4
            }
          }, function (updateResult) {
            should.exist(updateResult);
            updateResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                foodCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.carbs.should.equal(18);
                doc.protein.should.equal(4);
              },
              done: done,
              operationName: 'verify websocket dbUpdate generic collection custom string _id'
            });
          });
        }).catch(done);
      });
    });

    it('dbRemove supports custom string _id values for generic collections', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        authResult.write.should.equal(true);

        var legacyId = 'legacy-food-id-remove';
        foodCollection().insertOne({
          _id: legacyId,
          name: 'remove food',
          carbs: 9
        }).then(function () {
          socket.emit('dbRemove', {
            collection: 'food',
            _id: legacyId
          }, function (removeResult) {
            should.exist(removeResult);
            removeResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                foodCollection().findOne({ _id: legacyId })
                  .then(function (doc) { cb(null, doc); })
                  .catch(cb);
              },
              assertion: function (doc) {
                should.not.exist(doc);
              },
              done: done,
              operationName: 'verify websocket dbRemove generic collection custom string _id'
            });
          });
        }).catch(done);
      });
    });
  });
});
