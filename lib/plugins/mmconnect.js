/* jshint node: true */
'use strict';

var _ = require('lodash'),
  connect = require('minimed-connect-to-nightscout');

function init (env, entries) {
  if (env.extendedSettings.mmconnect && env.extendedSettings.mmconnect.userName && env.extendedSettings.mmconnect.password) {
    return {run: makeRunner_(env, entries)};
  } else {
    console.info('MiniMed Connect not enabled');
    return null;
  }
}

function makeRunner_ (env, entries) {
  var options = getOptions_(env);

  var client = connect.carelink.Client(options);
  connect.logger.setVerbose(options.verbose);

  var handleData = makeHandler_(entries, options.storeRawData);

  return function run () {
    setInterval(function() {
      client.fetch(handleData);
    }, options.interval);
  };
}

function getOptions_ (env) {
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

function makeHandler_ (entries, storeRawData) {
  return function handleCarelinkData (err, data) {
    if (err) {
      console.error('MiniMed Connect error: ' + err);
    } else {
      var transformed = connect.transform(data);

      if (storeRawData && transformed.length) {
        transformed.push(rawDataEntry_(data));
      }

      entries.create(transformed, function afterCreate (err) {
        if (err) {
          console.error('MiniMed Connect storage error: ' + err);
        }
      });
    }
  };
}

function rawDataEntry_ (data) {
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
  , makeRunner_: makeRunner_
  , getOptions_: getOptions_
  , makeHandler_: makeHandler_
  , rawDataEntry_: rawDataEntry_
};
