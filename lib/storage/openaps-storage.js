'use strict';

var _ = require('lodash');
var fs = require('fs');
var crypto = require('crypto');
var MongoMock = require('mongomock');

var config = {
  collections: {}
};

function init (env, callback) {

  if (!env.storageURI || !_.isString(env.storageURI)) {
    throw new Error('openaps config uri is missing or invalid');
  }

  var configPath = env.storageURI.split('openaps://').pop();

  function addId (data) {
    var shasum = crypto.createHash('sha1');
    shasum.update(JSON.stringify(data));
    data._id = shasum.digest('hex');
  }

  function loadData (path) {

    if (!path || !_.isString(path)) {
      return [ ];
    }

    try {
      purgeCache(path);
      var inputData = require(path);
      if (_.isArray(inputData)) {
        //console.info('>>>input is an array', path);
        _.forEach(inputData, addId);
      } else if (!_.isEmpty(inputData) && _.isObject(inputData)) {
        //console.info('>>>input is an object', path);
        inputData.created_at = new Date(fs.statSync(path).mtime).toISOString();
        addId(inputData);
        inputData = [ inputData ];
      } else {
        //console.info('>>>input is something else', path, inputData);
        inputData = [ ];
      }

      return inputData;
    } catch (err) {
      console.error('unable to find input data for', path, err);
      return [ ];
    }

  }

  function reportAsCollection (name) {
    var data = { };
    var input = _.get(config, 'collections.' + name + '.input');

    if (_.isArray(input)) {
      //console.info('>>>input is an array', input);
      data[name] = _.flatten(_.map(input, loadData));
    } else {
      data[name] = loadData(input);
    }

    var mock = new MongoMock(data);

    var collection = mock.collection(name);

    var wrapper = {
      findQuery: null
      , sortQuery: null
      , limitCount: null
      , find: function find (query) {
        query = _.cloneDeepWith(query, function booleanize (value) {
          //TODO: for some reason we're getting {$exists: NaN} instead of true/false
          if (value && _.isObject(value) && '$exists' in value) {
            return {$exists: true};
          }
        });
        wrapper.findQuery = query;
        return wrapper;
      }
      , limit: function limit (count) {
        wrapper.limitCount = count;
        return wrapper;
      }
      , sort: function sort (query) {
        wrapper.sortQuery = query;
        return wrapper;
      }
      , toArray: function toArray(callback) {
        collection.find(wrapper.findQuery).toArray(function intercept (err, results) {
          if (err) {
            return callback(err, results);
          }

          if (wrapper.sortQuery) {
            var field = _.keys(wrapper.sortQuery).pop();
            //console.info('>>>sortField', field);
            if (field) {
              results = _.sortBy(results, field);
              if (-1 === wrapper.sortQuery[field]) {
                //console.info('>>>sort reverse');
                results = _.reverse(results);
              }
            }
          }

          if (wrapper.limitCount !== null && _.isNumber(wrapper.limitCount)) {
            //console.info('>>>limit count', wrapper.limitCount);
            results = _.take(results, wrapper.limitCount);
          }

          //console.info('>>>toArray', name, wrapper.findQuery, wrapper.sortQuery, wrapper.limitCount, results.length);

          callback(null, results);
        });
        return wrapper;
      }
    };

    return wrapper;

  }

  try {
    var customConfig = require(configPath);

    config = _.merge({}, customConfig, config);

    callback(null, {
      collection: reportAsCollection
      , ensureIndexes: _.noop
    });
  } catch (err) {
    callback(err);
  }
}

/**
 * Removes a module from the cache
 *
 * see http://stackoverflow.com/a/14801711
 */
function purgeCache(moduleName) {
  // Traverse the cache looking for the files
  // loaded by the specified module name
  searchCache(moduleName, function (mod) {
    delete require.cache[mod.id];
  });

  // Remove cached paths to the module.
  // Thanks to @bentael for pointing this out.
  Object.keys(module.constructor._pathCache).forEach(function(cacheKey) {
    if (cacheKey.indexOf(moduleName)>0) {
      delete module.constructor._pathCache[cacheKey];
    }
  });
}

/**
 * Traverses the cache to search for all the cached
 * files of the specified module name
 *
 * see http://stackoverflow.com/a/14801711
 */
function searchCache(moduleName, callback) {
  // Resolve the module identified by the specified name
  var mod = require.resolve(moduleName);

  // Check if the module has been resolved and found within
  // the cache
  if (mod && ((mod = require.cache[mod]) !== undefined)) {
    // Recursively go over the results
    (function traverse(mod) {
      // Go over each of the module's children and
      // traverse them
      mod.children.forEach(function (child) {
        traverse(child);
      });

      // Call the specified callback providing the
      // found cached module
      callback(mod);
    }(mod));
  }
}

module.exports = init;
