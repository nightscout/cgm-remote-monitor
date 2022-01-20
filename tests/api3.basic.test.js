'use strict';

const request = require('supertest');
require('should');

describe('Basic REST API3', function() {
  const self = this
    , testConst = require('./fixtures/api3/const.json')
    , instance = require('./fixtures/api3/instance')
    ;

  this.timeout(15000);

  before(async () => {
    self.instance = await instance.create({});
    self.app = self.instance.app;
    self.env = self.instance.env;
  });


  after(function after () {
    self.instance.server.close();
  });


  it('GET /swagger', async () => {
    let res = await request(self.app)
      .get('/api/v3/swagger.yaml')
      .expect(200);

    res.header['content-length'].should.be.above(0);
  });


  it('GET /version', async () => {
    let res = await request(self.app)
      .get('/api/v3/version')
      .expect(200);

    const apiConst = require('../lib/api3/const.json')
      , software = require('../package.json');

    res.body.version.should.equal(software.version);
    res.body.apiVersion.should.equal(apiConst.API3_VERSION);
    res.body.srvDate.should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);
  });

});

