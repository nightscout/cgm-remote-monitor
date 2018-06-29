'use strict';

var request = require('supertest');
var load = require('./fixtures/load');
var bootevent = require('../lib/server/bootevent');
var language = require('../lib/language')();
require('should');

describe('Entries REST api', function ( ) {
  var entries = require('../lib/api/entries/');

  this.timeout(10000);
  before(function (done) {
    var env = require('../env')( );
    env.settings.authDefaultRoles = 'readable';
    this.wares = require('../lib/middleware/')(env);
    this.archive = null;
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    bootevent(env, language).boot(function booted (ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx));
      self.archive = require('../lib/server/entries')(env, ctx);

      var creating = load('json');
      creating.push({type: 'sgv', sgv: 100, date: Date.now()});
      self.archive.create(creating, done);
    });
  });

  beforeEach(function (done) {
    var creating = load('json');
    creating.push({type: 'sgv', sgv: 100, date: Date.now()});
    this.archive.create(creating, done);
  });

  afterEach(function (done) {
    this.archive( ).remove({ }, done);
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

  it('/echo/ api shows query', function (done) {
    request(this.app)
      .get('/echo/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Object);
        res.body.query.should.be.instanceof(Object);
        res.body.input.should.be.instanceof(Object);
        res.body.input.find.should.be.instanceof(Object);
        res.body.storage.should.equal('entries');
        done( );
      });
  });

  it('/slice/ can slice time', function (done) {
    var app = this.app;
    request(app)
      .get('/slice/entries/dateString/sgv/2014-07.json?count=20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(20);
        done( );
      });
  });


  it('/times/echo can describe query', function (done) {
    var app = this.app;
    request(app)
      .get('/times/echo/2014-07/.*T{00..05}:.json?count=20&find[sgv][$gte]=160')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Object);
        res.body.req.should.have.property('query');
        res.body.should.have.property('pattern').with.lengthOf(6);
        done( );
      });
  });

  it('/slice/ can slice with multiple prefix', function (done) {
    var app = this.app;
    request(app)
      .get('/slice/entries/dateString/sgv/2014-07-{17..20}.json?count=20')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(20);
        done( );
      });
  });

  it('/slice/ can slice time with prefix and no results', function (done) {
    var app = this.app;
    request(app)
      .get('/slice/entries/dateString/sgv/1999-07.json?count=20&find[sgv][$lte]=401')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(0);
        done( );
      });
  });

  it('/times/ can get modal times', function (done) {
    var app = this.app;
    request(app)
      .get('/times/2014-07-/{0..30}T.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });

  it('/times/ can get modal minutes and times', function (done) {
    var app = this.app;
    request(app)
      .get('/times/20{14..15}-07/T{09..10}.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });
  it('/times/ can get multiple prefixen and modal minutes and times', function (done) {
    var app = this.app;
    request(app)
      .get('/times/20{14..15}/T.*:{00..60}.json?')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
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

  it('/entries/:id', function (done) {
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

  it('/entries/:model', function (done) {
    var app = this.app;
    request(app)
      .get('/entries/sgv/.json?count=10&find[dateString][$gte]=2014')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        done( );
      });
  });

  it('disallow POST by readable /entries/preview', function (done) {
    request(this.app)
      .post('/entries/preview.json')
      .send(load('json'))
      .expect(401)
      .end(function (err, res) {
        // res.body.should.be.instanceof(Array).and.have.lengthOf(30);
        done();
      });
  });

  it('disallow deletes unauthorized', function (done) {
    var app = this.app;

    request(app)
      .delete('/entries/sgv?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
      .expect(401)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          request(app)
            .get('/entries/sgv.json?find[dateString][$gte]=2014-07-19&find[dateString][$lte]=2014-07-20')
            .expect(200)
            .end(function (err, res) {
              res.body.should.be.instanceof(Array).and.have.lengthOf(10);
              done();
            });
        }
      });
  });

});
