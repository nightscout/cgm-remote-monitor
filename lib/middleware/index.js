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
  var middle = {
    verifyAuthorization: wares.verifyAuthorization(env),
    sendJSONStatus: wares.sendJSONStatus( ),
    requireSSL: wares.requireSSL( ),
    bodyParser: wares.bodyParser,
    extensions: extensions
  };
  return middle;
}

configure.wares = wares;
module.exports = configure;
