'use strict';

function create(env, ctx) {
  var _ = require('lodash')
    , express = require('express')
    , app = express()
    , apiConst = require('./const.json')

  var wares = require('../middleware/')(env);
  app.set('name', env.name);
  app.set('version', env.version);
  app.set('apiVersion', apiConst.API3_VERSION);
  app.set('units', env.DISPLAY_UNITS);

  app.get('/swagger.yaml', function getSwagger (req, res) {
    res.sendFile(__dirname + '/swagger.yaml');
  });

  app.get('/version', require('./version')(app, wares, env, ctx));

  return app;
}

module.exports = create;
