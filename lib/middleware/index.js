'use strict';

var wares = {
  verifyAuthorization : require('./verify-token'),
  sendJSONStatus : require('./send-json-status'),
  bodyParser : require('body-parser')
};

function extensions (list) {
  return require('express-extension-to-accept')(list);
}

function configure (env) {
  return {
    verifyAuthorization: wares.verifyAuthorization(env),
    sendJSONStatus: wares.sendJSONStatus( ),
    bodyParser: wares.bodyParser,
    extensions: extensions
  };
}

configure.wares = wares;
module.exports = configure;
