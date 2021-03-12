'use strict';

const _each = require('lodash/each');
const _trim = require('lodash/trim');
const _forIn = require('lodash/forIn');
const _startsWith = require('lodash/startsWith');
const _camelCase = require('lodash/camelCase');
const enclave = require('./enclave');

const mongoParser = require('mongo-url-parser');

const stringEntropy = require('fast-password-entropy')

const fs = require('fs');
const crypto = require('crypto');
const consts = require('../constants');

const env = {
  settings: require('../settings')()
};

var shadowEnv;

// Module to constrain all config and environment parsing to one spot.
// See README.md for info about all the supported ENV VARs
function config () {

  // Assume users will typo whitespaces into keys and values

  shadowEnv = {};

  Object.keys(process.env).forEach((key, index) => {
    shadowEnv[_trim(key)] = _trim(process.env[key]);
  });

  env.PORT = readENV('PORT', 1337);
  env.HOSTNAME = readENV('HOSTNAME', null);
  env.IMPORT_CONFIG = readENV('IMPORT_CONFIG', null);
  env.static_files = readENV('NIGHTSCOUT_STATIC_FILES', '/static');
  env.debug = {
    minify: readENVTruthy('DEBUG_MINIFY', true)
  };

  env.err = [];
  env.notifies = [];
  env.enclave = enclave();

  setSSL();
  setStorage();
  setAPISecret();
  setVersion();
  updateSettings();

  return env;
}

function setSSL () {
  env.SSL_KEY = readENV('SSL_KEY');
  env.SSL_CERT = readENV('SSL_CERT');
  env.SSL_CA = readENV('SSL_CA');
  env.ssl = false;
  if (env.SSL_KEY && env.SSL_CERT) {
    env.ssl = {
      key: fs.readFileSync(env.SSL_KEY)
      , cert: fs.readFileSync(env.SSL_CERT)
    };
    if (env.SSL_CA) {
      env.ca = fs.readFileSync(env.SSL_CA);
    }
  }

  env.insecureUseHttp = readENVTruthy("INSECURE_USE_HTTP", false);
  env.secureHstsHeader = readENVTruthy("SECURE_HSTS_HEADER", true);
  env.secureHstsHeaderIncludeSubdomains = readENVTruthy("SECURE_HSTS_HEADER_INCLUDESUBDOMAINS", false);
  env.secureHstsHeaderPreload = readENVTruthy("SECURE_HSTS_HEADER_PRELOAD", false);
  env.secureCsp = readENVTruthy("SECURE_CSP", false);
  env.secureCspReportOnly = readENVTruthy("SECURE_CSP_REPORT_ONLY", false);
}

// A little ugly, but we don't want to read the secret into a var
function setAPISecret () {
  var useSecret = (readENV('API_SECRET') && readENV('API_SECRET').length > 0);
  //TODO: should we clear API_SECRET from process env?
  env.api_secret = null;
  // if a passphrase was provided, get the hex digest to mint a single token
  if (useSecret) {
    if (readENV('API_SECRET').length < consts.MIN_PASSPHRASE_LENGTH) {
      var msg = ['API_SECRET should be at least', consts.MIN_PASSPHRASE_LENGTH, 'characters'].join(' ');
      console.error(msg);
      env.err.push({ desc: msg });
    } else {

      const apiSecret = readENV('API_SECRET');
      delete process.env.API_SECRET;

      env.enclave.setApiKey(apiSecret);
      var testresult = stringEntropy(apiSecret);

      console.log('API_SECRET has', testresult, 'bits of entropy');

      if (testresult < 60) {
        env.notifies.push({ persistent: true, title: 'Security issue', message: 'Weak API_SECRET detected. Please use a mix of small and CAPITAL letters, numbers and non-alphanumeric characters such as !#%&/ to reduce the risk of unauthorized access. The minimum length of the API_SECRET is 12 characters.' });
      }

      if (env.storageURI) {
        const parsedURL = mongoParser(env.storageURI);
        if (parsedURL.auth && parsedURL.auth.password == apiSecret) {
          env.notifies.push({ persistent: true, title: 'Security issue', message: 'MongoDB password and API_SECRET match. This is a really bad idea. Please change both and do not reuse passwords across the system.' });
        }
      }

    }
  }
}

function setVersion () {
  var software = require('../../package.json');
  env.version = software.version;
  env.name = software.name;
}

function setStorage () {
  env.storageURI = readENV('STORAGE_URI') || readENV('MONGO_CONNECTION') || readENV('MONGO') || readENV('MONGOLAB_URI') || readENV('MONGODB_URI');
  env.entries_collection = readENV('ENTRIES_COLLECTION') || readENV('MONGO_COLLECTION', 'entries');
  env.authentication_collections_prefix = readENV('MONGO_AUTHENTICATION_COLLECTIONS_PREFIX', 'auth_');
  env.treatments_collection = readENV('MONGO_TREATMENTS_COLLECTION', 'treatments');
  env.profile_collection = readENV('MONGO_PROFILE_COLLECTION', 'profile');
  env.settings_collection = readENV('MONGO_SETTINGS_COLLECTION', 'settings');
  env.devicestatus_collection = readENV('MONGO_DEVICESTATUS_COLLECTION', 'devicestatus');
  env.food_collection = readENV('MONGO_FOOD_COLLECTION', 'food');
  env.activity_collection = readENV('MONGO_ACTIVITY_COLLECTION', 'activity');

  // TODO: clean up a bit
  // Some people prefer to use a json configuration file instead.
  // This allows a provided json config to override environment variables
  var DB = require('../../database_configuration.json')
    , DB_URL = DB.url ? DB.url : env.storageURI
    , DB_COLLECTION = DB.collection ? DB.collection : env.entries_collection;
  env.storageURI = DB_URL;
  env.entries_collection = DB_COLLECTION;
}

function updateSettings () {

  var envNameOverrides = {
    UNITS: 'DISPLAY_UNITS'
  };

  var envDefaultOverrides = {
    DISPLAY_UNITS: 'mg/dl'
  };

  env.settings.eachSettingAsEnv(function settingFromEnv (name) {
    var envName = envNameOverrides[name] || name;
    return readENV(envName, envDefaultOverrides[envName]);
  });

  //should always find extended settings last
  env.extendedSettings = findExtendedSettings(shadowEnv);

  if (!readENVTruthy('TREATMENTS_AUTH', true)) {
    env.settings.authDefaultRoles = env.settings.authDefaultRoles || "";
    env.settings.authDefaultRoles += ' careportal';
  }
}

function readENV (varName, defaultValue) {
  //for some reason Azure uses this prefix, maybe there is a good reason
  var value = shadowEnv['CUSTOMCONNSTR_' + varName] ||
    shadowEnv['CUSTOMCONNSTR_' + varName.toLowerCase()] ||
    shadowEnv[varName] ||
    shadowEnv[varName.toLowerCase()];

  if (varName == 'DISPLAY_UNITS') {
    if (value && value.toLowerCase().includes('mmol')) {
      value = 'mmol';
    } else {
      value = defaultValue;
    }
  }

  return value != null ? value : defaultValue;
}

function readENVTruthy (varName, defaultValue) {
  var value = readENV(varName, defaultValue);
  if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; } else if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; } else { value = defaultValue }
  return value;
}

function findExtendedSettings (envs) {
  var extended = {};

  extended.devicestatus = {};
  extended.devicestatus.advanced = true;
  extended.devicestatus.days = 1;
  if (shadowEnv['DEVICESTATUS_DAYS'] && shadowEnv['DEVICESTATUS_DAYS'] == '2') extended.devicestatus.days = 1;

  function normalizeEnv (key) {
    return key.toUpperCase().replace('CUSTOMCONNSTR_', '');
  }

  _each(env.settings.enable, function eachEnable (enable) {
    if (_trim(enable)) {
      _forIn(envs, function eachEnvPair (value, key) {
        var env = normalizeEnv(key);
        if (_startsWith(env, enable.toUpperCase() + '_')) {
          var split = env.indexOf('_');
          if (split > -1 && split <= env.length) {
            var exts = extended[enable] || {};
            extended[enable] = exts;
            var ext = _camelCase(env.substring(split + 1).toLowerCase());
            if (!isNaN(value)) { value = Number(value); }
            if (typeof value === 'string' && (value.toLowerCase() === 'on' || value.toLowerCase() === 'true')) { value = true; }
            if (typeof value === 'string' && (value.toLowerCase() === 'off' || value.toLowerCase() === 'false')) { value = false; }
            exts[ext] = value;
          }
        }
      });
    }
  });
  return extended;
}

module.exports = config;
