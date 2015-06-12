'use strict';

var wares = {
  verifyAuthorization : require('./verify-token'),
  sendJSONStatus : require('./send-json-status'),
  requireSSL : require('./require-ssl'),
  bodyParser : require('body-parser')
};

function extensions (list) {
  return require('express-extension-to-accept')(list);
}

function configure (env) {
  return {
    verifyAuthorization: wares.verifyAuthorization(env),
    sendJSONStatus: wares.sendJSONStatus( ),
    requireSSL: wares.requireSSL( ),
    bodyParser: wares.bodyParser,
    extensions: extensions
  };
}

configure.wares = wares;
module.exports = configure;
