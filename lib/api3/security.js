'use strict';

const moment = require('moment')
  , apiConst = require('./const.json')
  , _ = require('lodash')
  , shiroTrie = require('shiro-trie')
  , dateTools = require('./shared/dateTools')
  , opTools = require('./shared/operationTools')
  ;


/**
 * Check if Date header in HTTP request (or 'now' query parameter) is present and valid (with error response sending)
 */
function checkDateHeader (opCtx) {

  const { app, req, res } = opCtx;

  let dateString = req.header('Date');
  if (!dateString) {
    dateString = req.query.now;
  }

  if (!dateString) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_DATE);
  }

  let dateMoment = dateTools.parseToMoment(dateString);
  if (!dateMoment) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_DATE);
  }

  let nowMoment = moment(new Date());
  let diffMinutes = moment.duration(nowMoment.diff(dateMoment)).asMinutes();

  if (Math.abs(diffMinutes) > app.get('API3_TIME_SKEW_TOLERANCE')) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_DATE_OUT_OF_TOLERANCE);
  }

  return true;
}


function authenticate (opCtx) {
  return new Promise(function promise (resolve, reject) {

    let { app, ctx, req, res } = opCtx;

    if (!app.get('API3_SECURITY_ENABLE')) {
      const adminShiro = shiroTrie.new();
      adminShiro.add('*');
      return resolve({ shiros: [ adminShiro ] });
    }

    if (req.protocol !== 'https') {
      return reject(
        opTools.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_NOT_USING_HTTPS));
    }

    const checkDateResult = checkDateHeader(opCtx);
    if (checkDateResult !== true) {
      return checkDateResult;
    }

    let token = ctx.authorization.extractToken(req);
    if (!token) {
      return reject(
        opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN));
    }

    ctx.authorization.resolve({ token }, function resolveFinish (err, result) {
      if (err) {
        return reject(
          opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_BAD_TOKEN));
      }
      else {
        return resolve(result);
      }
    });
  });
}


/**
 * Checks for the permission from the authorization without error response sending
 * @param {any} auth
 * @param {any} permission
 */
function checkPermission (auth, permission) {

  if (auth) {
    const found = _.find(auth.shiros, function checkEach (shiro) {
      return shiro && shiro.check(permission);
    });
    return _.isObject(found);
  }
  else {
    return false;
  }
}



function demandPermission (opCtx, permission) {
  return new Promise(function promise (resolve, reject) {
    const { auth, res } = opCtx;

    if (checkPermission(auth, permission)) {
      return resolve(true);
    } else {
      return reject(
        opTools.sendJSONStatus(res, apiConst.HTTP.FORBIDDEN, apiConst.MSG.HTTP_403_MISSING_PERMISSION.replace('{0}', permission)));
    }
  });
}


module.exports = {
  authenticate,
  checkPermission,
  demandPermission
};