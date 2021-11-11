'use strict';

const request = require('supertest');
const should = require('should');
const language = require('../lib/language')();
//const io = require('socket.io-client');

describe('API_SECRET', function() {
  var api;
  var scope = this;
  var websocket;
  var app;
  var server;
  var listener;

  this.timeout(7000);

  afterEach(function(done) {
    if (listener) {
      listener.close(done);
    }
    done();
  });

  after(function(done) {
    if (listener) {
      listener.close(done);
    }
    done();
  });

  function setup_app (env, fn) {
    api = require('../lib/api/');
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.app = api(env, ctx);
      scope.app = ctx.app;
      scope.entries = ctx.entries;
      fn(ctx);
    });
  }

  function setup_big_app (env, fn) {
    api = require('../lib/api/');
    require('../lib/server/bootevent')(env, language).boot(function booted (ctx) {
      ctx.app = api(env, ctx);
      scope.app = ctx.app;
      scope.entries = ctx.entries;

      app = require('../lib/server/app')(env, ctx);
      server = require('http').createServer(app);
      listener = server.listen(1337, 'localhost');
      websocket = require('../lib/server/websocket')(env, ctx, server);

      fn(ctx);
    });
  }

  it('should fail when unauthorized', function(done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';

    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();

    env.enclave.isApiKey(known).should.equal(true);

    setup_app(env, function(ctx) {
      ctx.app.enabled('api').should.equal(true);
      ping_status(ctx.app, again);

      function again () {
        ctx.app.api_secret = '';
        ping_authorized_endpoint(ctx.app, 401, done);
      }
    });

  });

  it('should work fine set', function(done) {
    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();
    env.enclave.isApiKey(known).should.equal(true);
    setup_app(env, function(ctx) {
      ctx.app.enabled('api').should.equal(true);
      ping_status(ctx.app, again);

      function again () {
        ctx.app.api_secret = known;
        ping_authorized_endpoint(ctx.app, 200, done);
      }
    });

  });

  it('should not work short', function() {
    delete process.env.API_SECRET;
    process.env.API_SECRET = 'tooshort';
    var env = require('../lib/server/env')();
    should.not.exist(env.api_secret);
    env.err[0].desc.should.startWith('API_SECRET should be at least');
  });

  function ping_status (app, fn) {
    request(app)
      .get('/status.json')
      .expect(200)
      .end(function(err, res) {
        res.body.status.should.equal('ok');
        fn();
      });
  }

  function ping_authorized_endpoint (app, fails, fn) {
    request(app)
      .get('/experiments/test')
      .set('api-secret', app.api_secret || '')
      .expect(fails)
      .end(function(err, res) {
        if (fails < 400) {
          res.body.status.should.equal('ok');
        }
        fn();
      });
  }

  /*
  it('socket IO should connect', function(done) {

    var known = 'b723e97aa97846eb92d5264f084b2823f57c4aa1';
    process.env.API_SECRET = 'this is my long pass phrase';
    var env = require('../lib/server/env')();

    setup_big_app(env, function(ctx) {

      const socket2 = io.connect('ws://localhost:1337/');

      socket2.on('connect', function() {
        console.log('Socket 2 authorizing');
        socket2.emit("authorize", {
          secret: known
        });
      });

      socket2.on('disconnect', function() {
        //socket.emit("authorize");
        console.log('Client 2 disconnected');
        done();
      });

      socket2.on('connected', function(msg) {
        console.log('Connected');

        // Disconnect both client connections
        socket2.disconnect();

        const socket = io.connect('ws://localhost:1337/');

        socket.on('connect', function() {
          console.log('Socket 1 authorizing');
          socket.emit("authorize");
        });

        socket.on('disconnect', function() {
          //socket.emit("authorize");
          console.log('Client 1 disconnected');
          done();
        });

      });

    });

  });
  */

});
