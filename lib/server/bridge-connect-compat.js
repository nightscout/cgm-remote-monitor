'use strict';

function bridgeUseLegacy (bridgeSettings) {
  return bridgeSettings && (bridgeSettings.useLegacy === true || bridgeSettings.dexcomBridgeUseLegacy === true) ||
    String(process.env.DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true' ||
    String(process.env.CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true';
}

// Translate a legacy BRIDGE_SERVER value into nightscout-connect settings.
//
// share2nightscout-bridge treated a value containing a dot as a hostname,
// exactly "EU" as shareous1.dexcom.com, and anything else (unset, "US", ...)
// as share2.dexcom.com.  nightscout-connect instead takes either
// shareRegion ('us' or 'ous', lowercase) or shareServer, a bare hostname
// used as-is.  Passing a region name such as "US" through as shareServer
// makes connect call https://US/..., which never reaches Dexcom.
function bridgeServerToConnect (server) {
  var value = server === undefined || server === null ? '' : String(server).trim();
  // tolerate a scheme or path, connect wants a bare host
  value = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (value.indexOf('.') > 0) {
    return { shareServer: value };
  }
  var region = value.toLowerCase();
  if (region === 'eu' || region === 'ous') {
    return { shareRegion: 'ous' };
  }
  // unset, "US", or any other non-host value: the legacy bridge used the US server
  return { shareRegion: 'us' };
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
  if (!env.extendedSettings.connect.shareRegion && !env.extendedSettings.connect.shareServer) {
    Object.assign(env.extendedSettings.connect, bridgeServerToConnect(bridgeSettings.server));
  }

  return { migrated: true, legacy: false };
}

module.exports = {
  applyBridgeToConnectCompatibility,
  bridgeServerToConnect,
  bridgeUseLegacy
};
