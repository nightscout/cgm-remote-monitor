var request = require('supertest');
var should = require('should');
var load = require('./fixtures/load');

describe('Entries MQTT API', function ( ) {
    var entries = require('../lib/api/entries/');

    before(function (done) {
        var env = require('../env')( );
        this.wares = require('../lib/middleware/')(env);
        this.archive = null;
        this.app = require('express')( );
        this.app.enable('api');
        var self = this;
        var bootevent = require('../lib/bootevent');
        bootevent(env).boot(function booted (ctx) {
            self.app.use('/', entries(self.app, self.wares, ctx));
            self.archive = require('../lib/entries')(env, ctx);

            var json = load('json');
            self.archive.create(json, done);

        });
    });

    after(function (done) {
        this.archive( ).remove({ }, done);
    });

    it('should be a module', function ( ) {
        entries.should.be.ok;
    });

});
