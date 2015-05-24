'use strict';

var _ = require('lodash')
  , inherits = require("inherits")
  , PluginBase = require('./pluginbase') // Define any shared functionality in this class
  , allPlugins = []
  , enabledPlugins = [];

function register(all) {

  allPlugins = [];

  for (var p in all) {
    if (all.hasOwnProperty(p)) {
      var plugin = all[p](PluginBase);

      inherits(plugin, PluginBase);
      plugin.name = p;

      for (var n in PluginBase.prototype) {
        if (PluginBase.prototype.hasOwnProperty(n)) {
          plugin[n] = PluginBase.prototype[n];
        }
      }
      allPlugins.push(plugin);
    }
  }

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

function updateVisualisations() {
  _.forEach(enabledPlugins, function eachPlugin(plugin) {
    plugin.updateVisualisation && plugin.updateVisualisation();
  });
}

function eachPlugin(f) {
  _.forEach(allPlugins, f);
}

function eachEnabledPlugin(f) {
    _.forEach(enabledPlugins, f);
}

function plugins() {
  plugins.register = register;
  plugins.clientInit = clientInit;
  plugins.setEnv = setEnv;
  plugins.updateVisualisations = updateVisualisations;
  plugins.eachPlugin = eachPlugin;
  plugins.eachEnabledPlugin = eachEnabledPlugin;
  return plugins;
}

module.exports = plugins;