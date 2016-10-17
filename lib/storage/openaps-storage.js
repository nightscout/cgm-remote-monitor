'use strict';

var _ = require('lodash');
var MongoMock = require('mongomock');

var config = {
  collections: {}
};

function init (env, callback) {

  var configPath = env.storageURI.split('openaps://').pop();
  console.info('>>>openaps config path', configPath);

  function reportAsCollection (name) {
    var data = { };
    var inputPath = _.get(config, 'collections.' + name + '.input.path');

    try {
      var inputData = require(inputPath);
      if (_.isArray(inputData)) {
        data[name] = inputData;
      } else if (!_.isEmpty(inputData) && _.isObject(inputData)) {
        data[name] = [ inputData ];
      } else {
        data[name] = [ ];
      }
    } catch (err) {
      data[name] = [ ];
      console.error('unable to find input data for', name, inputPath);
    }

    var mock = new MongoMock(data);

    var collection = mock.collection(name);

    var wrapper = {
      find: function find (query) {
        collection.find(query);
        return wrapper;
      }
      , limit: function limit (count) {
        //TODO: figure out how to limit
        console.info('>>>limit', count);
        return wrapper;
      }
      , sort: function sort (query) {
        //TODO: figure out how to sort
        console.info('>>>sort', query);
        return wrapper;
      }
      , toArray: function toArray(callback) {
        collection.toArray(callback);
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


module.exports = init;
