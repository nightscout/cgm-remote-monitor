'use strict';

const apiConst = require('./const.json')
  , _ = require('lodash')
  , shiroTrie = require('shiro-trie')
  , opTools = require('./shared/operationTools')
  , forwarded = require('forwarded-for')
  ;


function getRemoteIP (req) {
  const address = forwarded(req, req.headers);
  return address.ip;
}


function authenticate (opCtx) {
  return new Promise(function promise (resolve, reject) {

    let { app, ctx, req, res } = opCtx;

    if (!app.get('API3_SECURITY_ENABLE')) {
      const adminShiro = shiroTrie.new();
      adminShiro.add('*');
      return resolve({ shiros: [ adminShiro ] });
    }

    let token = ctx.authorization.extractToken(req);
    if (!token) {
      return reject(
        opTools.sendJSONStatus(res, apiConst.HTTP.UNAUTHORIZED, apiConst.MSG.HTTP_401_MISSING_OR_BAD_TOKEN));
    }

    ctx.authorization.resolve({ token, ip: getRemoteIP(req) }, function resolveFinish (err, result) {
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
