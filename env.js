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

  if (readENV('APPSETTING_ScmType') == readENV('ScmType') && readENV('ScmType') == 'GitHub') {
    env.head = require('./scm-commit-id.json');
    console.log("SCM COMMIT ID", env.head);
  } else {
    git.short(function record_git_head (head) {
      console.log("GIT HEAD", head);
      env.head = head || readENV('SCM_COMMIT_ID') || readENV('COMMIT_HASH', '');
    });
  }
  env.version = software.version;
  env.name = software.name;
  env.DISPLAY_UNITS = readENV('DISPLAY_UNITS', 'mg/dl');
  env.PORT = readENV('PORT', 1337);
  env.mongo = readENV('MONGO_CONNECTION') || readENV('MONGO') || readENV('MONGOLAB_URI');
  env.mongo_collection = readENV('MONGO_COLLECTION', 'entries');
  env.MQTT_MONITOR = readENV('MQTT_MONITOR', null);
  if (env.MQTT_MONITOR) {
    var hostDbCollection = [env.mongo.split('mongodb://').pop().split('@').pop( ), env.mongo_collection].join('/');
    var mongoHash = crypto.createHash('sha1');
    mongoHash.update(hostDbCollection);
    //some MQTT servers only allow the client id to be 23 chars
    env.mqtt_client_id = mongoHash.digest('base64').substring(0, 23);
    console.info('Using Mongo host/db/collection to create the default MQTT client_id', hostDbCollection);
    if (env.MQTT_MONITOR.indexOf('?clientId=') == -1) {
      console.info('Set MQTT client_id to: ', env.mqtt_client_id);
    } else {
      console.info('MQTT configured to use a custom client id, it will override the default: ', env.mqtt_client_id);
    }
  }
  env.settings_collection = readENV('MONGO_SETTINGS_COLLECTION', 'settings');
  env.treatments_collection = readENV('MONGO_TREATMENTS_COLLECTION', 'treatments');
  env.profile_collection = readENV('MONGO_PROFILE_COLLECTION', 'profile');
  env.devicestatus_collection = readENV('MONGO_DEVICESTATUS_COLLECTION', 'devicestatus');

  env.enable = readENV('ENABLE', "");

  env.defaults = { // currently supported keys must defined be here
    'units': 'mg/dL'
    , 'timeFormat': '12'
    , 'nightMode': false
    , 'showRawbg': 'never'
    , 'customTitle': 'Nightscout'
    , 'theme': 'default'
    , 'alarmUrgentHigh': true
    , 'alarmHigh': true
    , 'alarmLow': true
    , 'alarmUrgentLow': true
    , 'alarmTimeAgoWarn': true
    , 'alarmTimeAgoWarnMins': 15
    , 'alarmTimeAgoUrgent': true
    , 'alarmTimeAgoUrgentMins': 30
    , 'language': 'en' // not used yet
  } ;

  // add units from separate variable
  env.defaults.units = env.DISPLAY_UNITS;
 
  // Highest priority per line defaults
  env.defaults.timeFormat = readENV('TIME_FORMAT', env.defaults.timeFormat);
  env.defaults.nightMode = readENV('NIGHT_MODE', env.defaults.nightMode);
  env.defaults.showRawbg = readENV('SHOW_RAWBG', env.defaults.showRawbg);
  env.defaults.customTitle = readENV('CUSTOM_TITLE', env.defaults.customTitle);
  env.defaults.theme = readENV('THEME', env.defaults.theme);
  env.defaults.alarmUrgentHigh = readENV('ALARM_URGENT_HIGH', env.defaults.alarmUrgentHigh);
  env.defaults.alarmHigh = readENV('ALARM_HIGH', env.defaults.alarmHigh);
  env.defaults.alarmLow = readENV('ALARM_LOW', env.defaults.alarmLow);
  env.defaults.alarmUrgentLow = readENV('ALARM_URGENT_LOW', env.defaults.alarmUrgentLow);
  env.defaults.alarmTimeAgoWarn = readENV('ALARM_TIMEAGO_WARN', env.defaults.alarmTimeAgoWarn);
  env.defaults.alarmTimeAgoWarnMins = readENV('ALARM_TIMEAGO_WARN_MINS', env.defaults.alarmTimeAgoWarnMins);
  env.defaults.alarmTimeAgoUrgent = readENV('ALARM_TIMEAGO_URGENT', env.defaults.alarmTimeAgoUrgent);
  env.defaults.alarmTimeAgoUrgentMins = readENV('ALARM_TIMEAGO_URGENT_MINS', env.defaults.alarmTimeAgoUrgentMins);

  //console.log(JSON.stringify(env.defaults));
  
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

  //NOTE: using +/- 1 here to make the thresholds look visibly wrong in the UI
  //      if all thresholds were set to the same value you should see 4 lines stacked right on top of each other
  if (env.thresholds.bg_target_bottom >= env.thresholds.bg_target_top) {
    console.warn('BG_TARGET_BOTTOM(' + env.thresholds.bg_target_bottom + ') was >= BG_TARGET_TOP(' + env.thresholds.bg_target_top + ')');
    env.thresholds.bg_target_bottom = env.thresholds.bg_target_top - 1;
    console.warn('BG_TARGET_BOTTOM is now ' + env.thresholds.bg_target_bottom);
  }

  if (env.thresholds.bg_target_top <= env.thresholds.bg_target_bottom) {
    console.warn('BG_TARGET_TOP(' + env.thresholds.bg_target_top + ') was <= BG_TARGET_BOTTOM(' + env.thresholds.bg_target_bottom + ')');
    env.thresholds.bg_target_top = env.thresholds.bg_target_bottom + 1;
    console.warn('BG_TARGET_TOP is now ' + env.thresholds.bg_target_top);
  }

  if (env.thresholds.bg_low >= env.thresholds.bg_target_bottom) {
    console.warn('BG_LOW(' + env.thresholds.bg_low + ') was >= BG_TARGET_BOTTOM(' + env.thresholds.bg_target_bottom + ')');
    env.thresholds.bg_low = env.thresholds.bg_target_bottom - 1;
    console.warn('BG_LOW is now ' + env.thresholds.bg_low);
  }

  if (env.thresholds.bg_high <= env.thresholds.bg_target_top) {
    console.warn('BG_HIGH(' + env.thresholds.bg_high + ') was <= BG_TARGET_TOP(' + env.thresholds.bg_target_top + ')');
    env.thresholds.bg_high = env.thresholds.bg_target_top + 1;
    console.warn('BG_HIGH is now ' + env.thresholds.bg_high);
  }

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

  if (typeof value === 'string' && value.toLowerCase() == 'on') value = true;
  if (typeof value === 'string' && value.toLowerCase() == 'off') value = false;

  return value != null ? value : defaultValue;
}

module.exports = config;
