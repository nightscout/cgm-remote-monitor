'use strict';

var wares = {
  sendJSONStatus : require('./send-json-status'),
  bodyParser : require('body-parser'),
  compression : require('compression')
};

function extensions (list) {
  return require('./express-extension-to-accept')(list);
}

function configure (env) {
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
    extensions: extensions
  };
}

configure.wares = wares;
module.exports = configure;
