'use strict';

const fs = require('fs')
  , path = require('path')
  , language = require('../../../lib/language')()
  , apiRoot = require('../../../lib/api/root')
  , http = require('http')
  , https = require('https')
  ;

function configure () {
  const self = { };

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
        key: fs.readFileSync(path.join(__dirname, '../api3/localhost.key')),
        cert: fs.readFileSync(path.join(__dirname, '../api3/localhost.crt'))
      };
    }

    env.settings.authDefaultRoles = authDefaultRoles;
    env.settings.enable = enable;

    return env;
  };


  /*
   * Create new web server instance for testing purposes
   */
  self.create = function createHttpServer ({
                                             apiSecret = 'this is my long pass phrase',
                                             useHttps = true,
                                             authDefaultRoles = '',
                                             enable = ['careportal', 'api']
                                           }) {

    return new Promise(function (resolve, reject) {

      try {
        let instance = { },
          hasBooted = false
        ;

        instance.env = self.prepareEnv({ apiSecret, useHttps, authDefaultRoles, enable });

        self.wares = require('../../../lib/middleware/')(instance.env);
        instance.app = require('express')();
        instance.app.enable('api');

        require('../../../lib/server/bootevent')(instance.env, language).boot(function booted (ctx) {
          instance.ctx = ctx;
          instance.ctx.ddata = require('../../../lib/data/ddata')();
          instance.ctx.apiRootApp = apiRoot(instance.env, ctx);

          instance.app.use('/api', instance.ctx.apiRootApp);

          const transport = useHttps ? https : http;

          instance.server = transport.createServer(instance.env.ssl || { }, instance.app).listen(0);
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
  };


  return self;
}

module.exports = configure();