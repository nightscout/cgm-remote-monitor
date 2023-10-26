'use strict';

var should = require('should');

describe('openaps storage', function () {

  var env = require('../lib/server/env')();


  before(function (done) {
    delete env.api_secret;
    env.storageURI = 'openaps://../../tests/fixtures/openaps-storage/config';
    done();
  });

  it('The module class should be OK.', function (done) {
    require('../lib/storage/openaps-storage')(env, function callback (err, storage) {
      should.not.exist(err);
      should.exist(storage.collection);
      should.exist(storage.ensureIndexes);
      done();
    });
  });

  it('find sgv entries', function (done) {
    require('../lib/storage/openaps-storage')(env, function callback (err, storage) {
      should.not.exist(err);
      should.exist(storage.collection);

      storage.collection('entries').find({type: 'sgv'}).toArray(function callback (err, results) {
        should.not.exist(err);
        should.exist(results);

        results.length.should.equal(4);
        results[0].sgv.should.equal(102);

        done();
      });
    });
  });

  it('find cal entries', function (done) {
    require('../lib/storage/openaps-storage')(env, function callback (err, storage) {
      should.not.exist(err);
      should.exist(storage.collection);

      storage.collection('entries').find({type: 'cal'}).toArray(function callback (err, results) {
        should.not.exist(err);
        should.exist(results);

        results.length.should.equal(1);
        results[0].slope.should.equal(841.6474113376482);

        done();
      });
    });
  });

  it('find devicestatus entries', function (done) {
    require('../lib/storage/openaps-storage')(env, function callback (err, storage) {
      should.not.exist(err);
      should.exist(storage.collection);

      storage.collection('devicestatus').find({}).toArray(function callback (err, results) {
        should.not.exist(err);
        should.exist(results);

        results.length.should.equal(1);
        results[0].openaps.enacted.eventualBG.should.equal(82);

        done();
      });
    });
  });

  it('find treatments', function (done) {
    require('../lib/storage/openaps-storage')(env, function callback (err, storage) {
      should.not.exist(err);
      should.exist(storage.collection);

      storage.collection('treatments').find({}).toArray(function callback (err, results) {
        should.not.exist(err);
        should.exist(results);

        results.length.should.equal(2);
        results[0].eventType.should.equal('Temp Basal');

        done();
      });
    });
  });

  it('When no connection-string is given the storage-class should throw an error.', function (done) {
    delete env.storageURI;
    should.not.exist(env.storageURI);

    (function () {
      return require('../lib/storage/openaps-storage')(env);
    }).should.throw('openaps config uri is missing or invalid');

    done();
  });

  it('An invalid connection-string should throw an error.', function (done) {
    env.storageURI = 'This is not an openaps config path';

    (function () {
      return require('../lib/storage/openaps-storage')(env);
    }).should.throw(Error);

    done();
  });

});

