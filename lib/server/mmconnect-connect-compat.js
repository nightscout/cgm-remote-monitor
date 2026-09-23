'use strict';

// The legacy MiniMed bridge is removed. Its settings are migrated to Nightscout
// Connect when that is possible without guessing; otherwise the boot error names
// the settings that fix it. CONNECT_* settings are only read when connect is in
// ENABLE, so every fix that sets one also says to add connect to ENABLE.
function conflictingSource (source) {
  return 'The legacy MiniMed CareLink bridge (mmconnect) has been removed. Its MMCONNECT_* settings are now served by Nightscout Connect, which reads one source per site, and Nightscout Connect is already set to a different CONNECT_SOURCE (' + source + ', from CONNECT_SOURCE or from BRIDGE_* Dexcom settings). '
    + 'To keep ' + source + ', remove the MMCONNECT_* settings and mmconnect from ENABLE. '
    + 'To use MiniMed CareLink instead, remove the other source\'s settings, add connect to ENABLE, and set CONNECT_SOURCE=minimedcarelink and CONNECT_COUNTRY_CODE.';
}

const MISSING_COUNTRY = 'The legacy MiniMed CareLink bridge (mmconnect) has been removed. Its MMCONNECT_* settings are now served by Nightscout Connect, which needs the two-letter country where the CareLink account was created; it cannot be worked out from MMCONNECT_SERVER. '
  + 'Add connect to ENABLE and set CONNECT_COUNTRY_CODE to that country.';

function applyMmconnectToConnectCompatibility(env) {
  const legacy = env.extendedSettings && env.extendedSettings.mmconnect;
  if (!legacy || !legacy.userName || !legacy.password) return {migrated: false};
  const connect = {...env.extendedSettings.connect};
  if (connect.source && connect.source !== 'minimedcarelink') {
    return {migrated: false, error: conflictingSource(connect.source)};
  }
  connect.source = 'minimedcarelink';
  connect.carelinkUsername = connect.carelinkUsername || legacy.userName;
  connect.carelinkPassword = connect.carelinkPassword || legacy.password;
  if (!connect.carelinkRegion && !connect.carelinkServer && legacy.server) {
    const region = String(legacy.server).toLowerCase();
    if (region === 'eu' || region === 'us') connect.carelinkRegion = region;
    else connect.carelinkServer = legacy.server;
  }
  if (!connect.countryCode) {
    return {migrated: false, error: MISSING_COUNTRY};
  }
  env.extendedSettings.connect = connect;
  return {migrated: true};
}

module.exports = {applyMmconnectToConnectCompatibility};
