'use strict';

const { MongoClient, MongoCompatibilityError } = require('mongodb');
const DRIVER_VERSION = 'mongodb ' + require('mongodb/package.json').version;
const mongoClientConfiguration = require('./mongo-client-configuration');
const tenantScope = require('./tenant-scope');

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

// Wire protocol versions of releases older than the driver's minimum, to name
// the release in the message.
const WIRE_VERSION_RELEASES = { 6: '3.6', 7: '4.0', 8: '4.2' };

// A server the driver will not talk to fails server selection like an
// unreachable one, but waiting will not fix it. The driver records the cause
// on the server's description as a MongoCompatibilityError.
function incompatibleServer(err) {
  if (!err || err.name !== 'MongoServerSelectionError' || !err.reason || !err.reason.servers) {
    return null;
  }
  for (const server of err.reason.servers.values()) {
    if (server && server.error instanceof MongoCompatibilityError) {
      return server;
    }
  }
  return null;
}

function incompatibleServerMessage(server) {
  const detail = server.error.message || '';
  // The driver states the server's wire version only inside its message, so
  // the release named here is read from that text; detection above is not.
  const match = /maximum wire version (\d+)/.exec(detail);
  const release = match && WIRE_VERSION_RELEASES[match[1]];
  const reports = match
    ? 'reports wire version ' + match[1] + (release ? ' (MongoDB ' + release + ')' : '')
    : 'was refused by the MongoDB driver';
  return 'The MongoDB server at ' + server.address + ' ' + reports +
    '. The MongoDB driver (' + DRIVER_VERSION + ') refuses it: ' + detail;
}

function wrapConnectionError(err) {
  if (err && err.name === 'MongoReadOnlyConnectionError') {
    return err;
  }

  const incompatible = incompatibleServer(err);
  if (incompatible) {
    const error = new Error(incompatibleServerMessage(incompatible));
    error.name = 'MongoIncompatibleServerError';
    return error;
  }

  if (err && err.message && err.message.includes('AuthenticationFailed')) {
    return new Error('MongoDB authentication failed! Double check the URL has the right username and password in MONGODB_URI.');
  }

  return new Error('MONGODB_URI seems invalid: ' + err.message);
}

function isRetryableConnectionError(err) {
  return !!(err && err.name === 'MongoServerSelectionError' && !(err.message && err.message.includes('AuthenticationFailed')) && !incompatibleServer(err));
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

        // eslint-disable-next-line no-constant-condition -- Success returns; fatal errors throw; retryable failures keep retrying.
        while (true) {
          let client = null;

          try {
            const configuration = mongoClientConfiguration(env.storageURI, options);
            client = new MongoClient(configuration.uri, configuration.options);
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
              console.error('Unable to use MongoDB: ' + wrappedError.message);
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

  // The tenant scope of the storage interface (lib/storage/tenant-scope.js).
  // On MongoDB it binds and opens no transaction: a standalone mongod cannot
  // start one, so the interface does not promise atomicity across operations.
  mongo.withTenant = tenantScope.withTenant;
  mongo.SINGLE_TENANT = tenantScope.SINGLE_TENANT;

  // Resolves once every requested index exists or has failed. A failure is
  // logged and never rejects: a missing index makes queries slower, not wrong.
  //
  // The indexes for one collection go to MongoDB as one createIndexes
  // command, built together. Requested one at a time they queue behind
  // each other: MongoDB 7.0 and later run only three index builds at once.
  // If the combined command fails, each index is retried on its own so one
  // bad definition does not cost the others.
  mongo.ensureIndexes = function ensureIndexes(collection, fields) {
    const seen = new Set();
    const unique = fields.filter(function (field) {
      const fieldName = typeof field === 'string' ? field : JSON.stringify(field);
      if (seen.has(fieldName)) return false;
      seen.add(fieldName);
      console.info('ensuring index for: ' + collection.collectionName + '.' + fieldName);
      return true;
    });

    function oneAtATime () {
      return Promise.all(unique.map(function (field) {
        const fieldName = typeof field === 'string' ? field : JSON.stringify(field);
        const name = collection.collectionName + "." + fieldName;
        return Promise.resolve(collection.createIndex(field)).catch(function (err) {
          console.error('unable to ensureIndex for: ' + name + ' - ' + err);
        });
      }));
    }

    if (unique.length < 2 || typeof collection.createIndexes !== 'function') {
      return oneAtATime();
    }

    const specs = unique.map(function (field) {
      return { key: typeof field === 'string' ? { [field]: 1 } : field };
    });
    return Promise.resolve(collection.createIndexes(specs)).catch(function (err) {
      console.warn('unable to create the indexes for ' + collection.collectionName + ' together, trying one at a time - ' + err);
      return oneAtATime();
    });
  };

  return maybe_connect(cb);
}

module.exports = init;
module.exports.DEFAULT_POOL_SIZE = DEFAULT_POOL_SIZE;
module.exports.LEGACY_POOL_SIZE = LEGACY_POOL_SIZE;
module.exports.getPoolOptions = getPoolOptions;
module.exports.getRetryDelay = getRetryDelay;
module.exports.isRetryableConnectionError = isRetryableConnectionError;
