'use strict';

var _ = require('lodash')
  , PluginBase = require('./pluginbase')(); // Define any shared functionality in this class

function init() {

  var allPlugins = []
    , enabledPlugins = [];

  function plugins() {
    return plugins;
  }

  plugins.registerServerDefaults = function registerServerDefaults() {
    plugins.register([ require('./pushnotify')() ]);
    return plugins;
  };

  plugins.registerClientDefaults = function registerClientDefaults() {
    plugins.register([
      require('./iob')(),
      require('./cob')(),
      require('./boluswizardpreview')(),
      require('./cannulaage')()
    ]);
    return plugins;
  };

  plugins.register = function register(all) {
    _.forEach(all, function eachPlugin(plugin) {
      _.extend(plugin, PluginBase);
      allPlugins.push(plugin);
    });
  };

  plugins.init = function init(envOrApp) {
    enabledPlugins = [];
    function isEnabled(plugin) {
      //TODO: unify client/server env/app
      var enable = envOrApp.enabledOptions || envOrApp.enable;
      return enable && enable.indexOf(plugin.name) > -1;
    }

    _.forEach(allPlugins, function eachPlugin(plugin) {
      plugin.enabled = isEnabled(plugin);
      if (plugin.enabled) {
        enabledPlugins.push(plugin);
      }
    });
    return plugins;
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