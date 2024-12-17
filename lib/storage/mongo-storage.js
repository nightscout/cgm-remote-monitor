'use strict';

const MongoClient = require('mongodb-legacy').MongoClient;

const mongo = {
  client: null,
  db: null,
};

function init(env, cb, forceNewConnection) {

  function maybe_connect(cb) {

    if (mongo.db != null && !forceNewConnection) {
      console.log('Reusing MongoDB connection handler');
      // If there is a valid callback, then return the Mongo-object

      if (cb && cb.call) {
        cb(null, mongo);
      }
    } else {
      if (!env.storageURI) {
        throw new Error('MongoDB connection string is missing. Please set MONGODB_URI environment variable');
      }

      console.log('Setting up new connection to MongoDB');
      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      };

      const connect_with_retry = async function (i) {

        mongo.client = new MongoClient(env.storageURI, options);
        try {
          await mongo.client.connect();

          console.log('Successfully established connection to MongoDB');

          const dbName = mongo.client.s.options.dbName;
          mongo.db = mongo.client.db(dbName);

          const result = await mongo.db.command({ connectionStatus: 1 });
          const roles = result.authInfo.authenticatedUserRoles;
          if (roles.length > 0 && roles[0].role == 'readAnyDatabase') {
            console.error('Mongo user is read only');
            cb(new Error('MongoDB connection is in read only mode! Go back to MongoDB configuration and check your database user has read and write access.'), null);
          }

          console.log('Mongo user role seems ok:', roles);

          // If there is a valid callback, then invoke the function to perform the callback
          if (cb && cb.call) {
            cb(null, mongo);
          }
        } catch (err) {
          if (err.message && err.message.includes('AuthenticationFailed')) {
            console.log('Authentication to Mongo failed');
            cb(new Error('MongoDB authentication failed! Double check the URL has the right username and password in MONGODB_URI.'), null);
            return;
          }

          if (err.name && err.name === "MongoServerSelectionError") {
            const timeout = (i > 15) ? 60000 : i * 3000;
            console.log('Error connecting to MongoDB: %j - retrying in ' + timeout / 1000 + ' sec', err);
            setTimeout(connect_with_retry, timeout, i + 1);
            if (i == 1) cb(new Error('MongoDB connection failed! Double check the MONGODB_URI setting in Heroku.'), null);
          } else {
            cb(new Error('MONGODB_URI seems invalid: ' + err.message));
          }
        }
      };

      return connect_with_retry(1);

    }
  }

  mongo.collection = function get_collection(name) {
    return mongo.db.collection(name);
  };

  mongo.ensureIndexes = function ensureIndexes(collection, fields) {
    fields.forEach(function (field) {
      const name = collection.collectionName + "." + field;
      console.info('ensuring index for: ' + name);
      collection.createIndex(field, { 'background': true }, function (err) {
        if (err) {
          console.error('unable to ensureIndex for: ' + name + ' - ' + err);
        }
      });
    });
  };

  return maybe_connect(cb);
}

module.exports = init;
