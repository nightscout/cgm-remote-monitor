'use strict';

function applyBridgeToConnectCompatibility (env) {
  var bridgeSettings = env.extendedSettings && env.extendedSettings.bridge;
  if (!bridgeSettings || !bridgeSettings.userName || !bridgeSettings.password) {
    return { migrated: false, legacy: false };
  }

  env.extendedSettings.connect = env.extendedSettings.connect || { };
  if (!env.extendedSettings.connect.source) {
    env.extendedSettings.connect.source = 'dexcomshare';
  }
  if (env.extendedSettings.connect.source !== 'dexcomshare') {
    return { migrated: false, error: 'The legacy Dexcom bridge was retired in Nightscout 15.0.9. BRIDGE credentials cannot run alongside a different CONNECT_SOURCE. Select dexcomshare or migrate Dexcom ingestion to a separate uploader, then remove the obsolete BRIDGE credentials.' };
  }

  env.extendedSettings.connect.shareAccountName = env.extendedSettings.connect.shareAccountName || bridgeSettings.userName;
  env.extendedSettings.connect.sharePassword = env.extendedSettings.connect.sharePassword || bridgeSettings.password;
  if (!env.extendedSettings.connect.shareRegion && !env.extendedSettings.connect.shareServer && bridgeSettings.server) {
    if (String(bridgeSettings.server).toUpperCase() === 'EU') {
      env.extendedSettings.connect.shareRegion = 'ous';
    } else if (String(bridgeSettings.server).toUpperCase() === 'US') {
      env.extendedSettings.connect.shareRegion = 'us';
    } else {
      env.extendedSettings.connect.shareServer = bridgeSettings.server;
    }
  }

  return { migrated: true, legacy: false };
}

module.exports = {
  applyBridgeToConnectCompatibility
};
