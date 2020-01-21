'use strict';

var wares = {
  sendJSONStatus : require('./send-json-status'),
  bodyParser : require('body-parser'),
  compression : require('compression')
};

function extensions (list) {
  return require('./express-extension-to-accept')(list);
}

function configure () {
  return {
    sendJSONStatus: wares.sendJSONStatus( ),
    bodyParser: wares.bodyParser,
    compression: wares.compression,
    extensions: extensions
  };
}

configure.wares = wares;
module.exports = configure;
