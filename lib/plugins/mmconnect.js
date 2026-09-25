/* jshint node: true */
'use strict';


function init (env, entries, devicestatus, bus) {
  if (env.extendedSettings.mmconnect && env.extendedSettings.mmconnect.userName && env.extendedSettings.mmconnect.password) {
    var connect = require('minimed-connect-to-nightscout');
    return {run: makeRunner(env, entries, devicestatus, bus, connect)};
  } else {
    console.info('MiniMed Connect not enabled');
    return null;
  }
}

function makeRunner (env, entries, devicestatus, bus, connect) {
  var options = getOptions(env);

  var client = connect.carelink.Client(options);
  connect.logger.setVerbose(options.verbose);

  var handleData = makeHandler_(entries, devicestatus, options.sgvLimit, options.storeRawData, connect);

  return function run () {
    let timer = setInterval(function() {
      client.fetch(handleData);
    }, options.interval);

    if (bus) {
      bus.on('teardown', function serverTeardown () {
        clearInterval(timer);
      });
    }
  };
}

function getOptions (env) {
  return {
    username: env.extendedSettings.mmconnect.userName
    , password: env.extendedSettings.mmconnect.password
    , sgvLimit: parseInt(env.extendedSettings.mmconnect.sgvLimit || 24, 10)
    , interval: parseInt(env.extendedSettings.mmconnect.interval || 60*1000, 10)
    , maxRetryDuration: parseInt(env.extendedSettings.mmconnect.maxRetryDuration || 32, 10)
    , verbose: !!env.extendedSettings.mmconnect.verbose
    , storeRawData: !!env.extendedSettings.mmconnect.storeRawData
  };
}

function makeHandler_ (entries, devicestatus, sgvLimit, storeRawData, connect) {
  var filterSgvs = connect.filter.makeRecencyFilter(function(item) {
    return item['date'];
  });
  var filterDevicestatus = connect.filter.makeRecencyFilter(function(item) {
    return new Date(item['created_at']).getTime();
  });

  return function handleCarelinkData (err, data) {
    if (err) {
      console.error('MiniMed Connect error: ' + err);
    } else {
      var transformed = connect.transform(data, sgvLimit);

      if (storeRawData && (transformed.entries.length || transformed.devicestatus.length)) {
        transformed.entries.push(rawDataEntry(data));
      }

      // If we blindly upsert the SGV entries, we will lose trend data for
      // entries we've already stored, since all SGVs from CareLink except
      // the most recent are missing trend data.
      var filteredSgvs = filterSgvs(transformed.entries);

      // The devicestatus collection doesn't upsert, so we need to avoid
      // duplicates here
      var filteredStatus = filterDevicestatus(transformed.devicestatus);

      // Can't do "bulk" insert, must be done serially
      createMaybe_(entries, filteredSgvs, function() {
        createMaybe_(devicestatus, filteredStatus, () => { });
      });
    }
  };
}

function createMaybe_ (collection, items, callback) {
  if (items.length === 0) {
    callback();
  } else {
    collection.create(items, function afterCreate (err) {
      if (err) {
        console.error('MiniMed Connect storage error: ' + err);
      }
      callback();
    });
  }
}

function rawDataEntry (data) {
  var cleansed = JSON.parse(JSON.stringify(data));

  // redact PII
  cleansed['firstName'] = cleansed['lastName'] = cleansed['medicalDeviceSerialNumber'] = '[redacted]';

  // trim the default 288 sgvs returned by carelink
  if (cleansed['sgs'] && cleansed['sgs'] instanceof Array) {
    cleansed['sgs'] = cleansed['sgs'].slice(Math.max(0, cleansed['sgs'].length - 6));
  }

  var timestamp = data['lastMedicalDeviceDataUpdateServerTime'];
  return {
    'date': timestamp
    , 'dateString': new Date(timestamp).toISOString()
    , 'type': 'carelink_raw'
    , 'data': cleansed
  };
}

// Logged at boot while the legacy bridge runs. It names every setting the
// replacement needs, because the CareLink country cannot be derived from
// MMCONNECT_SERVER and a later release removes this bridge.
var DEPRECATION_WARNING = 'The legacy MiniMed CareLink bridge (MMCONNECT_* settings) is reported not to work and will be removed in a later release. '
  + 'Move to Nightscout Connect: add connect to ENABLE and set CONNECT_SOURCE=minimedcarelink, CONNECT_CARELINK_USERNAME, CONNECT_CARELINK_PASSWORD, CONNECT_CARELINK_REGION and CONNECT_COUNTRY_CODE '
  + '(the two-letter country where the CareLink account was created; it cannot be worked out from MMCONNECT_SERVER). '
  + 'Once readings arrive through Nightscout Connect, remove the MMCONNECT_* settings and mmconnect from ENABLE.';

module.exports = {
  init: init
  , DEPRECATION_WARNING: DEPRECATION_WARNING
  // exposed for testing
  , getOptions: getOptions
  , rawDataEntry: rawDataEntry
};
