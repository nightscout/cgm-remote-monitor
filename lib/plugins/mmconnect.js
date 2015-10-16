/* jshint node: true */
'use strict';

var connect = require('minimed-connect-to-nightscout');

var init = module.exports.init = function(env, entries) {
  if (env.extendedSettings.mmconnect && env.extendedSettings.mmconnect.username && env.extendedSettings.mmconnect.password) {
    return {run: makeRunner_(env, entries)};
  } else {
    console.info('MiniMed Connect not enabled');
    return null;
  }
};

var makeRunner_ = module.exports.makeRunner_ = function(env, entries) {
  var options = getOptions_(env);

  var client = connect.carelink.Client(options);
  connect.logger.setVerbose(options.verbose);

  var handleData = makeHandler_(entries, options.storeRawData);

  return function() {
    setInterval(function() {
      client.fetch(handleData);
    }, options.interval);
  };
};

var getOptions_ = module.exports.getOptions_ = function(env) {
  return {
    username: env.extendedSettings.mmconnect.username,
    password: env.extendedSettings.mmconnect.password,
    sgvLimit: parseInt(env.extendedSettings.mmconnect.sgvLimit || 24, 10),
    interval: parseInt(env.extendedSettings.mmconnect.interval || 60*1000, 10),
    maxRetryDuration: parseInt(env.extendedSettings.mmconnect.maxRetryDuration || 32, 10),
    verbose: !!env.extendedSettings.mmconnect.verbose,

    // TODO(@mddub|2015-10-15): remove
    // This is a temporary config variable to enable beta testers to store raw
    // CareLink JSON in Mongo so we can learn what values it can contain.
    storeRawData: !!env.extendedSettings.mmconnect.storeRawData
  };
};

var makeHandler_ = module.exports.makeHandler_ = function(entries, storeRawData) {
  return function(err, data) {
    if (err) {
      console.error('MiniMed Connect error: ' + err);
    } else {
      var transformed = connect.transform(data);

      // TODO(@mddub|2015-10-15): remove
      if (storeRawData && transformed.length) {

        // redact PII
        data['firstName'] = data['lastName'] = data['medicalDeviceSerialNumber'] = '<redacted>';

        // trim the default 288 sgvs returned by carelink
        if (data['sgs'] && data['sgs'] instanceof Array) {
          console.log(data['sgs'].length);
          data['sgs'] = data['sgs'].slice(0, 6);
          console.log(data['sgs'].length);
        }

        transformed.push({
          'date': transformed[0]['date'],
          'type': 'carelink_raw',
          'data': data
        });
      }

      entries.create(transformed, function(err) {
        if (err) {
          console.error('MiniMed Connect storage error: ' + err);
        }
      });
    }
  };
};
