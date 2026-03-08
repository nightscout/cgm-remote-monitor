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
        }, function (insertErr) {
          if (insertErr) return done(insertErr);

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
                treatmentsCollection().findOne({ _id: legacyId }, cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.notes.should.equal('legacy updated');
              },
              done: done,
              operationName: 'verify websocket dbUpdate with custom string _id'
            });
          });
        });
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
        }, function (insertErr) {
          if (insertErr) return done(insertErr);

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
                treatmentsCollection().findOne({ _id: legacyId }, cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                should.not.exist(doc.notes);
              },
              done: done,
              operationName: 'verify websocket dbUpdateUnset with custom string _id'
            });
          });
        });
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
        }, function (insertErr) {
          if (insertErr) return done(insertErr);

          socket.emit('dbRemove', {
            collection: 'treatments',
            _id: legacyId
          }, function (removeResult) {
            should.exist(removeResult);
            removeResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ _id: legacyId }, cb);
              },
              assertion: function (doc) {
                should.not.exist(doc);
              },
              done: done,
              operationName: 'verify websocket dbRemove with custom string _id'
            });
          });
        });
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
        }, function (insertErr) {
          if (insertErr) return done(insertErr);

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
                treatmentsCollection().findOne({ _id: legacyId }, cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.created_at.should.equal(dedupedCreatedAt);
              },
              done: done,
              operationName: 'verify websocket dbAdd dedupe with custom string _id'
            });
          });
        });
      });
    });
  });
});

describe('WebSocket dbAdd Array Handling Investigation', function () {
  this.timeout(15000);
  var self = this;
  
  var http = require('http');
  var io = require('socket.io-client');

  beforeEach(function (done) {
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

  afterEach(function (done) {
    if (self.socket) {
      self.socket.disconnect();
    }
    if (self.server) {
      self.server.close(done);
    } else {
      done();
    }
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

  describe('Array input behavior with insertOne (MongoDB 5.x migration)', function () {
    
    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('verify insertOne behavior when array is passed - EXPECTED TO DEMONSTRATE ISSUE', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        var testArray = [
          { eventType: 'Note', created_at: new Date(now).toISOString(), notes: 'array item 1' },
          { eventType: 'Note', created_at: new Date(now + 1000).toISOString(), notes: 'array item 2' },
          { eventType: 'Note', created_at: new Date(now + 2000).toISOString(), notes: 'array item 3' }
        ];
        
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: testArray
        }, function (result) {
          console.log('Array input result type:', typeof result);
          console.log('Array input result:', JSON.stringify(result, null, 2));
          
          waitForConditionWithWarning({
            condition: function(cb) {
              self.ctx.treatments.list({}, cb);
            },
            assertion: function(list) {
              console.log('Total treatments in DB after array dbAdd:', list.length);
              console.log('Treatments:', JSON.stringify(list, null, 2));
              list.length.should.be.greaterThanOrEqual(1);
            },
            done: done,
            operationName: 'dbAdd array treatments verification',
            warningThreshold: 200,
            maxTimeout: 5000
          });
        });
      });
    });

    it('compare single dbAdd calls vs one array dbAdd call', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);
        
        var now = Date.now();
        var count = 0;
        var results = [];
        
        function addTreatment(index) {
          socket.emit('dbAdd', {
            collection: 'treatments',
            data: {
              eventType: 'Note',
              created_at: new Date(now + index * 1000).toISOString(),
              notes: 'individual item ' + index
            }
          }, function (result) {
            results.push(result);
            count++;
            if (count === 3) {
              waitForConditionWithWarning({
                condition: function(cb) {
                  self.ctx.treatments.list({}, cb);
                },
                assertion: function(list) {
                  console.log('Total treatments after 3 individual dbAdd calls:', list.length);
                  list.length.should.be.greaterThanOrEqual(3);
                },
                done: done,
                operationName: 'individual dbAdd calls verification',
                warningThreshold: 200,
                maxTimeout: 5000
              });
            }
          });
        }
        
        addTreatment(0);
        addTreatment(1);
        addTreatment(2);
      });
    });
  });
});
