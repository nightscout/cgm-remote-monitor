
var env = { };
var crypto = require('crypto');
function config ( ) {

  env.PORT = process.env.PORT || 1337;
  env.mongo = process.env.MONGO_CONNECTION || process.env.CUSTOMCONNSTR_mongo;
  env.mongo_collection = process.env.CUSTOMCONNSTR_mongo_collection;
  env.settings_collection = process.env.CUSTOMCONNSTR_mongo_settings_collection || 'settings';
  var shasum = crypto.createHash('sha1');
  var useSecret = (process.env.API_SECRET && process.env.API_SECRET.length > 0);
  env.api_secret = null;
  if (useSecret) {
    shasum.update(process.env.API_SECRET);
    env.api_secret = shasum.digest('hex');
  }
  return env;
}
module.exports = config;
