'use strict';

const { isDeepStrictEqual } = require('node:util');
const environment = require('../server/tenant-app/environment');
const settings = require('../settings')();
const aliases = Object.freeze({ units: 'DISPLAY_UNITS', showSeconds: 'SHOW_SECONDS' });
const THRESHOLDS = environment.THRESHOLDS;
const DEFAULTS = Object.freeze(Object.fromEntries(environment.CLIENT_KEYS.map(key => [aliases[key] || key, settings[key]])
  .concat([['enable', [...settings.DEFAULT_FEATURES]]], THRESHOLDS.map(key => [key, settings.thresholds[key]]))));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const equal = isDeepStrictEqual;
function valid (name, value) {
  if (!Object.hasOwn(DEFAULTS, name)) return false;
  if (name === 'DISPLAY_UNITS') return ['mg/dl', 'mmol'].includes(value);
  if (THRESHOLDS.includes(name)) return typeof value === 'number' && Number.isFinite(value) && value >= 30 && value <= 600;
  if (name === 'enable') return Array.isArray(value) && value.length <= 256 && new Set(value).size === value.length &&
    value.every(item => typeof item === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(item));
  const fallback = DEFAULTS[name];
  if (Array.isArray(fallback)) return Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'number' && Number.isFinite(item));
  return typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value));
}
function normalize (input) {
  if (!object(input)) throw new TypeError('Settings require an object');
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const entries = key === 'thresholds' && object(value) ? Object.entries(value) : [[aliases[key] || key, value]];
    if (key === 'thresholds' && (!object(value) || Object.keys(value).length !== THRESHOLDS.length || THRESHOLDS.some(name => !Object.hasOwn(value, name)))) {
      throw Object.assign(new Error('SETTINGS_VALUE'), { code: 'SETTINGS_VALUE', details: ['thresholds'] });
    }
    for (const [name, current] of entries) {
      if (!Object.hasOwn(DEFAULTS, name)) throw Object.assign(new Error('SETTINGS_UNSUPPORTED'), { code: 'SETTINGS_UNSUPPORTED', details: [name] });
      if (Object.hasOwn(result, name) || !valid(name, current)) throw Object.assign(new Error('SETTINGS_VALUE'), { code: 'SETTINGS_VALUE', details: [name] });
      result[name] = structuredClone(current);
    }
  }
  const count = THRESHOLDS.filter(name => Object.hasOwn(result, name)).length;
  if (count && count !== THRESHOLDS.length) throw Object.assign(new Error('SETTINGS_VALUE'), { code: 'SETTINGS_VALUE', details: ['thresholds'] });
  return result;
}
function project (effective) {
  const result = {};
  for (const key of environment.CLIENT_KEYS.concat('enable')) {
    const row = effective[aliases[key] || key];
    if (row) result[key] = structuredClone(row.value);
  }
  const thresholds = THRESHOLDS.filter(key => effective[key]);
  if (thresholds.length && thresholds.length !== THRESHOLDS.length) throw new TypeError('Complete effective thresholds required');
  if (thresholds.length) result.thresholds = Object.fromEntries(thresholds.map(key => [key, effective[key].value]));
  return result;
}
module.exports = { DEFAULTS, THRESHOLDS, valid, normalize, project, equal };
