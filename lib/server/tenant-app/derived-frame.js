'use strict';

const sandbox = require('../../sandbox');
const environment = require('./environment');

// Property setters only. The notification/connector phases of the server
// plugin lifecycle are deliberately not part of a derived REST read.
const modules = Object.freeze([
  'bgnow', 'rawbg', 'direction', 'upbat', 'ar2', 'errorcodes', 'iob', 'cob',
  'pump', 'openaps', 'xdripjs', 'loop', 'boluswizardpreview', 'cannulaage',
  'sensorage', 'insulinage', 'batteryage', 'basalprofile', 'dbsize', 'runtimestate'
]);

module.exports = function derivedFrame ({ env, frame, language }) {
  if (!environment.isSafe(env) || !frame?.ddata || !language) {
    throw new TypeError('Derived frame requires a tenant environment and completed snapshot');
  }
  const levels = { ...require('../../levels'), translate: language.translate };
  const ctx = { settings: env.settings, language, levels, moment: require('moment-timezone'),
    ddata: frame.ddata };
  const sbx = sandbox().serverInit(env, ctx);
  for (const name of modules) {
    const plugin = require('../../plugins/' + name)(ctx);
    if (env.settings.enable.includes(plugin.name) && typeof plugin.setProperties === 'function') {
      // Unlike the evaluator's logged-and-continued failure, a failed REST
      // computation must not be reported as a successful partial response.
      plugin.setProperties(sbx.withExtendedSettings(plugin));
    }
  }
  return sbx;
};
