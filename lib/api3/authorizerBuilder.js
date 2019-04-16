'use strict';

var moment = require('moment')
  , apiConst = require('./const.json')

/**
 * Builder of authorization middleware functions
 */
function AuthorizerBuilder (app, env, ctx) {

  var self = this

  self.checkDateHeader = function checkDateHeader (req, res) {

    var dateHeader = req.header('Date');
    if (!dateHeader) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_DATE);
    }

    var date = new Date(dateHeader);
    if (isNaN(date)) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_DATE);
    }

    var now = moment(new Date());
    var diffMinutes = moment.duration(now.diff(date)).asMinutes();
    if (Math.abs(diffMinutes) > app.get('API3_TIME_SKEW_TOLERANCE')) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
    }

    return true;
  }


  /**
   * Create authorization middleware function which demands the permission
   * @param {string} permission - permission to demand
   */
  self.authorizerFor = function authorizerFor (permission) {

    return function authorize (req, res, next) {
      
      function checkPermission(authorization, permission) {
        if (permission)
        {
          if (!ctx.authorization.checkMultiple(permission, authorization.shiros)) {
            return res.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', permission));
          }
          else {
            return next();
          }
        }
        else {
          return next();
        }
      }


      if (!app.get('API3_SECURITY_ENABLE')) {
        return next();
      }

      if (req.authorization) { // let's reuse already prepared authorization
        checkPermission(req.authorization, permission);
      }

      if (req.protocol !== 'https') {
        return res.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
      }

      if (self.checkDateHeader(req, res) !== true) {
        return;
      }

      var token = ctx.authorization.extractToken(req);
      if (!token) {
        return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
      }

      ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
        if (err) {
          return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_TOKEN);
        }
        else {
          req.authorization = result; // let's cache authorization info

          checkPermission(result, permission);
        }
      });
    }
  }


  /**
   * Checks for the permission from cached authorization (works only after authorizerFor call)
   * @param {any} req
   * @param {any} permission
   */
  self.checkPermission = function checkPermission (req, permission) {

    if (!app.get('API3_SECURITY_ENABLE')) {
      return true;
    }

    if (req.authorization) {
      return ctx.authorization.checkMultiple(permission, req.authorization.shiros);
    }
    else {
      return false;
    }
  }
}

module.exports = AuthorizerBuilder;