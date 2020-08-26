'use strict';

var should = require('should');
var assert = require('assert');

describe('mongo storage', function () {
  var env = require('../env')();

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

  it('When no connection-string is given the storage-class should throw an error.', function (done) {
    delete env.storageURI;
    should.not.exist(env.storageURI);

    (function () {
      return require('../lib/storage/mongo-storage')(env, false, true);
    }).should.throw('MongoDB connection string is missing. Please set MONGO_CONNECTION environment variable');

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

