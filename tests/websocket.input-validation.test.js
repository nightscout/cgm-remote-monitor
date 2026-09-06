'use strict';

var EventEmitter = require('events');
var http = require('http');
var ioClient = require('socket.io-client');
var should = require('should');

function matchesValue (actual, condition) {
  if (condition && typeof condition === 'object') {
    if (Object.prototype.hasOwnProperty.call(condition, '$eq')) {
      return actual === condition.$eq;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$gte') && actual < condition.$gte) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(condition, '$lte') && actual > condition.$lte) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(condition, '$gte')
      || Object.prototype.hasOwnProperty.call(condition, '$lte');
  }
  return actual === condition;
}

function matchesQuery (document, query) {
  return Object.keys(query).every(function (field) {
    return matchesValue(document[field], query[field]);
  });
}

function fakeCollection () {
  var documents = [];
  var queries = [];
  var writes = [];
  var nextId = 1;

  function findIndex (query) {
    return documents.findIndex(function (document) {
      return matchesQuery(document, query);
    });
  }

  return {
    documents: documents,
    queries: queries,
    writes: writes,
    findOne: function (query) {
      queries.push(query);
      var index = findIndex(query);
      return Promise.resolve(index === -1 ? null : Object.assign({}, documents[index]));
    },
    insertOne: function (document) {
      var id = Object.prototype.hasOwnProperty.call(document, '_id') ? document._id : 'generated-' + nextId++;
      var stored = Object.assign({}, document, {_id: id});
      writes.push({operation: 'insertOne', document: stored});
      documents.push(stored);
      return Promise.resolve({insertedId: id});
    },
    updateOne: function (selector, update) {
      writes.push({operation: 'updateOne', selector: selector, update: update});
      var index = findIndex(selector);
      if (index !== -1 && update.$set) {
        Object.assign(documents[index], update.$set);
      }
      if (index !== -1 && update.$unset) {
        Object.keys(update.$unset).forEach(function (field) {
          delete documents[index][field];
        });
      }
      return Promise.resolve({matchedCount: index === -1 ? 0 : 1});
    },
    replaceOne: function (selector, replacement) {
      writes.push({operation: 'replaceOne', selector: selector, replacement: replacement});
      var index = findIndex(selector);
      if (index !== -1) documents[index] = Object.assign({}, replacement);
      return Promise.resolve({matchedCount: index === -1 ? 0 : 1});
    },
    deleteOne: function (selector) {
      writes.push({operation: 'deleteOne', selector: selector});
      var index = findIndex(selector);
      if (index !== -1) documents.splice(index, 1);
      return Promise.resolve({deletedCount: index === -1 ? 0 : 1});
    }
  };
}

describe('WebSocket database input validation', function () {
  this.timeout(10000);

  var ctx;
  var collections;
  var server;
  var socket;
  var storageAccesses;

  function resetStorage () {
    collections = {
      activity: fakeCollection(),
      devicestatus: fakeCollection(),
      entries: fakeCollection(),
      food: fakeCollection(),
      profile: fakeCollection(),
      treatments: fakeCollection()
    };
    storageAccesses = 0;
  }

  before(function (done) {
    var settings = {
      enable: [],
      isEnabled: function () { return false; }
    };
    var env = {
      activity_collection: 'activity',
      devicestatus_collection: 'devicestatus',
      entries_collection: 'entries',
      food_collection: 'food',
      profile_collection: 'profile',
      treatments_collection: 'treatments',
      enclave: {isApiKeySet: function () { return true; }},
      name: 'test',
      settings: settings,
      version: '0.0.0'
    };

    ctx = {
      authorization: {
        checkMultiple: function (permission, shiros) {
          return permission !== 'api:*:read' || shiros.indexOf('write-no-read') === -1;
        },
        resolve: function (credentials, callback) {
          callback(null, {shiros: credentials.token === 'write-no-read' ? ['write-no-read'] : []});
        }
      },
      bus: new EventEmitter(),
      ddata: {
        clone: function () { return {}; },
        processRawDataForRuntime: function (documents) { return documents; }
      },
      purifier: require('../lib/server/purifier')(),
      store: {
        collection: function (name) {
          storageAccesses += 1;
          if (!collections[name]) throw new Error('unknown fake collection: ' + name);
          return collections[name];
        }
      }
    };

    resetStorage();
    server = http.createServer();
    require('../lib/server/websocket')(env, ctx, server);
    server.listen(0, function () {
      socket = ioClient('http://localhost:' + server.address().port, {
        reconnection: false,
        transports: ['websocket']
      });
      socket.on('connect', done);
      socket.on('connect_error', done);
    });
  });

  beforeEach(function () {
    resetStorage();
  });

  after(function (done) {
    if (socket) socket.disconnect();
    if (server && server.listening) return server.close(done);
    done();
  });

  function expectReply (event, message, expected, done) {
    socket.emit(event, message, function (reply) {
      should.exist(reply);
      reply.result.should.equal(expected);
      done();
    });
  }

  function emitWithReply (event, message) {
    return new Promise(function (resolve) {
      socket.emit(event, message, resolve);
    });
  }

  function authorize (token) {
    return emitWithReply('authorize', token ? {token: token} : {});
  }

  it('rejects malformed envelopes before authorization without throwing', function (done) {
    var cases = [
      ['dbAdd', null, 'Invalid request'],
      ['dbUpdate', undefined, 'Invalid request'],
      ['dbUpdateUnset', 'not an object', 'Invalid request'],
      ['dbRemove', [], 'Invalid request'],
      ['dbAdd', {collection: '__proto__', data: {}}, 'Wrong collection']
    ];

    function next () {
      var testCase = cases.shift();
      if (!testCase) return done();
      expectReply(testCase[0], testCase[1], testCase[2], next);
    }

    next();
  });

  it('rejects malformed write shapes after authorization and remains responsive', function (done) {
    socket.emit('authorize', null, function (authorization) {
      authorization.write.should.equal(true);

      var cases = [
        ['dbAdd', {collection: 'treatments'}, 'Invalid data'],
        ['dbAdd', {collection: 'treatments', data: [null]}, 'Invalid data'],
        ['dbAdd', {collection: 'treatments', data: {eventType: {$ne: null}}}, 'Invalid data'],
        ['dbAdd', {collection: 'treatments', data: {NSCLIENT_ID: {$ne: null}}}, 'Invalid data'],
        ['dbAdd', {collection: 'devicestatus', data: {created_at: {$ne: null}}}, 'Invalid data'],
        ['dbAdd', {collection: 'profile', data: {startDate: {$ne: null}}}, 'Invalid data'],
        ['dbAdd', {collection: 'food', data: {_id: {$ne: null}}}, 'Invalid data'],
        ['dbUpdate', {collection: 'treatments', _id: {$ne: null}, data: {}}, 'Missing or invalid _id'],
        ['dbUpdate', {collection: 'treatments', _id: 'id', data: []}, 'Invalid data'],
        ['dbUpdateUnset', {collection: 'treatments', _id: 'id', data: null}, 'Invalid data'],
        ['dbRemove', {collection: 'treatments', _id: {$ne: null}}, 'Missing or invalid _id']
      ];

      function next () {
        var testCase = cases.shift();
        if (!testCase) {
          // A truthy non-function second argument used to be invoked as an
          // acknowledgement and terminate the process. Send one, then prove
          // the same connection still receives a normal acknowledgement.
          socket.emit('dbAdd', null, 'not a callback');
          return expectReply('dbAdd', null, 'Invalid request', done);
        }
        expectReply(testCase[0], testCase[1], testCase[2], next);
      }

      next();
    });
  });

  it('validates every batch item before opening a collection', async function () {
    await authorize();

    var reply = await emitWithReply('dbAdd', {
      collection: 'treatments',
      data: [
        {eventType: 'Note', created_at: '2026-01-01T00:00:00.000Z'},
        {eventType: {$ne: null}, created_at: '2026-01-01T00:00:01.000Z'}
      ]
    });

    reply.result.should.equal('Invalid data');
    storageAccesses.should.equal(0);
    collections.treatments.writes.length.should.equal(0);
  });

  it('rejects an invalid treatment timestamp before any earlier batch write', async function () {
    await authorize();

    var reply = await emitWithReply('dbAdd', {
      collection: 'treatments',
      data: [
        {eventType: 'Note', created_at: '2026-01-01T00:00:00.000Z'},
        {eventType: 'Note', created_at: 'not-a-date'}
      ]
    });

    reply.result.should.equal('Invalid data');
    storageAccesses.should.equal(0);
    collections.treatments.documents.length.should.equal(0);
    collections.treatments.writes.length.should.equal(0);
  });

  it('uses literal equality selectors on successful exact dedup paths', async function () {
    await authorize();

    collections.treatments.documents.push({
      _id: 'existing-treatment',
      NSCLIENT_ID: '$ne',
      serverOnly: 'visible to a reader'
    });
    collections.devicestatus.documents.push({
      _id: 'existing-status',
      created_at: '2026-01-01T00:00:00.000Z'
    });
    collections.profile.documents.push({
      _id: 'existing-profile',
      startDate: '2026-01-01T00:00:00.000Z',
      defaultProfile: 'old'
    });

    var treatmentReply = await emitWithReply('dbAdd', {
      collection: 'treatments',
      data: {NSCLIENT_ID: '$ne', eventType: 'Note', created_at: '2026-02-01T00:00:00.000Z'}
    });
    var statusReply = await emitWithReply('dbAdd', {
      collection: 'devicestatus',
      data: {device: 'uploader', created_at: '2026-01-01T00:00:00.000Z'}
    });
    var profileReply = await emitWithReply('dbAdd', {
      collection: 'profile',
      data: {defaultProfile: 'new', startDate: '2026-01-01T00:00:00.000Z'}
    });

    collections.treatments.queries[0].should.eql({NSCLIENT_ID: {$eq: '$ne'}});
    collections.devicestatus.queries[0].should.eql({
      created_at: {$eq: '2026-01-01T00:00:00.000Z'}
    });
    collections.profile.queries[0].should.eql({
      startDate: {$eq: '2026-01-01T00:00:00.000Z'}
    });
    treatmentReply[0].serverOnly.should.equal('visible to a reader');
    statusReply[0]._id.should.equal('existing-status');
    profileReply[0]._id.should.equal('existing-profile');
    collections.profile.documents[0].defaultProfile.should.equal('new');
  });

  it('limits a deduplication reply to submitted fields when read access is absent', async function () {
    var authorization = await authorize('write-no-read');
    authorization.read.should.equal(false);
    authorization.write_treatment.should.equal(true);

    collections.treatments.documents.push({
      _id: 'private-treatment',
      NSCLIENT_ID: 'known-client-id',
      notes: 'stored private note',
      enteredBy: 'private account'
    });

    var reply = await emitWithReply('dbAdd', {
      collection: 'treatments',
      data: {
        NSCLIENT_ID: 'known-client-id',
        eventType: 'Note',
        created_at: '2026-03-01T00:00:00.000Z',
        notes: 'submitted note'
      }
    });

    reply.length.should.equal(1);
    reply[0]._id.should.equal('private-treatment');
    reply[0].notes.should.equal('submitted note');
    should.not.exist(reply[0].enteredBy);
    collections.treatments.documents[0].notes.should.equal('stored private note');
  });

  it('literalizes similar-match fields and acknowledges only after its update', async function () {
    await authorize('write-no-read');

    var treatmentCollection = collections.treatments;
    treatmentCollection.documents.push({
      _id: 'similar-treatment',
      eventType: 'Meal Bolus',
      created_at: '2026-04-01T00:00:00.000Z',
      insulin: 1,
      storedOnly: 'do not return'
    });

    var originalUpdateOne = treatmentCollection.updateOne;
    var releaseUpdate;
    var markStarted;
    var updateStarted = new Promise(function (resolve) {
      markStarted = resolve;
    });
    treatmentCollection.updateOne = function (selector, update) {
      markStarted();
      return new Promise(function (resolve, reject) {
        releaseUpdate = function () {
          originalUpdateOne(selector, update).then(resolve, reject);
        };
      });
    };

    var replyCount = 0;
    var replyPromise = new Promise(function (resolve) {
      socket.emit('dbAdd', {
        collection: 'treatments',
        data: {
          eventType: 'Meal Bolus',
          created_at: '2026-04-01T00:00:01.000Z',
          insulin: 1
        }
      }, function (reply) {
        replyCount += 1;
        resolve(reply);
      });
    });

    await updateStarted;
    replyCount.should.equal(0);
    treatmentCollection.queries[0].should.eql({
      created_at: {$eq: '2026-04-01T00:00:01.000Z'},
      eventType: {$eq: 'Meal Bolus'}
    });
    treatmentCollection.queries[1].created_at.should.eql({
      $gte: '2026-03-31T23:59:59.000Z',
      $lte: '2026-04-01T00:00:03.000Z'
    });
    treatmentCollection.queries[1].insulin.should.eql({$eq: 1});
    releaseUpdate();

    var reply = await replyPromise;
    replyCount.should.equal(1);
    reply[0]._id.should.equal('similar-treatment');
    should.not.exist(reply[0].storedOnly);
    treatmentCollection.documents[0].created_at.should.equal('2026-04-01T00:00:01.000Z');
  });

  it('reports a committed update once even when notification processing throws', async function () {
    await authorize();

    var treatmentCollection = collections.treatments;
    treatmentCollection.documents.push({
      _id: 'update-with-bad-listener',
      eventType: 'Note',
      notes: 'before'
    });

    ctx.bus.once('data-update', function () {
      throw new Error('test notification failure');
    });

    var replyCount = 0;
    var reply = await new Promise(function (resolve) {
      socket.emit('dbUpdate', {
        collection: 'treatments',
        _id: 'update-with-bad-listener',
        data: {notes: 'after'}
      }, function (result) {
        replyCount += 1;
        resolve(result);
      });
    });

    await new Promise(function (resolve) { setImmediate(resolve); });
    reply.result.should.equal('success');
    replyCount.should.equal(1);
    treatmentCollection.documents[0].notes.should.equal('after');
  });

  it('reports a storage failure once without publishing a change', async function () {
    await authorize();

    var notificationCount = 0;
    function countNotification () {
      notificationCount += 1;
    }
    ctx.bus.on('data-update', countNotification);
    ctx.bus.on('data-received', countNotification);
    collections.treatments.updateOne = function () {
      return Promise.reject(new Error('test storage failure'));
    };

    var replyCount = 0;
    var reply;
    try {
      reply = await new Promise(function (resolve) {
        socket.emit('dbUpdate', {
          collection: 'treatments',
          _id: 'missing',
          data: {notes: 'not stored'}
        }, function (result) {
          replyCount += 1;
          resolve(result);
        });
      });
    } finally {
      ctx.bus.removeListener('data-update', countNotification);
      ctx.bus.removeListener('data-received', countNotification);
    }

    await new Promise(function (resolve) { setImmediate(resolve); });
    reply.result.should.equal('Unable to process update');
    replyCount.should.equal(1);
    notificationCount.should.equal(0);
  });
});
