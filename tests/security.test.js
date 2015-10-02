'use strict';

var request = require('supertest');
var should = require('should');
var load = require('./fixtures/load');

describe('API_SECRET', function ( ) {
  var api = require('../lib/api/');
  api.should.be.ok;

  var scope = this;
  function setup_app (env, fn) {
    var ctx = { };
    ctx.wares = require('../lib/middleware/')(env);
    ctx.store = require('../lib/storage')(env);
    ctx.archive = require('../lib/entries').storage(env.mongo_collection, ctx.store);
    ctx.settings = require('../lib/settings')(env.settings_collection, ctx.store);

    ctx.store(function ( ) {
      ctx.app = api(env, ctx.wares, ctx.archive, ctx.settings);
      scope.app = ctx.app;
      ctx.archive.create(load('json'), fn);
      scope.archive = ctx.archive;
    });

    return ctx;
  }
  /*
  before(function (done) {

  });
  */
  after(function (done) {
    scope.archive( ).remove({ }, done);
  });

  it('should work fine absent', function (done) {
    delete process.env.API_SECRET;
    var env = require('../env')( );
    should.not.exist(env.api_secret);
    var ctx = setup_app(env,  function ( ) {
      ctx.app.enabled('api').should.be.false;
      ping_status(ctx.app, again);
      function again ( ) {
        ping_authorized_endpoint(ctx.app, 404, done);
      }
    });
  });


  it('should work fail set unauthorized', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    var ctx = setup_app(env,  function ( ) {
      // console.log(this.app.enabled('api'));
      ctx.app.enabled('api').should.be.true;
      // ping_status(ctx.app, done);
      // ping_authorized_endpoint(ctx.app, 200, done);
      ping_status(ctx.app, again);
      function again ( ) {
        ctx.app.api_secret = '';
        ping_authorized_endpoint(ctx.app, 401, done);
      }
    });

  });


  it('should work fine set', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    var ctx = setup_app(env,  function ( ) {
      // console.log(this.app.enabled('api'));
      ctx.app.enabled('api').should.be.true;
      // ping_status(ctx.app, done);
      // ping_authorized_endpoint(ctx.app, 200, done);
      ping_status(ctx.app, again);
      function again ( ) {
        ctx.app.api_secret = env.api_secret;
        ping_authorized_endpoint(ctx.app, 200, done);
      }
    });

  });

  it('should not work short', function ( ) {
    var known = 'c1d117818a97e847bdf286aa02d9dc8e8f7148f5';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'tooshort';
    var env;
    (function ( ) {
      env = require('../env')( );
    }).should.throw( );
    should.not.exist(env);
  });

  function ping_status (app, fn) {
      request(app)
        .get('/status.json')
        .expect(200)
        .end(function (err, res)  {
          // console.log(res.body);
          res.body.status.should.equal('ok');
          fn( );
          // console.log('err', err, 'res', res);
        })
  }

  function ping_authorized_endpoint (app, fails, fn) {
      request(app)
        .get('/experiments/test')
        .set('api-secret', app.api_secret || '')
        .expect(fails)
        .end(function (err, res)  {
          if (fails < 400) {
            res.body.status.should.equal('ok');
          }
          fn( );
          // console.log('err', err, 'res', res);
        })
  }

});

