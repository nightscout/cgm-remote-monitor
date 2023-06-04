'use strict';

var consts = require('../constants');

function configure (env, ctx) {
  var express = require('express')
    , api = express.Router( )
    ;

  api.use(ctx.wares.compression());
  
  api.get('/', ctx.authorization.isPermitted('api:*:read'), function (req, res) {

    let status = {};
    res.setHeader('content-type', 'application/json');
    res.write(JSON.stringify(status));
    res.end( );
  });

  return api;
}
module.exports = configure;
