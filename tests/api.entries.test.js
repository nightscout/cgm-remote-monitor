'use strict';

var request = require('supertest');
var load = require('./fixtures/load');
require('should');

describe('Entries REST api', function ( ) {
  var entries = require('../lib/api/entries/');

  before(function (done) {
    var env = require('../env')( );
    this.wares = require('../lib/middleware/')(env);
    this.archive = null;
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    require('../lib/bootevent')(env).boot(function booted (ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx));
      self.archive = require('../lib/entries')(env, ctx);

      var creating = load('json');
      creating.push({type: 'sgv', sgv: 100, date: Date.now()});
      self.archive.create(creating, done);
    });
  });

  after(function (done) {
    this.archive( ).remove({ }, done);
  });

  // keep this test pinned at or near the top in order to validate all
  // entries successfully uploaded. if res.body.length is short of the
  // expected value, it may indicate a regression in the create
  // function callback logic in entries.js.
  it('gets requested number of entries', function (done) {
    var count = 30;
    request(this.app)
      .get('/entries.json?find[dateString][$gte]=2014-07-19&count=' + count)
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(count);
        done();
      });
  });

  it('gets default number of entries', function (done) {
    var defaultCount = 10;
    request(this.app)
      .get('/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(defaultCount);
        done( );
      });
  });

  it('/entries/current.json', function (done) {
    request(this.app)
      .get('/entries/current.json')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(1);
        res.body[0].sgv.should.equal(100);
        done();
      });
  });

  it('/entries/sgv/ID', function (done) {
    var app = this.app;
    this.archive.list({count: 1}, function(err, records) {
      var currentId = records.pop()._id.toString();
      request(app)
        .get('/entries/'+currentId+'.json')
        .expect(200)
        .end(function (err, res) {
          res.body.should.be.instanceof(Array).and.have.lengthOf(1);
          res.body[0]._id.should.equal(currentId);
          done( );
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
});
