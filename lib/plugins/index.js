'use strict';

var _ = require('lodash')
  , PluginBase = require('./pluginbase')(); // Define any shared functionality in this class

function init() {

  var allPlugins = []
    , enabledPlugins = [];

  function plugins() {
    return plugins;
  }

  plugins.registerDefaults = function registerDefaults() {
    plugins.register([
      require('./iob')(),
      require('./cob')(),
      require('./boluswizardpreview')(),
      require('./cannulaage')()
    ])
  };

  plugins.register = function register(all) {
    _.forEach(all, function eachPlugin(plugin) {
      _.extend(plugin, PluginBase);
      allPlugins.push(plugin);
    });
  };

  plugins.clientInit = function clientInit(app) {
    enabledPlugins = [];
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
  };

  plugins.eachPlugin = function eachPlugin(f) {
    _.forEach(allPlugins, f);
  };

  plugins.eachEnabledPlugin = function eachEnabledPlugin(f) {
    _.forEach(enabledPlugins, f);
  };

  plugins.shownPlugins = function(clientSettings) {
    return _.filter(enabledPlugins, function filterPlugins(plugin) {
      return clientSettings && clientSettings.showPlugins && clientSettings.showPlugins.indexOf(plugin.name) > -1;
    });
  };

  plugins.eachShownPlugins = function eachShownPlugins(clientSettings, f) {
    _.forEach(plugins.shownPlugins(clientSettings), f);
  };

  plugins.hasShownType = function hasShownType(pluginType, clientSettings) {
    return _.find(plugins.shownPlugins(clientSettings), function findWithType(plugin) {
      return plugin.pluginType == pluginType;
    }) != undefined;
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