'use strict';

var should = require('should');

describe('mongo storage retry lifecycle', function () {
  var originalSetTimeout = global.setTimeout;
  var currentMongoModule = null;
  var currentMongoClient = null;

  function setMongoClient(fakeMongoClient) {
    delete require.cache[require.resolve('mongodb')];
    currentMongoModule = require('mongodb');
    currentMongoClient = currentMongoModule.MongoClient;

    Object.defineProperty(currentMongoModule, 'MongoClient', {
      configurable: true,
      enumerable: true,
      value: fakeMongoClient,
      writable: true
    });
  }

  function restoreMongoClient() {
    if (!currentMongoModule || !currentMongoClient) {
      return;
    }

    Object.defineProperty(currentMongoModule, 'MongoClient', {
      configurable: true,
      enumerable: true,
      value: currentMongoClient,
      writable: true
    });

    currentMongoModule = null;
    currentMongoClient = null;
  }

  function interceptRetryDelay(retryDelays) {
    global.setTimeout = function (fn, ms) {
      if (ms === 3000) {
        retryDelays.push(ms);
        Promise.resolve().then(fn);
        return 1;
      }

      return originalSetTimeout.apply(global, arguments);
    };
  }

  afterEach(function () {
    restoreMongoClient();
    global.setTimeout = originalSetTimeout;
    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    delete require.cache[require.resolve('mongodb')];
  });

  it('closes failed retry clients and calls back only after a successful retry', function (done) {
    var createdClients = [];
    var connectAttempts = 0;
    var retryDelays = [];

    function FakeMongoClient() {
      this.closed = 0;
      createdClients.push(this);
    }

    FakeMongoClient.prototype.on = function () {};
    FakeMongoClient.prototype.connect = function () {
      connectAttempts += 1;

      if (connectAttempts === 1) {
        var err = new Error('server selection failed');
        err.name = 'MongoServerSelectionError';
        return Promise.reject(err);
      }

      return Promise.resolve();
    };
    FakeMongoClient.prototype.db = function () {
      return {
        databaseName: 'testdb',
        command: function () {
          return Promise.resolve({ authInfo: { authenticatedUserRoles: [] } });
        },
        collection: function (name) {
          return { collectionName: name };
        }
      };
    };
    FakeMongoClient.prototype.close = function () {
      this.closed += 1;
      return Promise.resolve();
    };

    setMongoClient(FakeMongoClient);
    interceptRetryDelay(retryDelays);

    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    var store = require('../lib/storage/mongo-storage');
    var callbackCount = 0;

    store({ storageURI: 'mongodb://example/testdb' }, function (err, db) {
      callbackCount += 1;

      should.not.exist(err);
      should.exist(db);
      callbackCount.should.equal(1);
      connectAttempts.should.equal(2);
      createdClients.length.should.equal(2);
      createdClients[0].closed.should.equal(1);
      createdClients[1].closed.should.equal(0);
      retryDelays.should.eql([3000]);
      db.db.databaseName.should.equal('testdb');

      done();
    }, true);
  });

  it('closes the client and reports authentication failure once', function (done) {
    var createdClients = [];
    var retryDelays = [];

    function FakeMongoClient() {
      this.closed = 0;
      createdClients.push(this);
    }

    FakeMongoClient.prototype.on = function () {};
    FakeMongoClient.prototype.connect = function () {
      return Promise.reject(new Error('AuthenticationFailed: bad auth'));
    };
    FakeMongoClient.prototype.close = function () {
      this.closed += 1;
      return Promise.resolve();
    };

    setMongoClient(FakeMongoClient);
    interceptRetryDelay(retryDelays);

    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    var store = require('../lib/storage/mongo-storage');
    var callbackCount = 0;

    store({ storageURI: 'mongodb://example/testdb' }, function (err, db) {
      callbackCount += 1;

      should.exist(err);
      should.not.exist(db);
      err.message.should.equal('MongoDB authentication failed! Double check the URL has the right username and password in MONGODB_URI.');
      callbackCount.should.equal(1);
      createdClients.length.should.equal(1);
      createdClients[0].closed.should.equal(1);
      retryDelays.should.eql([]);

      done();
    }, true);
  });

  // Driver 7 refuses servers older than MongoDB 4.4. It reports that as a
  // MongoServerSelectionError, the same class as an unreachable server, with a
  // MongoCompatibilityError on the server's description. Retrying cannot fix
  // it: before this was told apart, boot retried forever with no HTTP server
  // and no boot error page. The message states what the server and the driver
  // report, nothing more. The fakes below succeed on a second attempt, so a
  // retry shows up as a success instead of hanging the test.
  function selectionError(mongodb, serverError) {
    var address = '127.0.0.1:27017';
    var reason = { type: 'Unknown', servers: new Map([[address, { address: address, type: 'Unknown', error: serverError }]]) };
    return new mongodb.MongoServerSelectionError(serverError.message, reason);
  }

  function failOnceThenConnect(createdClients, makeError) {
    var attempts = 0;
    function FakeMongoClient() {
      this.closed = 0;
      createdClients.push(this);
    }
    FakeMongoClient.prototype.on = function () {};
    FakeMongoClient.prototype.connect = function () {
      attempts += 1;
      return attempts === 1 ? Promise.reject(makeError()) : Promise.resolve();
    };
    FakeMongoClient.prototype.db = function () {
      return {
        databaseName: 'testdb',
        command: function () {
          return Promise.resolve({ authInfo: { authenticatedUserRoles: [] } });
        },
        collection: function (name) {
          return { collectionName: name };
        }
      };
    };
    FakeMongoClient.prototype.close = function () {
      this.closed += 1;
      return Promise.resolve();
    };
    return FakeMongoClient;
  }

  it('reports a server the driver refuses as a boot error instead of retrying', function (done) {
    var createdClients = [];
    var retryDelays = [];
    setMongoClient(failOnceThenConnect(createdClients, function () {
      return selectionError(currentMongoModule, new currentMongoModule.MongoCompatibilityError(
        'Server at 127.0.0.1:27017 reports maximum wire version 8, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)'));
    }));
    interceptRetryDelay(retryDelays);

    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    var store = require('../lib/storage/mongo-storage');

    store({ storageURI: 'mongodb://example/testdb' }, function (err, db) {
      try {
        should.exist(err, 'an incompatible server must not be retried into a connection');
        should.not.exist(db);
        err.name.should.equal('MongoIncompatibleServerError');
        err.message.should.containEql('127.0.0.1:27017 reports wire version 8 (MongoDB 4.2)');
        err.message.should.containEql('requires at least 9 (MongoDB 4.4)');
        retryDelays.should.eql([]);
        createdClients.length.should.equal(1);
        createdClients[0].closed.should.equal(1);
        done();
      } catch (assertion) {
        done(assertion);
      }
    }, true);
  });

  it('control: still retries a server that cannot be reached', function (done) {
    var createdClients = [];
    var retryDelays = [];
    setMongoClient(failOnceThenConnect(createdClients, function () {
      return selectionError(currentMongoModule, new currentMongoModule.MongoNetworkError('connect ECONNREFUSED 127.0.0.1:27017'));
    }));
    interceptRetryDelay(retryDelays);

    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
    var store = require('../lib/storage/mongo-storage');

    store({ storageURI: 'mongodb://example/testdb' }, function (err, db) {
      try {
        should.not.exist(err);
        should.exist(db);
        retryDelays.should.eql([3000]);
        createdClients.length.should.equal(2);
        createdClients[0].closed.should.equal(1);
        done();
      } catch (assertion) {
        done(assertion);
      }
    }, true);
  });
});
