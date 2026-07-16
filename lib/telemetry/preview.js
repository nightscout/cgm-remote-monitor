'use strict';

const express = require('express');
const consts = require('../constants');

function configure (env, ctx) {
  const api = express.Router();

  api.get('/telemetry/preview', function preview (req, res) {
    if (!ctx.telemetry) {
      res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Telemetry unavailable');
      return;
    }

    const response = ctx.telemetry.preview();
    res.sendJSONStatus(res, consts.HTTP_OK, response);
  });

  return api;
}

module.exports = configure;
