
var wares = {
  verifyAuthorization : require('./verify-token'),
  sendJSONStatus : require('./send-json-status'),
  requireSSL : require('./require-ssl')
};

function configure (env) {
  var middle = {
    verifyAuthorization: wares.verifyAuthorization(env),
    sendJSONStatus: wares.sendJSONStatus( ),
    requireSSL: wares.requireSSL( )
  };
  return middle;
}

configure.wares = wares;
module.exports = configure;
