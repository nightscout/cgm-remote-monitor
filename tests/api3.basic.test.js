'use strict';

const request = require('supertest');
require('should');

describe('Basic REST API3', function ( ) {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    ;

  this.timeout(15000);

  before(function (done) {
    instance.create({})

      .then(https => {
        self.instance = https;
        self.app = https.app;
        self.env = https.env;
        done();
      })
      .catch(err => {
        done(err);
      })
  });


  after(function after () {
    self.instance.server.close();
  });


  it('GET /swagger', function (done) {
    request(self.app)
      .get('/api/v3/swagger.yaml')
      .expect(200)
      .end(function (err, res)  {
        res.header['content-length'].should.be.above(0);
        done();
      });
  });


  it('GET /version', function (done) {
    request(self.app)
      .get('/api/v3/version')
      .expect(200)
      .end(function (err, res) {
        const apiConst = require('../lib/api3/const.json')
          , software = require('../package.json');

        res.body.version.should.equal(software.version);
        res.body.apiVersion.should.equal(apiConst.API3_VERSION);
        res.body.storage.srvDate.should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);

        res.body.storage.srvDateString.length.should.be.above(23);
        var srvDate = new Date(res.body.storage.srvDateString);
        srvDate.getTime().should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);
        srvDate.getTime().should.equal(res.body.storage.srvDate);

        done();
      });
  });

});

