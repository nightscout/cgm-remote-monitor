'use strict';

const MongoClient = require('mongodb-legacy').MongoClient;

const mongo = {
  client: null,
  db: null,
};

const DEFAULT_POOL_SIZE = 5;
const LEGACY_POOL_SIZE = 100;

function getPoolOptions(env) {
  const poolSize = env.mongo_pool_size 
    ? parseInt(env.mongo_pool_size, 10) 
    : DEFAULT_POOL_SIZE;
  
  const minPoolSize = env.mongo_min_pool_size 
    ? parseInt(env.mongo_min_pool_size, 10) 
    : 0;
  
  const maxIdleTimeMS = env.mongo_max_idle_time_ms 
    ? parseInt(env.mongo_max_idle_time_ms, 10) 
    : 30000;

  return {
    maxPoolSize: poolSize,
    minPoolSize: minPoolSize,
    maxIdleTimeMS: maxIdleTimeMS,
  };
}

function setupPoolMonitoring(client, env) {
  if (!env.mongo_pool_debug) return;

  console.log('[MONGO_POOL_DEBUG] Connection pool monitoring enabled');

  client.on('connectionPoolCreated', (event) => {
    console.log('[MONGO_POOL] Pool created:', JSON.stringify(event.options));
  });

  client.on('connectionCreated', (event) => {
    console.log('[MONGO_POOL] Connection created:', event.connectionId);
  });

  client.on('connectionClosed', (event) => {
    console.log('[MONGO_POOL] Connection closed:', event.connectionId, 'reason:', event.reason);
  });

  client.on('connectionCheckOutStarted', () => {
    console.log('[MONGO_POOL] Connection checkout started');
  });

  client.on('connectionCheckOutFailed', (event) => {
    console.log('[MONGO_POOL] Connection checkout failed:', event.reason);
  });

  client.on('connectionCheckedOut', (event) => {
    console.log('[MONGO_POOL] Connection checked out:', event.connectionId);
  });

  client.on('connectionCheckedIn', (event) => {
    console.log('[MONGO_POOL] Connection checked in:', event.connectionId);
  });
}

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

      const poolOptions = getPoolOptions(env);
      console.log('Setting up new connection to MongoDB with pool options:', poolOptions);
      
      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        ...poolOptions,
      };

      const connect_with_retry = async function (i) {

        mongo.client = new MongoClient(env.storageURI, options);
        setupPoolMonitoring(mongo.client, env);
        
        try {
          await mongo.client.connect();

          console.log('Successfully established connection to MongoDB');

          const dbName = mongo.client.s.options.dbName;
          mongo.db = mongo.client.db(dbName);

          const result = await mongo.db.command({ connectionStatus: 1 });
          const roles = result.authInfo.authenticatedUserRoles;
          if (roles && roles.length > 0 && roles[0].role == 'readAnyDatabase') {
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
module.exports.DEFAULT_POOL_SIZE = DEFAULT_POOL_SIZE;
module.exports.LEGACY_POOL_SIZE = LEGACY_POOL_SIZE;
module.exports.getPoolOptions = getPoolOptions;
