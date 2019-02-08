'use strict';

var request = require('supertest');
var load = require('./fixtures/load');
var should = require('should');
var language = require('../lib/language')();

describe('authed REST api', function ( ) {
  var entries = require('../lib/api/entries/');

  before(function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.settings.authDefaultRoles = 'readable';
    this.wares = require('../lib/middleware/')(env);
    this.archive = null;
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    self.known_key = known;
    require('../lib/bootevent')(env, language).boot(function booted (ctx) {
      self.app.use('/', entries(self.app, self.wares, ctx));
      self.archive = require('../lib/entries')(env, ctx);

      var creating = load('json');
      // creating.push({type: 'sgv', sgv: 100, date: Date.now()});
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

  it('disallow unauthorized POST', function (done) {
    var app = this.app;

    var new_entry = {type: 'sgv', sgv: 100, date: Date.now() };
    new_entry.dateString = new Date(new_entry.date).toISOString( );
    request(app)
      .post('/entries.json?')
      .send([new_entry])
      .expect(401)
      .end(function (err, res) {
        res.body.status.should.equal(401);
        res.body.message.should.equal('Unauthorized');
        should.exist(res.body.description);
        done(err);
      });
  });

  it('/entries/preview', function (done) {
    var known_key = this.known_key;
    request(this.app)
      .post('/entries/preview.json')
      .set('api-secret', known_key)
      .send(load('json'))
      .expect(201)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(30);
        done();
      });
  });

  it('allow authorized POST', function (done) {
    var app = this.app;
    var known_key = this.known_key;

    var new_entry = {type: 'sgv', sgv: 100, date: Date.now() };
    new_entry.dateString = new Date(new_entry.date).toISOString( );
    request(app)
      .post('/entries.json?')
      .set('api-secret', known_key)
      .send([new_entry])
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(1);
        request(app)
          .get('/slice/entries/dateString/sgv/' + new_entry.dateString.split('T')[0] + '.json')
          .expect(200)
          .end(function (err, res) {
            res.body.should.be.instanceof(Array).and.have.lengthOf(1);
            
            if (err) {
              done(err);
            } else {
              request(app)
                .delete('/entries/sgv?find[dateString]=' + new_entry.dateString)
                .set('api-secret', known_key)
                .expect(200)
                .end(function (err) {
                  done(err);
                });
              }
          });
      });
  });

  it('disallow deletes unauthorized', function (done) {
    var app = this.app;

    request(app)
      .get('/entries.json?find[dateString][$gte]=2014-07-18')
      .expect(200)
      .end(function (err, res) {
        res.body.should.be.instanceof(Array).and.have.lengthOf(10);
        request(app)
          .delete('/entries/sgv?find[dateString][$gte]=2014-07-18&find[dateString][$lte]=2014-07-20')
          // .set('api-secret', 'missing')
          .expect(401)
          .end(function (err) {
            if (err) {
              done(err);
            } else {
              request(app)
                .get('/entries/sgv.json?find[dateString][$gte]=2014-07-18&find[dateString][$lte]=2014-07-20')
                .expect(200)
                .end(function (err, res) {
                  res.body.should.be.instanceof(Array).and.have.lengthOf(10);
                  done();
                });
            }
          });
      });
  });

  it('allow deletes when authorized', function (done) {
    var app = this.app;

    request(app)
      .delete('/entries/sgv?find[dateString][$gte]=2014-07-18&find[dateString][$lte]=2014-07-20')
      .set('api-secret', this.known_key)
      .expect(200)
      .end(function (err) {
        if (err) {
          done(err);
        } else {
          request(app)
            .get('/entries/sgv.json?find[dateString][$gte]=2014-07-18&find[dateString][$lte]=2014-07-20')
            .expect(200)
            .end(function (err, res) {
              res.body.should.be.instanceof(Array).and.have.lengthOf(0);
              done();
            });
        }
      });
  });



});
