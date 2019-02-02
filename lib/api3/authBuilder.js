'use strict';

function configure (env, ctx) {

  function authBuilder (permission) {

    return function authorize (req, res, next) {
      
      res.sendJSONStatus(res, 401, 'Missing access token or JWT');
    }
  }

  return authBuilder;
}

module.exports = configure;