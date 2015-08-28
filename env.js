'use strict';

var _ = require('lodash');
var fs = require('fs');
var crypto = require('crypto');
var consts = require('./lib/constants');

var env = {
  settings: require('./lib/settings')()
};

// Module to constrain all config and environment parsing to one spot.
// See the
function config ( ) {
  /*
   * See README.md for info about all the supported ENV VARs
   */
  env.DISPLAY_UNITS = readENV('DISPLAY_UNITS', 'mg/dl');
  env.PORT = readENV('PORT', 1337);
  env.baseUrl = readENV('BASE_URL');
  env.static_files = readENV('NIGHTSCOUT_STATIC_FILES', __dirname + '/static/');

  setSSL();
  setAPISecret();
  setVersion();
  setMongo();
  updateSettings();

  return env;
}

function setSSL() {
  env.SSL_KEY = readENV('SSL_KEY');
  env.SSL_CERT = readENV('SSL_CERT');
  env.SSL_CA = readENV('SSL_CA');
  env.ssl = false;
  if (env.SSL_KEY && env.SSL_CERT) {
    env.ssl = {
      key: fs.readFileSync(env.SSL_KEY), cert: fs.readFileSync(env.SSL_CERT)
    };
    if (env.SSL_CA) {
      env.ca = fs.readFileSync(env.SSL_CA);
    }
  }
}

// A little ugly, but we don't want to read the secret into a var
function setAPISecret() {
  var useSecret = (readENV('API_SECRET') && readENV('API_SECRET').length > 0);
  //TODO: should we clear API_SECRET from process env?
  env.api_secret = null;
  // if a passphrase was provided, get the hex digest to mint a single token
  if (useSecret) {
    if (readENV('API_SECRET').length < consts.MIN_PASSPHRASE_LENGTH) {
      var msg = ['API_SECRET should be at least', consts.MIN_PASSPHRASE_LENGTH, 'characters'];
      throw new Error(msg.join(' '));
    }
    var shasum = crypto.createHash('sha1');
    shasum.update(readENV('API_SECRET'));
    env.api_secret = shasum.digest('hex');
  }
}

function setVersion() {
  var software = require('./package.json');
  var git = require('git-rev');

  if (readENV('APPSETTING_ScmType') === readENV('ScmType') && readENV('ScmType') === 'GitHub') {
    env.head = require('./scm-commit-id.json');
    console.log('SCM COMMIT ID', env.head);
  } else {
    git.short(function record_git_head(head) {
      console.log('GIT HEAD', head);
      env.head = head || readENV('SCM_COMMIT_ID') || readENV('COMMIT_HASH', '');
    });
  }
  env.version = software.version;
  env.name = software.name;
}

function setMongo() {
  env.mongo = readENV('MONGO_CONNECTION') || readENV('MONGO') || readENV('MONGOLAB_URI');
  env.mongo_collection = readENV('MONGO_COLLECTION', 'entries');
  env.MQTT_MONITOR = readENV('MQTT_MONITOR', null);
  if (env.MQTT_MONITOR) {
    var hostDbCollection = [env.mongo.split('mongodb://').pop().split('@').pop(), env.mongo_collection].join('/');
    var mongoHash = crypto.createHash('sha1');
    mongoHash.update(hostDbCollection);
    //some MQTT servers only allow the client id to be 23 chars
    env.mqtt_client_id = mongoHash.digest('base64').substring(0, 23);
    console.info('Using Mongo host/db/collection to create the default MQTT client_id', hostDbCollection);
    if (env.MQTT_MONITOR.indexOf('?clientId=') === -1) {
      console.info('Set MQTT client_id to: ', env.mqtt_client_id);
    } else {
      console.info('MQTT configured to use a custom client id, it will override the default: ', env.mqtt_client_id);
    }
  }
  env.treatments_collection = readENV('MONGO_TREATMENTS_COLLECTION', 'treatments');
  env.profile_collection = readENV('MONGO_PROFILE_COLLECTION', 'profile');
  env.devicestatus_collection = readENV('MONGO_DEVICESTATUS_COLLECTION', 'devicestatus');

  // TODO: clean up a bit
  // Some people prefer to use a json configuration file instead.
  // This allows a provided json config to override environment variables
  var DB = require('./database_configuration.json'),
    DB_URL = DB.url ? DB.url : env.mongo,
    DB_COLLECTION = DB.collection ? DB.collection : env.mongo_collection;
  env.mongo = DB_URL;
  env.mongo_collection = DB_COLLECTION;
}

function updateSettings() {

  var envNameOverrides = {
    UNITS: 'DISPLAY_UNITS'
  };

  env.settings.eachSettingAsEnv(function settingFromEnv (name) {
    var envName = envNameOverrides[name] || name;
    return readENV(envName);
  });

  //should always find extended settings last
  env.extendedSettings = findExtendedSettings(process.env);
}

function readENV(varName, defaultValue) {
  //for some reason Azure uses this prefix, maybe there is a good reason
  var value = process.env['CUSTOMCONNSTR_' + varName]
    || process.env['CUSTOMCONNSTR_' + varName.toLowerCase()]
    || process.env[varName]
    || process.env[varName.toLowerCase()];

  if (typeof value === 'string' && value.toLowerCase() === 'on') { value = true; }
  if (typeof value === 'string' && value.toLowerCase() === 'off') { value = false; }

  return value != null ? value : defaultValue;
}

function findExtendedSettings (envs) {
  var extended = {};

  function normalizeEnv (key) {
    return key.toUpperCase().replace('CUSTOMCONNSTR_', '');
  }

  _.each(env.settings.enable, function eachEnable(enable) {
    if (_.trim(enable)) {
      _.forIn(envs, function eachEnvPair (value, key) {
        var env = normalizeEnv(key);
        if (_.startsWith(env, enable.toUpperCase() + '_')) {
          var split = env.indexOf('_');
          if (split > -1 && split <= env.length) {
            var exts = extended[enable] || {};
            extended[enable] = exts;
            var ext = _.camelCase(env.substring(split + 1).toLowerCase());
            if (!isNaN(value)) { value = Number(value); }
            exts[ext] = value;
          }
        }
      });
    }
  });
  return extended;
}

module.exports = config;
