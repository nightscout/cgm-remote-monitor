'use strict';

var _ = require('lodash')
  , PluginBase = require('./pluginbase')() // Define any shared functionality in this class
  , allPlugins = []
  , enabledPlugins = [];

function register(all) {

  allPlugins = [];

  _.forIn(all, function eachPlugin(plugin, name) {
    plugin.name = name;
    _.extend(plugin, PluginBase);
    allPlugins.push(plugin);
  });

}

function clientInit(app) {
  enabledPlugins = [];
  console.info('NightscoutPlugins init', app);
  function isEnabled(plugin) {
    return app.enabledOptions
      && app.enabledOptions.indexOf(plugin.name) > -1;
  }

  _.forEach(allPlugins, function eachPlugin(plugin) {
    plugin.enabled = isEnabled(plugin);
    if (plugin.enabled) {
      enabledPlugins.push(plugin);
    }
  });
  console.info('Plugins enabled', enabledPlugins);
}

function setEnv(env) {
  _.forEach(enabledPlugins, function eachPlugin(plugin) {
    plugin.setEnv(env);
  });
}

function updateVisualisations(clientSettings) {
  eachShownPlugin(clientSettings, function eachPlugin(plugin) {
    plugin.updateVisualisation && plugin.updateVisualisation();
  });
}

function eachPlugin(f) {
  _.forEach(allPlugins, f);
}

function eachEnabledPlugin(f) {
  _.forEach(enabledPlugins, f);
}

function eachShownPlugin(clientSettings, f) {
  var filtered = _.filter(enabledPlugins, function filterPlugins(plugin) {
    return clientSettings && clientSettings.showPlugins && clientSettings.showPlugins.indexOf(plugin.name) > -1;
  });

  _.forEach(filtered, f);
}

function enabledPluginNames() {
  return _.map(enabledPlugins, function mapped(plugin) {
    return plugin.name;
  }).join(' ');
}

function plugins() {
  return {
    register: register
    , clientInit: clientInit
    , setEnv: setEnv
    , updateVisualisations: updateVisualisations
    , eachPlugin: eachPlugin
    , eachEnabledPlugin: eachEnabledPlugin
    , eachShownPlugin: eachShownPlugin
    , enabledPluginNames: enabledPluginNames
  }
}

module.exports = plugins;