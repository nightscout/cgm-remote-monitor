
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
  it('/entries.json', function (done) {
    request(this.app)
      .get('/entries.json')
      .expect(200)
      .end(function (err, res)  {
        // console.log('body', res.body);
        res.body.length.should.equal(10);
        done( );
      });
  });

  it('/entries.json', function (done) {
    request(this.app)
      .get('/entries.json?count=30')
      .expect(200)
      .end(function (err, res)  {
        // console.log('body', res.body);
        res.body.length.should.equal(30);
        done( );
      });
  });

  it('/entries/current.json', function (done) {
    request(this.app)
      .get('/entries/current.json')
      .expect(200)
      .end(function (err, res)  {
        res.body.length.should.equal(1);
        done( );
        // console.log('err', err, 'res', res);
      });

  });

  it('/entries/preview', function (done) {

      request(this.app)
        .post('/entries/preview.json')
        .send(load('json'))
        .expect(201)
        .end(function (err, res)  {
          // console.log(res.body);
          res.body.length.should.equal(30);
          done( );
          // console.log('err', err, 'res', res);
        })
    ;

  });

});

