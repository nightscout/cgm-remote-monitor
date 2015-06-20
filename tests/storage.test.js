'use strict';

var request = require('supertest');
var should = require('should');

// TODO: It would be better to have something like the dependency injection pattern for testing the datastore
describe('DATABASE_ABSTRACTION', function ( ) {
    var env = require('../env')( );

    it('Should able to connect to the database', function (done) {
        require('../lib/storage')(env, function ( err ) {
            should(err).be.exactly(null);
            done();
        });
    });

    it('Should throw an error when connecting to the database with an invalid connection string', function (done) {
        (function() {
            return require('../lib/storage')(env, function (err) {
            }, {
                connectionUrl: 'this is invalid'
            });
        }).should.throw('URL must be in the format mongodb://user:pass@host:port/dbname');

        done();
    });
});

