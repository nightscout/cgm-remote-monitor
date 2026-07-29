'use strict';

function bridgeUseLegacy (bridgeSettings) {
  return bridgeSettings && (bridgeSettings.useLegacy === true || bridgeSettings.dexcomBridgeUseLegacy === true) ||
    String(process.env.DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true' ||
    String(process.env.CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true';
}

function applyBridgeToConnectCompatibility (env) {
  var bridgeSettings = env.extendedSettings && env.extendedSettings.bridge;
  if (!bridgeSettings || !bridgeSettings.userName || !bridgeSettings.password) {
    return { migrated: false, legacy: false };
  }
  if (bridgeUseLegacy(bridgeSettings)) {
    return { migrated: false, legacy: true };
  }

  env.extendedSettings.connect = env.extendedSettings.connect || { };
  if (!env.extendedSettings.connect.source) {
    env.extendedSettings.connect.source = 'dexcomshare';
  }
  if (env.extendedSettings.connect.source !== 'dexcomshare') {
    return { migrated: false, legacy: false };
  }

  env.extendedSettings.connect.shareAccountName = env.extendedSettings.connect.shareAccountName || bridgeSettings.userName;
  env.extendedSettings.connect.sharePassword = env.extendedSettings.connect.sharePassword || bridgeSettings.password;
  if (!env.extendedSettings.connect.shareRegion && !env.extendedSettings.connect.shareServer && bridgeSettings.server) {
    if (String(bridgeSettings.server).toUpperCase() === 'EU') {
      env.extendedSettings.connect.shareRegion = 'ous';
    } else {
      env.extendedSettings.connect.shareServer = bridgeSettings.server;
    }
  }

  return { migrated: true, legacy: false };
}

module.exports = {
  applyBridgeToConnectCompatibility,
  bridgeUseLegacy
};
