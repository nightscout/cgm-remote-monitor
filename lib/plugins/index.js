'use strict';

var _ = require('lodash')
  , PluginBase = require('./pluginbase')(); // Define any shared functionality in this class

function init() {

  var allPlugins = []
    , enabledPlugins = [];

  function plugins() {
    return plugins;
  }

  plugins.register = function register(all) {
    allPlugins = [];

    _.forIn(all, function eachPlugin(plugin, name) {
      if (!plugin.name) plugin.name = name;
      _.extend(plugin, PluginBase);
      allPlugins.push(plugin);
    });
  };

  plugins.clientInit = function clientInit(app) {
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
  };

  plugins.eachPlugin = function eachPlugin(f) {
    _.forEach(allPlugins, f);
  };

  plugins.eachEnabledPlugin = function eachEnabledPlugin(f) {
    _.forEach(enabledPlugins, f);
  };

  plugins.eachShownPlugins = function eachShownPlugins(clientSettings, f) {
    console.info('eachShownPlugins');
    var filtered = _.filter(enabledPlugins, function filterPlugins(plugin) {
      return clientSettings && clientSettings.showPlugins && clientSettings.showPlugins.indexOf(plugin.name) > -1;
    });

    _.forEach(filtered, f);
  };

  plugins.setEnvs = function setEnvs(env) {
    plugins.eachEnabledPlugin(function eachPlugin(plugin) {
      plugin.setEnv(env);
    });
  };

  plugins.updateVisualisations = function updateVisualisations(clientSettings) {
    plugins.eachShownPlugins(clientSettings, function eachPlugin(plugin) {
      plugin.updateVisualisation && plugin.updateVisualisation();
    });
  };

  plugins.enabledPluginNames = function enabledPluginNames() {
    return _.map(enabledPlugins, function mapped(plugin) {
      return plugin.name;
    }).join(' ');
  };

  return plugins();

}

module.exports = init;