'use strict';

var moment = require('moment')
  , apiConst = require('./const.json')

function configure (app, env, ctx) {

  function checkDateHeader (req, res) {

    var dateHeader = req.header('Date');
    if (!dateHeader) {
      return res.sendJSONStatus(res, 401, apiConst.MSG.HTTP_401_MISSING_DATE);
    }

    var date = new Date(dateHeader);
    if (isNaN(date)) {
      return res.sendJSONStatus(res, 401, apiConst.MSG.HTTP_401_BAD_DATE);
    }

    var now = moment(new Date());
    var diffMinutes = moment.duration(now.diff(date)).asMinutes();
    if (Math.abs(diffMinutes) > app.get('API3_TIME_SKEW_TOLERANCE')) {
      return res.sendJSONStatus(res, 401, apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
    }

    return true;
  }

  function authBuilder (permission) {

    return function authorize (req, res, next) {
      
      if (!app.get('API3_SECURITY_ENABLE')) {
        return next();
      }

      if (req.protocol !== 'https') {
        return res.sendJSONStatus(res, 403, apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
      }

      if (checkDateHeader(req, res) !== true) {
        return;
      }

      var token = ctx.authorization.extractToken(req);
      if (!token) {
        return res.sendJSONStatus(res, 401, apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
      }

      ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
        if (err) {
          return res.sendJSONStatus(res, 401, apiConst.MSG.HTTP_401_BAD_TOKEN);
        }
        else {
          if (!ctx.authorization.checkMultiple(permission, result.shiros)) {
            return res.sendJSONStatus(res, 403, apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', permission));
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