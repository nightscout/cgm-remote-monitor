'use strict';

var should = require('should');
var assert = require('assert');

var productionSafety = require('./lib/production-safety');

describe('mongo storage', function () {
  var env = require('../lib/server/env')();

  before(function (done) {
    delete env.api_secret;
    done();
  });

  it('The module should be OK.', function (done) {
    should.exist(require('../lib/storage/mongo-storage'));
    done();
  });

  it('After initializing the storage class it should re-use the open connection', function (done) {
    var store = require('../lib/storage/mongo-storage');
    store(env, function (err1, db1) {
      should.not.exist(err1);

      store(env, function (err2, db2) {
        should.not.exist(err2);
        assert(db1.db, db2.db, 'Check if the handlers are the same.');

        done();
      });
    });
  });

  it('Uses the default database from the connection string via the public client API', function (done) {
    var store = require('../lib/storage/mongo-storage');
    store(env, function (err, db) {
      should.not.exist(err);
      should.exist(db.db);
      should.exist(db.client);

      db.client.db().databaseName.should.equal(db.db.databaseName);
      productionSafety.isTestDatabaseName(db.db.databaseName).should.be.true();
      done();
    });
  });

  it('ensureIndexes uses createIndex without the legacy background option', function (done) {
    var store = require('../lib/storage/mongo-storage');
    var calls = [];

    store(env, function (err, db) {
      should.not.exist(err);

      db.ensureIndexes({
        collectionName: 'entries',
        createIndex: function (field, options) {
          calls.push({ field: field, options: options });
          return Promise.resolve();
        }
      }, ['date']);

      calls.length.should.equal(1);
      calls[0].field.should.equal('date');
      should.not.exist(calls[0].options);

      done();
    });
  });

  it('ensureIndexes accepts compound index definitions', function (done) {
    var store = require('../lib/storage/mongo-storage');
    var calls = [];
    var profileLatestIndex = { startDate: -1, _id: -1 };

    store(env, function (err, db) {
      should.not.exist(err);

      db.ensureIndexes({
        collectionName: 'profile',
        createIndex: function (field, options) {
          calls.push({ field: field, options: options });
          return Promise.resolve();
        }
      }, [profileLatestIndex]);

      calls.length.should.equal(1);
      calls[0].field.should.eql(profileLatestIndex);
      should.not.exist(calls[0].options);

      done();
    });
  });

  it('ensureIndexes builds a collection\'s indexes in one request and resolves when they exist', function (done) {
    var store = require('../lib/storage/mongo-storage');
    var batches = [];
    var singles = [];
    var created = false;

    store(env, function (err, db) {
      should.not.exist(err);

      var result = db.ensureIndexes({
        collectionName: 'entries',
        createIndexes: function (specs) {
          batches.push(specs);
          return new Promise(function (resolve) {
            setTimeout(function () { created = true; resolve(); }, 20);
          });
        },
        createIndex: function (field) {
          singles.push(field);
          return Promise.resolve();
        }
      }, ['date', { type: 1, date: -1 }, 'date']);

      created.should.be.false();
      result.then(function () {
        created.should.be.true();
        batches.should.eql([[{ key: { date: 1 } }, { key: { type: 1, date: -1 } }]]);
        singles.should.eql([]);
        done();
      }, done);
    });
  });

  it('ensureIndexes retries one at a time when the combined request fails, and never rejects', function (done) {
    var store = require('../lib/storage/mongo-storage');
    var singles = [];

    store(env, function (err, db) {
      should.not.exist(err);

      db.ensureIndexes({
        collectionName: 'entries',
        createIndexes: function () {
          return Promise.reject(new Error('one definition conflicts'));
        },
        createIndex: function (field) {
          singles.push(field);
          return field === 'sgv' ? Promise.reject(new Error('conflict')) : Promise.resolve();
        }
      }, ['date', 'sgv', 'type']).then(function () {
        singles.should.eql(['date', 'sgv', 'type']);
        done();
      }, done);
    });
  });

  it('When no connection-string is given the storage-class should throw an error.', function (done) {
    delete env.storageURI;
    should.not.exist(env.storageURI);

    (function () {
      return require('../lib/storage/mongo-storage')(env, false, true);
    }).should.throw('MongoDB connection string is missing. Please set MONGODB_URI environment variable');

    done();
  });

  it('An invalid connection-string should throw an error.', function (done) {
    env.storageURI = 'This is not a MongoDB connection-string';

    (async function () {
      try {
        let foo = await require('../lib/storage/mongo-storage')(env, false, true);
        false.should.be.true();
      }
      catch (err) {
        console.log('We have failed, this is good!');
        done();
      }
    })();
    
  });

});
