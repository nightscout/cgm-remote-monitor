'use strict';

var EventEmitter = require('events');
var http = require('http');
var ioClient = require('socket.io-client');
var should = require('should');

var CANARY = 'loadretro-authorization-canary';

function retainedDeviceStatus () {
  return [{
    _id: 'devicestatus-1'
    , created_at: '2024-01-01T00:00:00.000Z'
    , device: 'openaps://' + CANARY
    , mills: Date.parse('2024-01-01T00:00:00.000Z')
    , openaps: { suggested: { bg: 120, eventualBG: 110, IOB: 1.2, COB: 18, reason: CANARY } }
    , pump: { battery: { percent: 73 }, reservoir: 142.3, status: { bolusing: false, suspended: false } }
    , uploader: { battery: 64, isCharging: false }
  }];
}

/* A server whose AUTH_DEFAULT_ROLES resolve to the given anonymous permissions.
 * `defaultShiros` stands in for what storage.rolesToShiros(defaultRoles) yields:
 * ['read'] models the documented `readable` default, [] models `denied`.
 */
function startServer (defaultShiros, callback) {
  var settings = {
    enable: []
    , isEnabled: function () { return false; }
  };

  var env = {
    activity_collection: 'activity'
    , devicestatus_collection: 'devicestatus'
    , entries_collection: 'entries'
    , food_collection: 'food'
    , profile_collection: 'profile'
    , treatments_collection: 'treatments'
    , enclave: { isApiKeySet: function () { return true; } }
    , name: 'test'
    , settings: settings
    , version: '0.0.0'
  };

  var ctx = {
    authorization: {
      checkMultiple: function (permission, shiros) {
        if (permission === 'api:*:read') return shiros.indexOf('read') !== -1;
        return shiros.indexOf('admin') !== -1;
      }
      , resolve: function (credentials, callback) {
        if (credentials.token === 'invalid') return callback('All validation failed', {});
        var shiros = defaultShiros.slice();
        if (credentials.token === 'reader') shiros.push('read');
        callback(null, { shiros: shiros });
      }
    }
    , bus: new EventEmitter()
    , ddata: {
      clone: function () { return { devicestatus: retainedDeviceStatus() }; }
      , processRawDataForRuntime: function (documents) { return documents; }
    }
    , purifier: require('../lib/server/purifier')()
    , store: { collection: function () { throw new Error('storage should not be reached'); } }
  };

  var server = http.createServer();
  require('../lib/server/websocket')(env, ctx, server);
  server.listen(0, function () {
    // Populate the retained window the loadRetro handler serves from.
    ctx.bus.emit('data-processed');
    callback(null, { server: server, ctx: ctx, port: server.address().port });
  });
}

function connect (instance) {
  return ioClient('http://localhost:' + instance.port, {
    reconnection: false
    , transports: ['websocket']
  });
}

/* Emit loadRetro and collect BOTH the acknowledgement and whether a
 * retroUpdate carrying the retained devicestatus actually arrived. The
 * acknowledgement alone is not the symptom - the symptom is device telemetry
 * reaching the socket - so the observation window stays open past the ack.
 */
function loadRetro (socket, callback) {
  var observed = { ack: null, retroUpdate: false, records: 0, canary: false };

  socket.on('retroUpdate', function onRetroUpdate (payload) {
    var devicestatus = (payload && payload.devicestatus) || [];
    observed.retroUpdate = true;
    observed.records = devicestatus.length;
    observed.canary = JSON.stringify(devicestatus).indexOf(CANARY) !== -1;
  });

  socket.emit('loadRetro', { loadedMills: 0 }, function onAck (reply) {
    observed.ack = reply;
  });

  setTimeout(function settle () { callback(observed); }, 400);
}

describe('WebSocket loadRetro authorization', function () {
  this.timeout(10000);

  var denied;
  var readable;
  var sockets = [];

  function track (socket) {
    sockets.push(socket);
    return socket;
  }

  before(function (done) {
    startServer([], function (err, instance) {
      if (err) return done(err);
      denied = instance;
      startServer(['read'], function (err2, instance2) {
        if (err2) return done(err2);
        readable = instance2;
        done();
      });
    });
  });

  afterEach(function () {
    sockets.forEach(function (socket) { socket.disconnect(); });
    sockets = [];
  });

  after(function (done) {
    var pending = 2;
    function closed () { if (--pending === 0) done(); }
    denied.server.close(closed);
    readable.server.close(closed);
  });

  it('refuses loadRetro from a socket that never authorized when reads are denied', function (done) {
    var socket = track(connect(denied));
    socket.on('connect', function onConnect () {
      loadRetro(socket, function observed (result) {
        // Assert the whole observation at once so an ablated fix reports the
        // symptom itself - devicestatus arriving at an unauthorized socket -
        // and not merely the first assertion that happened to trip.
        ({
          retroUpdate: result.retroUpdate
          , canary: result.canary
          , records: result.records
        }).should.eql({ retroUpdate: false, canary: false, records: 0 });
        should.exist(result.ack);
        result.ack.result.should.equal('Not permitted');
        done();
      });
    });
  });

  it('refuses loadRetro from a socket authorization already resolved as unable to read', function (done) {
    var socket = track(connect(denied));
    socket.on('connect', function onConnect () {
      socket.emit('authorize', { client: 'web' }, function onAuthorized (authorization) {
        authorization.read.should.equal(false);
        loadRetro(socket, function observed (result) {
          ({
            retroUpdate: result.retroUpdate
            , canary: result.canary
            , records: result.records
          }).should.eql({ retroUpdate: false, canary: false, records: 0 });
          result.ack.result.should.equal('Not permitted');
          done();
        });
      });
    });
  });

  it('serves loadRetro to an authorized reader when reads are denied by default', function (done) {
    var socket = track(connect(denied));
    socket.on('connect', function onConnect () {
      socket.emit('authorize', { client: 'web', token: 'reader' }, function onAuthorized (authorization) {
        authorization.read.should.equal(true);
        loadRetro(socket, function observed (result) {
          ({
            retroUpdate: result.retroUpdate
            , canary: result.canary
            , records: result.records
          }).should.eql({ retroUpdate: true, canary: true, records: 1 });
          result.ack.result.should.equal('success');
          done();
        });
      });
    });
  });

  it('keeps serving loadRetro to anonymous clients on the readable default', function (done) {
    var socket = track(connect(readable));
    socket.on('connect', function onConnect () {
      loadRetro(socket, function observed (result) {
        ({
          retroUpdate: result.retroUpdate
          , canary: result.canary
          , records: result.records
        }).should.eql({ retroUpdate: true, canary: true, records: 1 });
        result.ack.result.should.equal('success');
        done();
      });
    });
  });
});
