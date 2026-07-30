'use strict';

var should = require('should');
var mongodb = require('mongodb');

describe('mongo storage retry lifecycle', function () {
  var originalMongoClient = mongodb.MongoClient;
  var originalSetTimeout = global.setTimeout;

  function setMongoClient(fakeMongoClient) {
    Object.defineProperty(mongodb, 'MongoClient', {
      configurable: true,
      enumerable: true,
      value: fakeMongoClient,
      writable: true
    });
  }

  afterEach(function () {
    setMongoClient(originalMongoClient);
    global.setTimeout = originalSetTimeout;
    delete require.cache[require.resolve('../lib/storage/mongo-storage')];
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
    global.setTimeout = function (fn, ms) {
      retryDelays.push(ms);
      Promise.resolve().then(fn);
      return 1;
    };

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
    global.setTimeout = function (fn, ms) {
      retryDelays.push(ms);
      Promise.resolve().then(fn);
      return 1;
    };

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
});
