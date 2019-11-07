'use strict';

var request = require('supertest');
var language = require('../lib/language')();

require('should');

describe('Status REST api sanitization', function ( ) {
  var self = this;

  var api = require('../lib/api/');
  beforeEach(function (done) {
    process.env.API_SECRET = 'this is my long pass phrase';
    process.env.LOOP_APNS_KEY = 'abc123privatekey';
    process.env.LOOP_APNS_KEY_ID = 'abc123pkid';
    process.env.LOOP_DEVELOPER_TEAM_ID = 'team123id';
    process.env.ENABLE = ['bridge loop pump iob cob basal careportal sage cage bage openaps override'];
    self.env = require('../env')();
    self.env.settings.authDefaultRoles = 'readable';
    this.wares = require('../lib/middleware/')(self.env);
    self.app = require('express')();
    self.app.enable('api');
    require('../lib/server/bootevent')(self.env, language).boot(function booted(ctx) {
      self.ctx = ctx;
      self.ctx.ddata = require('../lib/data/ddata')();
      self.app.use('/api', api(self.env, ctx));
      done();
    });
  });

  it('/status.json', function (done) {
    request(self.app)
      .get('/api/status.json')
      .expect(200)
      .end(function (err, res)  {
        res.body.apiEnabled.should.equal(true);
        res.body.settings.enable.should.containEql('loop');
        // do not leak private settings
        should.not.exist(res.body.extendedSettings.loop.apnsKey);
        should.not.exist(res.body.extendedSettings.loop.apnsKeyId);
        should.not.exist(res.body.extendedSettings.loop.developerTeamId);
        // do not destroy settings in env
        self.env.extendedSettings.loop.apnsKey.should.equal(process.env.LOOP_APNS_KEY);
        self.env.extendedSettings.loop.apnsKeyId.should.equal(process.env.LOOP_APNS_KEY_ID);
        self.env.extendedSettings.loop.developerTeamId.should.equal(process.env.LOOP_DEVELOPER_TEAM_ID);
        done( );
      });
  });


});

