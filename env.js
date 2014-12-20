'use strict';

var env = { };
var crypto = require('crypto');
var consts = require('./lib/constants');
var fs = require('fs');
// Module to constrain all config and environment parsing to one spot.
function config ( ) {

  /*
   * First inspect a bunch of environment variables:
   *   * PORT - serve http on this port
   *   * MONGO_CONNECTION, CUSTOMCONNSTR_mongo - mongodb://... uri
   *   * CUSTOMCONNSTR_mongo_collection - name of mongo collection with "sgv" documents
   *   * CUSTOMCONNSTR_mongo_settings_collection - name of mongo collection to store configurable settings
   *   * API_SECRET - if defined, this passphrase is fed to a sha1 hash digest, the hex output is used to create a single-use token for API authorization
   *   * NIGHTSCOUT_STATIC_FILES - the "base directory" to use for serving
   *     static files over http.  Default value is the included `static`
   *     directory.
   */
  var software = require('./package.json');
  var git = require('git-rev');

  if (readENV('SCM_GIT_EMAIL') == 'windowsazure' && readENV('ScmType') == 'GitHub') {
    git.cwd('/home/site/repository');
  }
  if (readENV('SCM_COMMIT_ID')) {
    env.head = readENV('SCM_COMMIT_ID');
  } else {
    git.short(function record_git_head (head) {
      console.log("GIT HEAD", head);
      env.head = head;
    });
  }
  env.version = software.version;
  env.name = software.name;

  env.DISPLAY_UNITS = readENV('DISPLAY_UNITS', 'mg/dl');
  env.PORT = readENV('PORT', 1337);
  env.mongo = readENV('MONGO_CONNECTION') || readENV('MONGO') || readENV('MONGOLAB_URI');
  env.mongo_collection = readENV('MONGO_COLLECTION', 'entries');
  env.settings_collection = readENV('MONGO_SETTINGS_COLLECTION', 'settings');
  env.treatments_collection = readENV('MONGO_TREATMENTS_COLLECTION', 'treatments');
  env.devicestatus_collection = readENV('MONGO_DEVICESTATUS_COLLECTION', 'devicestatus');

  env.enable = readENV('ENABLE');
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

  var shasum = crypto.createHash('sha1');

  /////////////////////////////////////////////////////////////////
  // A little ugly, but we don't want to read the secret into a var
  /////////////////////////////////////////////////////////////////
  var useSecret = (readENV('API_SECRET') && readENV('API_SECRET').length > 0);
  env.api_secret = null;
  // if a passphrase was provided, get the hex digest to mint a single token
  if (useSecret) {
    if (readENV('API_SECRET').length < consts.MIN_PASSPHRASE_LENGTH) {
      var msg = ["API_SECRET should be at least", consts.MIN_PASSPHRASE_LENGTH, "characters"];
      var err = new Error(msg.join(' '));
      // console.error(err);
      throw err;
      process.exit(1);
    }
    shasum.update(readENV('API_SECRET'));
    env.api_secret = shasum.digest('hex');
  }

  env.thresholds = {
    bg_high: readIntENV('BG_HIGH', 260)
    , bg_target_top: readIntENV('BG_TARGET_TOP', 180)
    , bg_target_bottom: readIntENV('BG_TARGET_BOTTOM', 80)
    , bg_low: readIntENV('BG_LOW', 55)
  };

  //if any of the BG_* thresholds are set, default to "simple" otherwise default to "predict" to preserve current behavior
  var thresholdsSet = readIntENV('BG_HIGH') || readIntENV('BG_TARGET_TOP') || readIntENV('BG_TARGET_BOTTOM') || readIntENV('BG_LOW');
  env.alarm_types = readENV('ALARM_TYPES') || (thresholdsSet ? "simple" : "predict");

  // For pushing notifications to Pushover.
  env.pushover_api_token = readENV('PUSHOVER_API_TOKEN');
  env.pushover_user_key = readENV('PUSHOVER_USER_KEY') || readENV('PUSHOVER_GROUP_KEY');

  // TODO: clean up a bit
  // Some people prefer to use a json configuration file instead.
  // This allows a provided json config to override environment variables
  var DB = require('./database_configuration.json'),
    DB_URL = DB.url ? DB.url : env.mongo,
    DB_COLLECTION = DB.collection ? DB.collection : env.mongo_collection,
    DB_SETTINGS_COLLECTION = DB.settings_collection ? DB.settings_collection : env.settings_collection;
  env.mongo = DB_URL;
  env.mongo_collection = DB_COLLECTION;
  env.settings_collection = DB_SETTINGS_COLLECTION;
  env.static_files = readENV('NIGHTSCOUT_STATIC_FILES', __dirname + '/static/');

  return env;
}

function readIntENV(varName, defaultValue) {
    return parseInt(readENV(varName)) || defaultValue;
}

function readENV(varName, defaultValue) {
    //for some reason Azure uses this prefix, maybe there is a good reason
    var value = process.env['CUSTOMCONNSTR_' + varName]
        || process.env['CUSTOMCONNSTR_' + varName.toLowerCase()]
        || process.env[varName]
        || process.env[varName.toLowerCase()];

    return value || defaultValue;
}

module.exports = config;
