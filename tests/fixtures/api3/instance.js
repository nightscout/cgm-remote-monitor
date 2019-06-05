'use strict';

var fs = require('fs')
  , bodyParser = require('body-parser')
  , language = require('../../../lib/language')()
  , api = require('../../../lib/api3/')
  , http = require('http')
  , https = require('https')

function configure () {
  var self = { };

  self.prepareEnv = function prepareEnv({ apiSecret, useHttps, authDefaultRoles, enable }) {

    if (useHttps) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    else {
      process.env.INSECURE_USE_HTTP = true;
    }
    process.env.API_SECRET = apiSecret;

    process.env.HOSTNAME = 'localhost';
    const env = require('../../../env')();

    if (useHttps) {
      env.ssl = {
        key: fs.readFileSync(__dirname + '/localhost.key'),
        cert: fs.readFileSync(__dirname + '/localhost.crt')
      };
    }

    env.settings.authDefaultRoles = authDefaultRoles;
    env.settings.enable = enable;

    return env;
  }


  /*
   * Create new web server instance for testing purposes
   */
  self.create = function createHttpServer ({ 
    apiSecret = 'this is my long pass phrase', 
    disableSecurity = false, 
    useHttps = true,
    authDefaultRoles = '',
    enable = ['careportal', 'api']
    }) {

    return new Promise(function (resolve, reject) {

      try {
        let instance = { },
          hasBooted = false

        instance.env = self.prepareEnv({ apiSecret, useHttps, authDefaultRoles, enable });

        self.wares = require('../../../lib/middleware/')(instance.env);
        instance.app = require('express')();
        instance.app.enable('api');

        require('../../../lib/server/bootevent')(instance.env, language).boot(function booted (ctx) {
          instance.ctx = ctx;
          instance.ctx.ddata = require('../../../lib/data/ddata')();
          instance.ctx.apiApp = api(instance.env, ctx);

          if (disableSecurity) {
            instance.ctx.apiApp.set('API3_SECURITY_ENABLE', false);
          }

          instance.app.use('/api/v3', bodyParser({
            limit: 1048576 * 50
          }), instance.ctx.apiApp);

          const transport = useHttps ? https : http;

          instance.server = transport.createServer(instance.env.ssl, instance.app).listen(0);
          instance.env.PORT = instance.server.address().port;

          instance.baseUrl = `${useHttps ? 'https' : 'http'}://${instance.env.HOSTNAME}:${instance.env.PORT}`;

          console.log(`Started ${useHttps ? 'SSL' : 'HTTP'} instance on ${instance.baseUrl}`);
          hasBooted = true;
          resolve(instance);
        });

        setTimeout(function watchDog() {
          if (!hasBooted)
            reject('timeout');
        }, 30000);

      } catch (err) {
        reject(err);
      }
    });
  }

  return self;
}

module.exports = configure();