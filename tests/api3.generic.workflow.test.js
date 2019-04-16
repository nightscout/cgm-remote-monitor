'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

describe('Generic REST API3', function ( ) {
  var self = this
    , bodyParser = require('body-parser')
    , api = require('../lib/api3/')
    , testConst = require('./fixtures/api3/const.json')
    , utils = require('./fixtures/api3/utils')
    , _ = require('lodash')

  this.timeout(30000);

  before(function (done) {
    var env = require('../env')( );
    env.settings.enable = ['careportal', 'rawbg'];
    env.settings.authDefaultRoles = 'readable';
    env.api_secret = 'this is my long pass phrase';
    self.wares = require('../lib/middleware/')(env);
    self.app = require('express')( );
    self.app.enable('api');

    self.identifier = utils.randomString("32", 'aA#'); // let's have a brand new identifier for your testing document

    self.urlCol = '/api/v3/' + env.treatments_collection;
    self.urlResource = self.urlCol + '/' + self.identifier;
    self.urlHistory = self.urlCol + '/history';

    self.historyTimestamp = 0;

    self.docOriginal = {
      identifier: self.identifier,
      eventType: 'Correction Bolus',
      insulin: 1
    };

    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      self.apiApp = api(env, ctx);
      self.apiApp.set('API3_SECURITY_ENABLE', false); // we don't want security in this test

      self.app.use('/api/v3', bodyParser({
        limit: 1048576 * 50
      }), self.apiApp);

      done();
    });
  });


  it('READ of not existing document is not found', function (done) {
    request(self.app)
      .get(self.urlResource)
      .expect(404)
      .end(done);
  });

  it('SEARCH of not existing document (not found)', function (done) {
    request(self.app)
      .get(self.urlCol)
      .query({ 'identifier_eq': self.identifier })
      .expect(200)
      .end(function (err, res) {
        res.body.should.have.length(0);
        done();
      });
  });

  it('DELETE of not existing document is not found', function (done) {
    request(self.app)
      .delete(self.urlResource)
      .expect(404)
      .end(done);
  });

  it('CREATE new document', function (done) {
    request(self.app)
      .post(self.urlCol)
      .send(self.docOriginal)
      .expect(201)
      .end(done);
  });

  it('READ existing document', function (done) {
    request(self.app)
      .get(self.urlResource)
      .expect(200)
      .end(function (err, res) {
        res.body.should.containEql(self.docOriginal);
        self.docActual = res.body;
        done();
      });
  });

  it('SEARCH existing document (found)', function (done) {
    request(self.app)
      .get(self.urlCol)
      .query({ 'identifier_eq': self.identifier })
      .expect(200)
      .end(function (err, res) {
        res.body.should.have.length(1);
        res.body.should.matchAny(function(value) { 
          value.identifier.should.be.eql(self.identifier)});
        done();
      });
  });

  it('new document in HISTORY', function (done) {
    request(self.app)
      .get(self.urlHistory + '/' + self.historyTimestamp)
      .expect(200)
      .end(function (err, res) {
        done();
      });
  });


  it('UPDATE document', function (done) {
    done();
  });

  it('document changed in HISTORY', function (done) {
    done();
  }); 
  
  it('document changed in READ', function (done) {
    done();
  });


  it('PATCH document', function (done) {
    done();
  });

  it('document changed in HISTORY', function (done) {
    done();
  }); 
  
  it('document changed in READ', function (done) {
    done();
  });


  it('soft DELETE', function (done) {
    done();
  });

  it('READ of deleted is gone', function (done) {
    done();
  });

  it('SEARCH of deleted document missing it', function (done) {
    done();
  }); 
  
  it('document deleted in HISTORY', function (done) {
    done();
  }); 
  
  it('permanent DELETE', function (done) {
    done();
  });

  it('READ of permanently deleted is not found', function (done) {
    done();
  });

});

