'use strict';

const FEATURE_NAMES = Object.freeze([
  'careportal',
  'iob',
  'cob',
  'bridge',
  'connect',
  'connect.dexcomshare',
  'connect.glooko',
  'connect.linkup',
  'connect.minimedcarelink',
  'connect.nightscout',
  'rawbg',
  'openaps',
  'loop',
  'mmconnect',
  'pump',
  'profile',
  'alexa',
  'googlehome'
]);

const COUNTER_NAMES = Object.freeze([
  'api.v1.entries.read',
  'api.v1.entries.write',
  'api.v1.status.read',
  'api.v1.profile.read',
  'api.v1.devicestatus.read',
  'api.v1.devicestatus.write',
  'api.v2.properties.read',
  'api.v3.entries.read',
  'api.v3.entries.write',
  'api.v3.status.read',
  'api.v3.version.read',
  'api.v3.last-modified.read',
  'reports.opened',
  'reports.daily',
  'reports.weekly',
  'reports.monthly',
  'plugins.bridge.active',
  'plugins.connect.active',
  'connect.source.dexcomshare.active',
  'connect.source.glooko.active',
  'connect.source.linkup.active',
  'connect.source.minimedcarelink.active',
  'connect.source.nightscout.active',
  'plugins.careportal.active',
  'plugins.iob.active',
  'plugins.cob.active',
  'plugins.rawbg.active',
  'plugins.openaps.active',
  'plugins.loop.active',
  'plugins.mmconnect.active',
  'plugins.pump.active',
  'plugins.profile.active',
  'plugins.alexa.active',
  'plugins.googlehome.active',
  'startup.success',
  'startup.config-error',
  'startup.database-error',
  'startup.dependency-error'
]);

const FEATURE_SET = new Set(FEATURE_NAMES);
const COUNTER_SET = new Set(COUNTER_NAMES);

function filterFeatures (features) {
  if (!Array.isArray(features)) {
    return [];
  }
  return Array.from(new Set(features.filter(feature => FEATURE_SET.has(feature)))).sort();
}

function isAllowedCounter (name) {
  return COUNTER_SET.has(name);
}

function connectFeature (source) {
  if (!source || typeof source !== 'string') {
    return null;
  }
  var normalized = source.toLowerCase();
  var feature = 'connect.' + normalized;
  return FEATURE_SET.has(feature) ? feature : null;
}

function connectCounter (source) {
  if (!source || typeof source !== 'string') {
    return null;
  }
  var normalized = source.toLowerCase();
  var counter = 'connect.source.' + normalized + '.active';
  return COUNTER_SET.has(counter) ? counter : null;
}

module.exports = {
  FEATURE_NAMES,
  COUNTER_NAMES,
  filterFeatures,
  isAllowedCounter,
  connectFeature,
  connectCounter
};
