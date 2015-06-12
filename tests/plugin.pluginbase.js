var should = require('should');
var load = require('./fixtures/load');

describe('Pluginbase', function ( ) {

  before(function (done) {
    var env = require('../env')( );
    this.wares = require('../lib/middleware/')(env);
    this.app = require('express')( );
    this.app.enable('api');
    var self = this;
    var bootevent = require('../lib/bootevent');
    bootevent(env).boot(function booted (ctx) {
//      self.app.use('/', entries(self.app, self.wares, ctx));
      self.archive = require('../lib/entries')(env, ctx);
    });
  });

  after(function (done) {

  });

  it('should be a module', function ( ) {
    entries.should.be.ok;
  });

  // keep this test pinned at or near the top in order to validate all
  // entries successfully uploaded. if res.body.length is short of the
  // expected value, it may indicate a regression in the create
  // function callback logic in entries.js.
  it('gets requested number of entries', function (done) {

  });

  it('gets default number of entries', function (done) {

  });

  it('/entries/current.json', function (done) {

  });

  it('/entries/sgv/ID', function (done) {

  });

  it('/entries/preview', function (done) {

  });
});
