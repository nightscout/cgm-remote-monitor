'use strict';

var request = require('supertest');
var should = require('should');
var load = require('./fixtures/load');

describe('Entries REST api', function () {
    var env = require('../env')();
    var entries = require('../lib/api/entries/');

    before(function (done) {
        this.wares = require('../lib/middleware/')(env);
        this.app = require('express')();
        this.app.enable('api');
        var self = this;

        require('../lib/storage')(env, function (err, store) {

            if (err) {
                console.error('Failed to connect to MongoDB:', err);
                throw new Error(err);
            }

            env.store = store;

            self.entries = require('../lib/entries').storage(env.mongo_collection, store);

            self.app.use('/', entries(self.app, self.wares, self));
            self.entries.create(load('json'), function (err) {
                if (err) {
                    console.error('Failed to insert test-data:', err);
                    throw new Error(err);
                }
                done();
            });
        }, {
            connectionRetries: 0 // For the tests we expect the database to be available. The timeout for the test is 2000ms, so we should not wait.
        });
    });

    it('should be a module', function () {
        entries.should.be.ok;
    });

    // keep this test pinned at or near the top in order to validate all
    // entries successfully uploaded. if res.body.length is short of the
    // expected value, it may indicate a regression in the create
    // function callback logic in entries.js.
    it('gets requested number of entries', function (done) {
        var count = 30;
        request(this.app)
            .get('/entries.json?count=' + count)
            .expect(200)
            .end(function (err, res) {
                res.body.should.be.instanceof(Array).and.have.lengthOf(count);
                done();
            });
    });

    it('gets default number of entries', function (done) {
        var defaultCount = 10;
        request(this.app)
            .get('/entries.json')
            .expect(200)
            .end(function (err, res) {
                // console.log('body', res.body);
                res.body.should.be.instanceof(Array).and.have.lengthOf(defaultCount);
                done();
            });
    });

    it('/entries/current.json', function (done) {
        request(this.app)
            .get('/entries/current.json')
            .expect(200)
            .end(function (err, res) {
                res.body.should.be.instanceof(Array).and.have.lengthOf(1);
                done();
            });
    });

    it('/entries/sgv/ID', function (done) {
        var app = this.app;
        this.entries.list({count: 1}, function (err, records) {
            var currentId = records.pop()._id.toString();
            request(app)
                .get('/entries/' + currentId + '.json')
                .expect(200)
                .end(function (err, res) {
                    res.body.should.be.instanceof(Array).and.have.lengthOf(1);
                    res.body[0]._id.should.equal(currentId);
                    done();
                });
        });

    });

    it('/entries/preview', function (done) {
        request(this.app)
            .post('/entries/preview.json')
            .send(load('json'))
            .expect(201)
            .end(function (err, res) {
                res.body.should.be.instanceof(Array).and.have.lengthOf(30);
                done();
            });
    });

    it('/entries/remove', function (done) {

        require('../lib/storage')(env, function (err, store) {

            env.store = store;

            require('../lib/entries').storage(env.mongo_collection, store).remove({}, function(err, res) {

                should(err).be.exactly(null);
                should(res.result.ok).be.exactly(1);
                should(res.result.n).be.exactly(30);
                done();
            });
        }, {
            connectionRetries: 0 // For the tests we expect the database to be available. The timeout for the test is 2000ms, so we should not wait.
        });
    });

});
