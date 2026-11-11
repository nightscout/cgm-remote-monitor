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

// Plugin extended settings an operator may supply per tenant, by plugin name
// and setting name exactly as a single site's findExtendedSettings produces
// them from <PLUGIN>_<SETTING> (lib/server/env.js). Each value is typed; any
// other plugin or setting is not carried. Credentials (pushover, maker, loop
// APNs, connect/bridge/mmconnect) and the dbsize settings, which are not
// offered under multi, are deliberately absent.
const B = ['boolean'], N = ['number'], S = ['string'], C = ['string', 'number'];
const AGE = { info: N, warn: N, urgent: N, enableAlerts: B };
const EXTENDED = Object.freeze(Object.fromEntries(Object.entries({
  timeago: { enableAlerts: B },
  ar2: { coneFactor: N },
  rawbg: { display: S },
  bolus: { renderFormat: S, renderFormatSmall: S, renderOver: N, notifyOver: N },
  basal: { render: S },
  profile: { multiple: B },
  iage: AGE,
  sage: AGE,
  cage: { ...AGE, display: S },
  bage: { ...AGE, display: S },
  errorcodes: { info: C, warn: C, urgent: C },
  upbat: { warn: N, urgent: N, enableAlerts: B },
  pump: { fields: S, retroFields: S, warnBattQuietNight: B, warnClock: N, urgentClock: N, warnRes: N, urgentRes: N,
    warnBattV: N, urgentBattV: N, warnBattP: N, urgentBattP: N, warnOnSuspend: B, enableAlerts: B },
  loop: { warn: N, urgent: N, enableAlerts: B },
  openaps: { fields: S, retroFields: S, warn: N, urgent: N, enableAlerts: B, predIobColor: S, predCobColor: S,
    predAcobColor: S, predZtColor: S, predUamColor: S, colorPredictionLines: B },
  xdripjs: { enableAlerts: B, warnBatV: N, stateNotifyIntrvl: N },
  bwp: { snooze: N, warn: N, urgent: N, snoozeMins: N },
  treatmentnotify: { includeBolusesOver: N, snoozeMins: N }
}).map(([plugin, keys]) => [plugin, Object.freeze({ ...keys })])));
const extendedObjects = new WeakSet();

function typed (value, types) {
  return types.includes(typeof value) && (typeof value !== 'number' || Number.isFinite(value)) &&
    (typeof value !== 'string' || value.length <= 256);
}

// A fresh object of primitives per call, so no tenant shares a reference.
function projectExtended (input) {
  const result = {};
  if (!input || typeof input !== 'object') return result;
  if (input.devicestatus && [1, 2].includes(input.devicestatus.days)) result.devicestatus = { days: input.devicestatus.days };
  for (const [plugin, keys] of Object.entries(EXTENDED)) {
    const values = Object.hasOwn(input, plugin) ? input[plugin] : undefined;
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const carried = {};
    for (const [key, types] of Object.entries(keys)) {
      if (Object.hasOwn(values, key) && typed(values[key], types)) carried[key] = values[key];
    }
    if (Object.keys(carried).length) result[plugin] = carried;
  }
  return result;
}

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

// Only tenant-owned display values and the typed plugin extended settings above
// enter this environment. In particular no provider credential, database,
// process setting or arbitrary nested extension is copied.
module.exports = function environment ({ settings: values = {}, extendedSettings = {} } = {}) {
  const settings = createSettings();
  const defaults = project(settings, settings);
  const projected = project(values, settings);
  const thresholds = { ...settings.thresholds, ...projected.thresholds };
  Object.assign(settings, projected, { thresholds });
  settings.enable = projected.enable || [...settings.DEFAULT_FEATURES];
  settings.filteredSettings = input => {
    // A tenant's own extended settings (the status route's extendedSettings)
    // show their typed projection; any other input shows display values only.
    if (extendedObjects.has(input)) return projectExtended(input);
    const shown = project(input, defaults);
    if ([1, 2].includes(input?.devicestatus?.days)) shown.devicestatus = { days: input.devicestatus.days };
    return shown;
  };
  const extended = projectExtended(extendedSettings);
  extendedObjects.add(extended);
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
module.exports.EXTENDED = EXTENDED;
