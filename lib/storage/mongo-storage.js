'use strict';

const MongoClient = require('mongodb').MongoClient;

const mongo = {
  client: null,
  db: null,
};

const DEFAULT_POOL_SIZE = 5;
const LEGACY_POOL_SIZE = 100;

function getRetryDelay(attempt) {
  return attempt > 15 ? 60000 : attempt * 3000;
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

async function closeClient(client) {
  if (!client || typeof client.close !== 'function') {
    return;
  }

  try {
    await client.close();
  } catch (err) {
    console.log('Error closing failed MongoDB client: %j', err);
  }
}

function wrapConnectionError(err) {
  if (err && err.name === 'MongoReadOnlyConnectionError') {
    return err;
  }

  if (err && err.message && err.message.includes('AuthenticationFailed')) {
    return new Error('MongoDB authentication failed! Double check the URL has the right username and password in MONGODB_URI.');
  }

  return new Error('MONGODB_URI seems invalid: ' + err.message);
}

function isRetryableConnectionError(err) {
  return !!(err && err.name === 'MongoServerSelectionError' && !(err.message && err.message.includes('AuthenticationFailed')));
}

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

      return Promise.resolve(mongo);
    } else {
      if (!env.storageURI) {
        throw new Error('MongoDB connection string is missing. Please set MONGODB_URI environment variable');
      }

      const poolOptions = getPoolOptions(env);
      console.log('Setting up new connection to MongoDB with pool options:', poolOptions);
      
      const options = {
        ...poolOptions,
      };

      const connectWithRetry = async function () {
        let attempt = 1;

        if (forceNewConnection) {
          const previousClient = mongo.client;
          mongo.client = null;
          mongo.db = null;
          await closeClient(previousClient);
        }

        while (true) {
          let client = null;

          try {
            client = new MongoClient(env.storageURI, options);
            mongo.client = client;
            setupPoolMonitoring(client, env);

            await client.connect();

            console.log('Successfully established connection to MongoDB');

            mongo.db = client.db();

            const result = await mongo.db.command({ connectionStatus: 1 });
            const roles = result.authInfo.authenticatedUserRoles;
            if (roles && roles.length > 0 && roles[0].role == 'readAnyDatabase') {
              console.error('Mongo user is read only');
              const readOnlyError = new Error('MongoDB connection is in read only mode! Go back to MongoDB configuration and check your database user has read and write access.');
              readOnlyError.name = 'MongoReadOnlyConnectionError';
              throw readOnlyError;
            }

            console.log('Mongo user role seems ok:', roles);
            return mongo;
          } catch (err) {
            const retryable = isRetryableConnectionError(err);
            const wrappedError = wrapConnectionError(err);

            if (err && err.message && err.message.includes('AuthenticationFailed')) {
              console.log('Authentication to Mongo failed');
            }

            mongo.db = null;
            if (mongo.client === client) {
              mongo.client = null;
            }

            await closeClient(client);

            if (!retryable) {
              throw wrappedError;
            }

            const timeout = getRetryDelay(attempt);
            console.log('Error connecting to MongoDB: %j - retrying in ' + timeout / 1000 + ' sec', err);
            await wait(timeout);
            attempt += 1;
          }
        }
      };

      const promise = connectWithRetry();

      if (cb && cb.call) {
        promise.then(function (store) {
          cb(null, store);
        }, function (err) {
          cb(err, null);
        });
      }

      return promise;

    }
  }

  mongo.collection = function get_collection(name) {
    return mongo.db.collection(name);
  };

  mongo.ensureIndexes = function ensureIndexes(collection, fields) {
    fields.forEach(function (field) {
      const fieldName = typeof field === 'string' ? field : JSON.stringify(field);
      const name = collection.collectionName + "." + fieldName;
      console.info('ensuring index for: ' + name);
      collection.createIndex(field).catch(function (err) {
        console.error('unable to ensureIndex for: ' + name + ' - ' + err);
      });
    });
  };

  return maybe_connect(cb);
}

module.exports = init;
module.exports.DEFAULT_POOL_SIZE = DEFAULT_POOL_SIZE;
module.exports.LEGACY_POOL_SIZE = LEGACY_POOL_SIZE;
module.exports.getPoolOptions = getPoolOptions;
module.exports.getRetryDelay = getRetryDelay;
