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
    self.instance.ctx.bus.teardown();
  });


  it('GET /version', async () => {
    let res = await request(self.app)
      .get('/api/v3/version')
      .expect(200);

    const apiConst = require('../lib/api3/const.json')
      , software = require('../package.json')
      , result = res.body.result;

    res.body.status.should.equal(200);
    result.version.should.equal(software.version);
    result.apiVersion.should.equal(apiConst.API3_VERSION);
    result.srvDate.should.be.within(testConst.YEAR_2019, testConst.YEAR_2050);
  });

});

