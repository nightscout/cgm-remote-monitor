'use strict';

// DEXCOM_BRIDGE_USE_LEGACY selected the removed share2nightscout-bridge. It can
// no longer be honoured, so it is detected only to say that it is ignored.
function legacyBridgeRequested (bridgeSettings) {
  return !!(bridgeSettings && (bridgeSettings.useLegacy === true || bridgeSettings.dexcomBridgeUseLegacy === true)) ||
    String(process.env.DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true' ||
    String(process.env.CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY || '').toLowerCase() === 'true';
}

var LEGACY_OVERRIDE_IGNORED = 'DEXCOM_BRIDGE_USE_LEGACY is no longer supported and is ignored: the legacy Dexcom bridge has been removed, and BRIDGE_* credentials are served by Nightscout Connect. Remove DEXCOM_BRIDGE_USE_LEGACY from your settings.';

function conflictingSource (source) {
  return 'The legacy Dexcom bridge has been removed. Its BRIDGE_* settings are now served by Nightscout Connect, which reads one source per site, and Nightscout Connect is already set to a different CONNECT_SOURCE (' + source + '). '
    + 'To keep ' + source + ', remove the BRIDGE_* settings and bridge from ENABLE. '
    + 'To use Dexcom Share instead, set CONNECT_SOURCE=dexcomshare.';
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

  env.extendedSettings.connect = env.extendedSettings.connect || { };
  if (!env.extendedSettings.connect.source) {
    env.extendedSettings.connect.source = 'dexcomshare';
  }
  if (env.extendedSettings.connect.source !== 'dexcomshare') {
    return { migrated: false, error: conflictingSource(env.extendedSettings.connect.source) };
  }

  env.extendedSettings.connect.shareAccountName = env.extendedSettings.connect.shareAccountName || bridgeSettings.userName;
  env.extendedSettings.connect.sharePassword = env.extendedSettings.connect.sharePassword || bridgeSettings.password;
  if (!env.extendedSettings.connect.shareRegion && !env.extendedSettings.connect.shareServer) {
    Object.assign(env.extendedSettings.connect, bridgeServerToConnect(bridgeSettings.server));
  }

  return { migrated: true, legacy: false };
}

module.exports = {
  applyBridgeToConnectCompatibility
  , bridgeServerToConnect
  , legacyBridgeRequested
  , LEGACY_OVERRIDE_IGNORED
};
