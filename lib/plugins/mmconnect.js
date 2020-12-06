/* jshint node: true */
'use strict';

var _ = require('lodash'),
  connect = require('minimed-connect-to-nightscout');

function init (env, entries) {
  if (env.extendedSettings.mmconnect && env.extendedSettings.mmconnect.userName && env.extendedSettings.mmconnect.password) {
    return {run: makeRunner(env, entries)};
  } else {
    console.info('MiniMed Connect not enabled');
    return null;
  }
}

function makeRunner (env, entries) {
  var options = getOptions(env);

  var client = connect.carelink.Client(options);
  connect.logger.setVerbose(options.verbose);

  var handleData = makeHandler_(entries, options.sgvLimit, makeRecentSgvFilter(), options.storeRawData);

  return function run () {
    setInterval(function() {
      client.fetch(handleData);
    }, options.interval);
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

function makeHandler_ (entries, sgvLimit, filter, storeRawData) {
  return function handleCarelinkData (err, data) {
    if (err) {
      console.error('MiniMed Connect error: ' + err);
    } else {
      var transformed = connect.transform(data, sgvLimit);

      if (storeRawData && transformed.length) {
        transformed.push(rawDataEntry(data));
      }

      // If we blindly upsert the SGV entries, we will lose trend data for
      // entries we've already stored, since all SGVs from CareLink except
      // the most recent are missing trend data.
      var filtered = filter(transformed);

      entries.create(filtered, function afterCreate (err) {
        if (err) {
          console.error('MiniMed Connect storage error: ' + err);
        }
      });
    }
  };
}

function makeRecentSgvFilter () {
  var lastSgvDate = 0;

  return function filter (entries) {
    var out = [];

    entries.forEach(function(entry) {
      if (entry['type'] !== 'sgv' || entry['date'] > lastSgvDate) {
        out.push(entry);
      }
    });

    out.filter(function(e) { return e['type'] === 'sgv'; })
      .forEach(function(e) {
        lastSgvDate = Math.max(lastSgvDate, e['date']);
      });

    return out;
  };
}

function rawDataEntry (data) {
  var cleansed = _.cloneDeep(data);

  // redact PII
  cleansed['firstName'] = cleansed['lastName'] = cleansed['medicalDeviceSerialNumber'] = '<redacted>';

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

module.exports = {
  init: init
  // exposed for testing
  , getOptions: getOptions
  , makeRecentSgvFilter: makeRecentSgvFilter
  , rawDataEntry: rawDataEntry
};
