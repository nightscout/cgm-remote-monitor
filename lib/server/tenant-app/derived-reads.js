'use strict';

const express = require('express');
const derivedFrame = require('./derived-frame');
const language = require('../../language')();

module.exports = function derivedReads ({ env, ctx, loadFrame }) {
  if (!ctx || typeof loadFrame !== 'function') throw new TypeError('Derived reads require a trusted frame loader');
  const router = express.Router();
  // Bind authorization while the request still has its complete v2 path;
  // nested mounts trim req.path before the shipping permission middleware.
  router.use(ctx.authorization.isPermitted());
  ctx.dataloader = {
    update (target, options, callback) {
      Promise.resolve().then(() => loadFrame({ at: options.lastUpdated })).then(frame => {
        Object.assign(target, frame.ddata);
        callback(null, target);
      }, callback);
    }
  };
  // The environment's settings projection is for status/settings output. The
  // shipping properties handler uses the recursive secret filter on computed
  // properties, whose keys are not display-setting keys.
  const propertyEnv = { settings: { filteredSettings: require('../../settings')().filteredSettings } };
  router.use('/properties', require('../../api2/properties')(propertyEnv, ctx));
  router.use('/ddata', require('../../data/endpoints')(env, ctx));
  router.use('/summary', require('../../api2/summary')(env, ctx));
  router.prepare = frame => derivedFrame({ env, frame, language });
  return router;
};
