'use strict';

function applyMmconnectToConnectCompatibility(env) {
  const legacy = env.extendedSettings && env.extendedSettings.mmconnect;
  if (!legacy || !legacy.userName || !legacy.password) return {migrated: false};
  const connect = {...env.extendedSettings.connect};
  if (connect.source && connect.source !== 'minimedcarelink') {
    return {migrated: false, error: 'The legacy MiniMed mmconnect bridge was retired in Nightscout 15.0.9. MMCONNECT credentials cannot run alongside a different CONNECT_SOURCE. Select minimedcarelink or migrate MiniMed ingestion to a separate uploader, then remove the obsolete MMCONNECT credentials.'};
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
    return {migrated: false, error: 'The legacy MiniMed mmconnect bridge was retired in Nightscout 15.0.9. Set CONNECT_COUNTRY_CODE to the two-letter country where the CareLink account was created before enabling its Nightscout Connect replacement. The country cannot be inferred from MMCONNECT_SERVER.'};
  }
  env.extendedSettings.connect = connect;
  return {migrated: true};
}

module.exports = {applyMmconnectToConnectCompatibility};
