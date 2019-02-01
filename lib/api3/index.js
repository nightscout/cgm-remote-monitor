'use strict';

function create(env, ctx) {
  var _ = require('lodash')
    , express = require('express')
    , app = express()
 
  app.get('/swagger.yaml', function getSwagger (req, res) {
    res.sendFile(__dirname + '/swagger.yaml');
  });

  return app;
}

module.exports = create;
