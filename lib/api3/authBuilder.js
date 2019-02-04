'use strict';

var moment = require('moment');

function configure (app, env, ctx) {

  function checkDateHeader (req, res) {

    var dateHeader = req.header('Date');
    if (!dateHeader) {
      return res.sendJSONStatus(res, 401, 'Missing Date header');
    }

    var date = new Date(dateHeader);
    if (isNaN(date)) {
      return res.sendJSONStatus(res, 401, 'Bad Date header');
    }

    var now = moment(new Date());
    var diffMinutes = moment.duration(now.diff(date)).asMinutes();
    if (Math.abs(diffMinutes) > app.get('API3_TIME_SKEW_TOLERANCE')) {
      return res.sendJSONStatus(res, 401, 'Date header out of tolerance');
    }

    return true;
  }

  function authBuilder (permission) {

    return function authorize (req, res, next) {
      
      if (!app.get('API3_SECURITY_ENABLE')) {
        return next();
      }

      if (req.protocol !== 'https') {
        return res.sendJSONStatus(res, 403, 'Not using SSL/TLS');
      }

      if (checkDateHeader(req, res) !== true) {
        return;
      }

      var token = ctx.authorization.extractToken(req);
      if (!token) {
        return res.sendJSONStatus(res, 401, 'Missing or bad access token or JWT');
      }

      ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
        if (err) {
          return res.sendJSONStatus(res, 401, 'Bad access token or JWT');
        }
        else {
          if (!ctx.authorization.checkMultiple(permission, result.shiros)) {
            return res.sendJSONStatus(res, 403, 'Missing permission ' + permission);
          }
          else {
            return next();
          }
        }
      });
    }
  }

  return authBuilder;
}

module.exports = configure;