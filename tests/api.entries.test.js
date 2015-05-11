var request = require('supertest');
var should = require('should');
var load = require('./fixtures/load');

describe('Entries REST api', function ( ) {
  var entries = require('../lib/api/entries/');

  before(function (done) {
    var env = require('../env')( );
    this.wares = require('../lib/middleware/')(env);
    var store = require('../lib/storage')(env);
    this.archive = require('../lib/entries').storage(env.mongo_collection, store);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    store(function ( ) {
      self.app.use('/', entries(self.app, self.wares, self.archive));
      self.archive.create(load('json'), done);
    });
  });

  after(function (done) {
    this.archive( ).remove({ }, done);
  });

  it('should be a module', function ( ) {
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
        // console.log('body', res.body);
        res.body.length.should.equal(count);
        done( );
      });
  });

  it('gets default number of entries', function (done) {
    var defaultCount = 10;
    request(this.app)
      .get('/entries.json')
      .expect(200)
      .end(function (err, res) {
        // console.log('body', res.body);
        res.body.length.should.equal(defaultCount);
        done( );
      });
  });

  it('/entries/current.json', function (done) {
    request(this.app)
      .get('/entries/current.json')
      .expect(200)
      .end(function (err, res) {
        res.body.length.should.equal(1);
        done( );
        // console.log('err', err, 'res', res);
      });
  });

  it('/entries/ID', function (done) {
    var app = this.app;
    this.archive.list({count: 1}, function(err, records) {
      var currentId = records.pop()._id.toString();
      request(app)
        .get('/entries/'+currentId+'.json')
        .expect(200)
        .end(function (err, res) {
          res.body.length.should.equal(1);
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
        // console.log(res.body);
        res.body.length.should.equal(30);
        done( );
        // console.log('err', err, 'res', res);
      });
  });
});
