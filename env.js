'use strict';

var env = { };
var crypto = require('crypto');
var consts = require('./lib/constants');
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

  env.version = software.version;
  env.name = software.name;
  env.DISPLAY_UNITS = process.env.DISPLAY_UNITS || 'mg/dl';
  env.PORT = process.env.PORT || 1337;
  env.mongo = process.env.MONGO_CONNECTION || process.env.CUSTOMCONNSTR_mongo;
  env.mongo_collection = process.env.CUSTOMCONNSTR_mongo_collection || 'entries';
  env.settings_collection = process.env.CUSTOMCONNSTR_mongo_settings_collection || 'settings';
  var shasum = crypto.createHash('sha1');
  var useSecret = (process.env.API_SECRET && process.env.API_SECRET.length > 0);
  env.api_secret = null;
  // if a passphrase was provided, get the hex digest to mint a single token
  if (useSecret) {
    if (process.env.API_SECRET.length < consts.MIN_PASSPHRASE_LENGTH) {
      var msg = ["API_SECRET should be at least", consts.MIN_PASSPHRASE_LENGTH, "characters"];
      var err = new Error(msg.join(' '));
      // console.error(err);
      throw err;
      process.exit(1);
    }
    shasum.update(process.env.API_SECRET);
    env.api_secret = shasum.digest('hex');
  }
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
  var STATIC_FILES = __dirname + '/static/';
  env.static_files = process.env.NIGHTSCOUT_STATIC_FILES || STATIC_FILES;
  return env;
}
module.exports = config;
