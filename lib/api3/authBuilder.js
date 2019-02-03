'use strict';

function configure (env, ctx) {

  function authBuilder (permission) {

    return function authorize (req, res, next) {
      
      var token = ctx.authorization.extractToken(req);
      if (!token) {
        res.sendJSONStatus(res, 401, 'Missing or bad access token or JWT');
      }

      ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
        if (err) {
          res.sendJSONStatus(res, 401, 'Bad access token or JWT');
        }
        else {
          if (!ctx.authorization.checkMultiple(permission, result.shiros)) {
            res.sendJSONStatus(res, 403, 'Missing permission ' + permission);
          }
          else {
            next();
          }
        }
      });
    }
  }

  return authBuilder;
}

module.exports = configure;