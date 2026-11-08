'use strict';

const createSettings = require('../../settings');
const environments = new WeakSet();

const CLIENT_KEYS = [
  'units', 'timeFormat', 'dayStart', 'dayEnd', 'nightMode', 'showSeconds', 'editMode',
  'showRawbg', 'customTitle', 'theme', 'alarmUrgentHigh', 'alarmUrgentHighMins',
  'alarmHigh', 'alarmHighMins', 'alarmLow', 'alarmLowMins', 'alarmUrgentLow',
  'alarmUrgentLowMins', 'alarmUrgentMins', 'alarmWarnMins', 'alarmTimeagoWarn',
  'alarmTimeagoWarnMins', 'alarmTimeagoUrgent', 'alarmTimeagoUrgentMins',
  'alarmPumpBatteryLow', 'language', 'scaleY', 'showPlugins', 'showForecast',
  'focusHours', 'heartbeat', 'showClockDelta', 'showClockLastTime',
  'authenticationPromptOnLoad'
];
const FEATURES = /^[a-z][a-z0-9_-]{0,63}$/;
const THRESHOLDS = ['bgHigh', 'bgTargetTop', 'bgTargetBottom', 'bgLow'];

function project (input, defaults) {
  const result = {};
  for (const key of CLIENT_KEYS) {
    const value = input && input[key];
    if (typeof value === typeof defaults[key] && ['string', 'number', 'boolean'].includes(typeof value) &&
        (typeof value !== 'number' || Number.isFinite(value))) result[key] = value;
    if (Array.isArray(defaults[key]) && Array.isArray(value) &&
        value.every(item => typeof item === 'number' && Number.isFinite(item))) result[key] = [...value];
  }
  if (Array.isArray(input && input.enable)) {
    result.enable = input.enable.filter(item => typeof item === 'string' && FEATURES.test(item));
  }
  if (input && input.thresholds) {
    result.thresholds = {};
    for (const key of THRESHOLDS) {
      if (typeof input.thresholds[key] === 'number' && Number.isFinite(input.thresholds[key])) {
        result.thresholds[key] = input.thresholds[key];
      }
    }
  }
  return result;
}

// Only tenant-owned display values enter this environment. In particular no
// provider, database, process settings or arbitrary nested extension is copied.
module.exports = function environment ({ settings: values = {}, extendedSettings = {} } = {}) {
  const settings = createSettings();
  const defaults = project(settings, settings);
  const projected = project(values, settings);
  const thresholds = { ...settings.thresholds, ...projected.thresholds };
  Object.assign(settings, projected, { thresholds });
  settings.enable = projected.enable || [...settings.DEFAULT_FEATURES];
  settings.filteredSettings = input => {
    const shown = project(input, defaults);
    if ([1, 2].includes(input?.devicestatus?.days)) shown.devicestatus = { days: input.devicestatus.days };
    return shown;
  };
  const extended = {};
  if ([1, 2].includes(extendedSettings.devicestatus && extendedSettings.devicestatus.days)) {
    extended.devicestatus = { days: extendedSettings.devicestatus.days };
  }
  // Preserve the shipping default for legacy client string identities. This
  // storage behavior is fixed here, not supplied by display settings or by a
  // process-global environment belonging to another tenant.
  const env = { settings, extendedSettings: extended, uuidHandling: true };
  environments.add(env);
  return env;
};
module.exports.isSafe = env => environments.has(env);
module.exports.CLIENT_KEYS = Object.freeze(CLIENT_KEYS);
module.exports.THRESHOLDS = Object.freeze(THRESHOLDS);
