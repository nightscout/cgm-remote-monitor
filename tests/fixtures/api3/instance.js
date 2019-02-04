'use strict';

var fs = require('fs')
  , language = require('../../../lib/language')()
  , api = require('../../../lib/api3/')

function configure () {
  var tools = { };

  tools.initHttp = function initHttpServer (done) {
    var instance = { }

    process.env.API_SECRET = 'this is my long pass phrase';
    instance.env = require('../../../env')();
    instance.env.HOSTNAME = 'localhost';
    instance.env.settings.authDefaultRoles = 'readable';
    instance.env.settings.enable = ['careportal', 'api'];

    this.wares = require('../../../lib/middleware/')(instance.env);
    instance.app = require('express')();
    instance.app.enable('api');

    require('../../../lib/server/bootevent')(instance.env, language).boot(function booted (ctx) {
      instance.ctx = ctx;
      instance.ctx.ddata = require('../../../lib/data/ddata')();
      instance.app.use('/api/v3', api(instance.env, ctx));

      var transport = require('http');
      instance.server = transport.createServer(instance.env.ssl, instance.app).listen(0);
      instance.env.PORT = instance.server.address().port;
      instance.baseUrl = 'http://' + instance.env.HOSTNAME + ':' + instance.env.PORT;

      console.log('Started HTTP instance on ' + instance.baseUrl);
      done();
    });

    return instance;
  }


  tools.initHttps = function initHttpsServer (done) {
    var instance = { }

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    process.env.API_SECRET = 'this is my long pass phrase';
    instance.env = require('../../../env')();
    instance.env.ssl = {
      key: fs.readFileSync(__dirname + '/localhost.key'),
      cert: fs.readFileSync(__dirname + '/localhost.crt')
    };
    instance.env.HOSTNAME = 'localhost';
    instance.env.settings.authDefaultRoles = 'readable';
    instance.env.settings.enable = ['careportal', 'api'];

    this.wares = require('../../../lib/middleware/')(instance.env);
    instance.app = require('express')();
    instance.app.enable('api');

    require('../../../lib/server/bootevent')(instance.env, language).boot(function booted (ctx) {
      instance.ctx = ctx;
      instance.ctx.ddata = require('../../../lib/data/ddata')();
      instance.app.use('/api/v3', api(instance.env, ctx));

      var transport = require('https');
      instance.server = transport.createServer(instance.env.ssl, instance.app).listen(0);
      instance.env.PORT = instance.server.address().port;
      instance.baseUrl = 'https://' + instance.env.HOSTNAME + ':' + instance.env.PORT;

      console.log('Started SSL instance on ' + instance.baseUrl);
      done();
    });

    return instance;
  }

  return tools;
}

module.exports = configure();