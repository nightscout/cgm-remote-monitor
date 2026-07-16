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

  api.post('/telemetry/send', function send (req, res) {
    if (!ctx.telemetry) {
      res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Telemetry unavailable');
      return;
    }
    if (!ctx.telemetry.config.manualSend) {
      res.sendJSONStatus(res, consts.HTTP_BAD_REQUEST, 'Telemetry manual send disabled');
      return;
    }

    ctx.telemetry.sendOnce(function sent (err, result) {
      if (err) {
        res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Telemetry send failed', err.message);
        return;
      }
      res.sendJSONStatus(res, consts.HTTP_OK, result);
    });
  });

  return api;
}

module.exports = configure;
