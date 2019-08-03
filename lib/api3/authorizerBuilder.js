'use strict';

const moment = require('moment')
  , apiConst = require('./const.json')
  , dateTools = require('./shared/dateTools')

/**
 * Builder of authorization middleware functions
 */
function AuthorizerBuilder (app, env, ctx) {

  const self = this;


  /**
   * Check if Date header in HTTP request (or 'now' query parameter) is present and valid (with error response sending)
   * @param {any} req
   * @param {any} res
   */
  self.checkDateHeader = function checkDateHeader (req, res) {

    let dateString = req.header('Date');
    if (!dateString) {
      dateString = req.query.now;
    }

    if (!dateString) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_DATE);
    }

    let dateMoment = dateTools.parseToMoment(dateString);
    if (!dateMoment) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_DATE);
    }

    let nowMoment = moment(new Date());
    let diffMinutes = moment.duration(nowMoment.diff(dateMoment)).asMinutes();

    if (Math.abs(diffMinutes) > app.get('API3_TIME_SKEW_TOLERANCE')) {
      return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
    }

    return true;
  }



  /**
   * Create authorization middleware which demands the permission
   * @param {string} permission - permission to demand
   */
  self.authorizerFor = function authorizerFor (permission) {

   
    return function authorize (req, res, next) {
      
      /**
       * Check if current subject has granted specific permission
       * @param {any} authorization
       * @param {any} permission
       * @param {any} res - response to write eventual authorization error
       */
      function checkPermission(authorization, permission) {
        if (permission)
        {
          if (!ctx.authorization.checkMultiple(permission, authorization.shiros)) {
            return res.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', permission));
          }
          else {
            return next(authorization);
          }
        }
        else {
          return next(authorization);
        }
      }

      if (!app.get('API3_SECURITY_ENABLE')) {
        return next();
      }

      if (req.authorization) { // let's reuse already prepared authorization
        return checkPermission(req.authorization, permission);
      }

      if (req.protocol !== 'https') {
        return res.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_NOT_USING_HTTPS);
      }

      if (self.checkDateHeader(req, res) !== true) {
        return;
      }

      let token = ctx.authorization.extractToken(req);
      if (!token) {
        return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN);
      }

      ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
        if (err) {
          return res.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_TOKEN);
        }
        else {
          req.authorization = result; // let's cache authorization info

          return checkPermission(result, permission);
        }
      });

    }
  }


  /**
   * Checks for the permission from cached authorization (works only after authorizerFor call),
   * without error response sending
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