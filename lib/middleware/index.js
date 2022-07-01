'use strict';

var _ = require('lodash');
var slowDown = require('express-slow-down');
var wares = {
  sendJSONStatus : require('./send-json-status'),
  bodyParser : require('body-parser'),
  compression : require('compression'),
  obscureDeviceProvenance: require('./obscure-provenance')
};

function extensions (list) {
  return require('./express-extension-to-accept')(list);
}

function configure (env) {
  const SLOWDOWN_WINDOW_MS = _.get(env, 'settings.slowdownWindowMs') || 30000;
  const SLOWDOWN_DELAY_AFTER = _.get(env, 'settings.slowdownDelayAfter') || 1;
  const SLOWDOWN_DELAY_MS = _.get(env, 'settings.slowdownDelayMs') || 5000;
  var speedLimit = slowDown({
    windowMS: SLOWDOWN_WINDOW_MS,
    delayAfter: SLOWDOWN_DELAY_AFTER,
    delayMs: SLOWDOWN_DELAY_MS,
    skipSuccessfulRequests: true
  });

  return {
    sendJSONStatus: wares.sendJSONStatus( ),
    bodyParser: wares.bodyParser,
    jsonParser: wares.bodyParser.json({
      limit: '1Mb',
    }),
    urlencodedParser: wares.bodyParser.urlencoded({
      limit: '1Mb',
      extended: true,
      parameterLimit: 50000
    }),
    rawParser: wares.bodyParser.raw({
      limit: '1Mb'
    }),
    compression: wares.compression,
    extensions: extensions,
    obscure_device: wares.obscureDeviceProvenance(env),
    speedLimit: speedLimit
  };
}

configure.wares = wares;
module.exports = configure;
