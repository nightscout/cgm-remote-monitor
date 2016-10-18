'use strict';

var _ = require('lodash');
var fs = require('fs');
var crypto = require('crypto');
var MongoMock = require('mongomock');

var config = {
  collections: {}
};

function init (env, callback) {

  var configPath = env.storageURI.split('openaps://').pop();
  console.info('>>>openaps config path', configPath);

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
        wrapper.findQuery = query;
        collection.find(query);
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
        collection.toArray(function intercept (err, results) {
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

          console.info('>>>toArray', name, wrapper.findQuery, wrapper.sortQuery, wrapper.limitCount, results.length);

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


module.exports = init;
