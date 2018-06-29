'use strict';

var request = require('supertest');
var language = require('../lib/language')();

describe('verifyauth', function ( ) {
  var api = require('../lib/api/');

  var scope = this;
  function setup_app (env, fn) {
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.app = api(env, ctx);
      scope.app = ctx.app;
      fn(ctx);
    });
  }

  after(function (done) {
    done();
  });

  it('should fail unauthorized', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    setup_app(env, function (ctx) {
      ctx.app.enabled('api').should.equal(true);
      ctx.app.api_secret = '';
      ping_authorized_endpoint(ctx.app, 401, done);
    });

  });


  it('should work fine authorized', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    setup_app(env, function (ctx) {
      ctx.app.enabled('api').should.equal(true);
      ctx.app.api_secret = env.api_secret;
      ping_authorized_endpoint(ctx.app, 200, done);
    });

  });


  function ping_authorized_endpoint (app, fails, fn) {
      request(app)
        .get('/verifyauth')
        .set('api-secret', app.api_secret || '')
        .expect(fails)
        .end(function (err, res)  {
          //console.log(res.body);
          if (fails < 400) {
            res.body.status.should.equal(200);
          }
          fn( );
          // console.log('err', err, 'res', res);
        });
  }

});

