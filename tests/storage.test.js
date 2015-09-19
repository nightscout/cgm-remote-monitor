'use strict';

var should = require('should');
var assert = require('assert');

describe('STORAGE', function () {
  var env = require('../env')();

  before(function (done) {
    delete env.api_secret;
    done();
  });

  it('The storage class should be OK.', function (done) {
    should.exist(require('../lib/storage'));
    done();
  });

  it('After initializing the storage class it should re-use the open connection', function (done) {
    var store = require('../lib/storage');
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
    delete env.mongo;
    should.not.exist(env.mongo);

    (function () {
      return require('../lib/storage')(env, false, true);
    }).should.throw('MongoDB connection string is missing');

    done();
  });

  it('An invalid connection-string should throw an error.', function (done) {
    env.mongo = 'This is not a MongoDB connection-string';

    (function () {
      return require('../lib/storage')(env, false, true);
    }).should.throw('URL must be in the format mongodb://user:pass@host:port/dbname');

    done();
  });

});

