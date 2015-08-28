'use strict';

var _ = require('lodash');

function init() {

  var properties = {}
    , allPlugins = [
        require('./daytoday')()
      , require('./dailystats')()
      , require('./glucosedistribution')()
      , require('./hourlystats')()
      , require('./percentile')()
      , require('./success')()
      , require('./calibrations')()
      , require('./treatments')()
    ];

  function plugins(name) {
    if (name) {
      return _.find(allPlugins, {name: name});
    } else {
      return plugins;
    }
  }

  plugins.eachPlugin = function eachPlugin(f) {
    _.each(allPlugins, f);
  };

  plugins.setProperty = function setProperty(p, val) {
    properties[p] = val;
  };

  plugins.getProperty = function getProperty(p) {
    return properties[p];
  };

  plugins.utils = require('./utils')();

  return plugins();

}

module.exports = init;