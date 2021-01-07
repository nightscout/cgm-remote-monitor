'use strict';

var request = require('supertest');
var language = require('../lib/language')();
require('should');

describe('verifyauth', function ( ) {
  var api = require('../lib/api/');

  this.timeout(25000);

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

  it('should return defaults when called without secret', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    setup_app(env, function (ctx) {
      ctx.app.enabled('api').should.equal(true);
      ctx.app.api_secret = '';
      ping_authorized_endpoint(ctx.app, 200, done);
    });
  });

  it('should fail when calling with wrong secret', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    setup_app(env, function (ctx) {
      ctx.app.enabled('api').should.equal(true);
      ctx.app.api_secret = 'wrong secret';

      function check(res) {
        res.body.message.message.should.equal('UNAUTHORIZED');
        done();
      }

      ping_authorized_endpoint(ctx.app, 200, check, true);
    });
  });


  it('should fail unauthorized and delay subsequent attempts', function (done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../env')( );
    env.api_secret.should.equal(known);
    setup_app(env, function (ctx) {
      ctx.app.enabled('api').should.equal(true);
      ctx.app.api_secret = 'wrong secret';
      const time = Date.now();

      function checkTimer(res) {
        res.body.message.message.should.equal('UNAUTHORIZED');
        const delta = Date.now() - time;
        delta.should.be.greaterThan(49);
        done();
      }

      function pingAgain (res) {
        res.body.message.message.should.equal('UNAUTHORIZED');
        ping_authorized_endpoint(ctx.app, 200, checkTimer, true);
      }

      ping_authorized_endpoint(ctx.app, 200, pingAgain, true);
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


  function ping_authorized_endpoint (app, httpResponse, fn, passres) {
      request(app)
        .get('/verifyauth')
        .set('api-secret', app.api_secret || '')
        .expect(httpResponse)
        .end(function (err, res)  {
          res.body.status.should.equal(httpResponse);
          if (passres) { fn(res); } else {  fn(); }
          // console.log('err', err, 'res', res);
        });
  }

});

