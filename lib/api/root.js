'use strict';

function configure () {
  const express = require('express')
    , api = express.Router( )
    , apiConst = require('./const')
    , api3Const = require('../api3/const')
    ;

  api.get('/versions', function getVersion (req, res) {

    const versions = [
      { version: apiConst.API1_VERSION, url: '/api/v1' },
      { version: apiConst.API2_VERSION, url: '/api/v2' },
      { version: api3Const.API3_VERSION, url: '/api/v3' }
    ];

    res.json(versions);
  });

  return api;
}
module.exports = configure;
