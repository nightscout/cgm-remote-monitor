'use strict';

/**
 * Regression tests for the WebSocket write path (dbAdd / dbUpdate /
 * dbUpdateUnset) NOT calling ctx.purifier.purifyObject before persisting
 * data, unlike every REST write path (lib/api/treatments, entries,
 * devicestatus, profile).
 *
 * A client holding only api:treatments:create/update/delete (or the
 * equivalent generic write scope) can use the Socket.IO 'dbAdd'/'dbUpdate'
 * event to store raw, unsanitized HTML/script in free-text fields (notes,
 * enteredBy, ...). Dashboard code later inserts these fields into the DOM
 * with jQuery's .html()/.append() (see lib/client/renderer.js,
 * lib/report_plugins/{treatments,daytoday}.js), so the stored payload
 * executes in the browser of anyone who views/hovers the record
 * (Stored XSS).
 */
var should = require('should');
var language = require('../lib/language')();
var testHelpers = require('./lib/test-helpers');
var waitForConditionWithWarning = testHelpers.waitForConditionWithWarning;

describe('WebSocket write path purification (Stored XSS regression)', function () {
  this.timeout(15000);
  var self = this;

  var http = require('http');
  var io = require('socket.io-client');

  before(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    self.env = require('../lib/server/env')();
    self.env.settings.authDefaultRoles = 'readable';
    self.env.settings.enable = ['careportal', 'api'];

    require('../lib/server/bootevent')(self.env, language).boot(function booted (ctx) {
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

  function connectAndAuthorize (callback) {
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

  function treatmentsCollection () {
    return self.ctx.store.collection(self.env.treatments_collection);
  }

  function foodCollection () {
    return self.ctx.food();
  }

  var XSS_PAYLOAD = '<img src=x onerror=alert(document.domain)>';

  describe('dbAdd', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('sanitizes malicious HTML in treatment notes the same way the REST API does', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        authResult.write_treatment.should.equal(true);

        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: {
            eventType: 'Note',
            created_at: now,
            notes: XSS_PAYLOAD,
            enteredBy: '<script>alert(1)</script>attacker'
          }
        }, function (result) {
          should.exist(result);
          result.should.be.instanceof(Array);
          result.length.should.be.greaterThanOrEqual(1);

          var stored = result[0];
          stored.notes.should.not.containEql('onerror');
          stored.enteredBy.should.not.containEql('<script>');
          stored.enteredBy.should.containEql('attacker');

          waitForConditionWithWarning({
            condition: function (cb) {
              treatmentsCollection().findOne({ created_at: now }).then(function (doc) { cb(null, doc); }).catch(cb);
            },
            assertion: function (doc) {
              should.exist(doc);
              doc.notes.should.not.containEql('onerror');
              doc.enteredBy.should.not.containEql('<script>');
            },
            done: done,
            operationName: 'verify persisted treatment notes/enteredBy are sanitized'
          });
        });
      });
    });

    it('sanitizes malicious HTML for the generic (food) collection just like REST', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        authResult.write.should.equal(true);

        socket.emit('dbAdd', {
          collection: 'food',
          data: {
            name: XSS_PAYLOAD,
            carbs: 5
          }
        }, function (result) {
          should.exist(result);
          result[0].name.should.not.containEql('onerror');
          done();
        });
      });
    });
  });

  describe('dbUpdate', function () {

    beforeEach(function (done) {
      self.ctx.treatments.remove({ find: { created_at: { '$gte': '1999-01-01T00:00:00.000Z' } } }, function () {
        done();
      });
    });

    it('sanitizes malicious HTML written through an update', function (done) {
      connectAndAuthorize(function (err, socket, authResult) {
        if (err) return done(err);

        var now = new Date().toISOString();
        socket.emit('dbAdd', {
          collection: 'treatments',
          data: { eventType: 'Note', created_at: now, notes: 'clean' }
        }, function (addResult) {
          should.exist(addResult);
          var id = addResult[0]._id;

          socket.emit('dbUpdate', {
            collection: 'treatments',
            _id: id,
            data: { notes: XSS_PAYLOAD }
          }, function (updateResult) {
            updateResult.result.should.equal('success');

            waitForConditionWithWarning({
              condition: function (cb) {
                treatmentsCollection().findOne({ created_at: now }).then(function (doc) { cb(null, doc); }).catch(cb);
              },
              assertion: function (doc) {
                should.exist(doc);
                doc.notes.should.not.containEql('onerror');
              },
              done: done,
              operationName: 'verify dbUpdate sanitizes notes'
            });
          });
        });
      });
    });
  });
});
