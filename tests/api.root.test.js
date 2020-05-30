'use strict';

const request = require('supertest');
require('should');

describe('Root REST API', function() {
  const self = this
    , instance = require('./fixtures/api/instance')
    , semver = require('semver')
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


  it('GET /api/versions', async () => {
    let res = await request(self.app)
      .get('/api/versions')
      .expect(200);

    res.body.length.should.be.aboveOrEqual(3);
    res.body.forEach(obj => {
      const fields = Object.getOwnPropertyNames(obj);
      fields.sort().should.be.eql(['url', 'version']);

      semver.valid(obj.version).should.be.ok();
      obj.url.should.startWith('/api');
    });
  });

});

