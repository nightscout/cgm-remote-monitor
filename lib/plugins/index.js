'use strict';

var _ = require('lodash');

function init (ctx) {

  var allPlugins = []
    , enabledPlugins = [];

  function plugins(name) {
    if (name) {
      return _.find(allPlugins, {name: name});
    } else {
      return plugins;
    }
  }

  plugins.base = require('./pluginbase');

  var clientDefaultPlugins = [
    require('./bgnow')(ctx)
    , require('./rawbg')(ctx)
    , require('./direction')(ctx)
    , require('./timeago')(ctx)
    , require('./upbat')(ctx)
    , require('./ar2')(ctx)
    , require('./errorcodes')(ctx)
    , require('./iob')(ctx)
    , require('./cob')(ctx)
    , require('./careportal')(ctx)
    , require('./pump')(ctx)
    , require('./openaps')(ctx)
    , require('./loop')(ctx)
    , require('./boluswizardpreview')(ctx)
    , require('./cannulaage')(ctx)
    , require('./sensorage')(ctx)
    , require('./insulinage')(ctx)
    , require('./basalprofile')(ctx)
    , require('./boluscalc')(ctx)  // fake plugin to show/hide
    , require('./profile')(ctx)    // fake plugin to hold extended settings
  ];

  var serverDefaultPlugins = [
    require('./bgnow')(ctx)
    , require('./rawbg')(ctx)
    , require('./direction')(ctx)
    , require('./upbat')(ctx)
    , require('./ar2')(ctx)
    , require('./simplealarms')(ctx)
    , require('./errorcodes')(ctx)
    , require('./iob')(ctx)
    , require('./cob')(ctx)
    , require('./pump')(ctx)
    , require('./openaps')(ctx)
    , require('./loop')(ctx)
    , require('./boluswizardpreview')(ctx)
    , require('./cannulaage')(ctx)
    , require('./sensorage')(ctx)
    , require('./insulinage')(ctx)
    , require('./treatmentnotify')(ctx)
    , require('./timeago')(ctx)
    , require('./basalprofile')(ctx)
  ];

  plugins.registerServerDefaults = function registerServerDefaults() {
    plugins.register(serverDefaultPlugins);
    return plugins;
  };

  plugins.registerClientDefaults = function registerClientDefaults() {
    plugins.register(clientDefaultPlugins);
    return plugins;
  };

  plugins.register = function register(all) {
    _.each(all, function eachPlugin(plugin) {
      allPlugins.push(plugin);
    });

    enabledPlugins = [];

    var enable = _.get(ctx, 'settings.enable');
    function isEnabled(plugin) {
      //TODO: unify client/server env/app
      return enable && enable.indexOf(plugin.name) > -1;
    }

    _.each(allPlugins, function eachPlugin(plugin) {
      plugin.enabled = isEnabled(plugin);
      if (plugin.enabled) {
        enabledPlugins.push(plugin);
      }
    });

  };

  plugins.eachPlugin = function eachPlugin(f) {
    _.each(allPlugins, f);
  };

  plugins.eachEnabledPlugin = function eachEnabledPlugin(f) {
    _.each(enabledPlugins, f);
  };

  //these plugins are either always on or have custom settings
  plugins.specialPlugins = 'ar2 bgnow delta direction timeago upbat rawbg errorcodes profile';

  plugins.shownPlugins = function(sbx) {
    return _.filter(enabledPlugins, function filterPlugins(plugin) {
      return plugins.specialPlugins.indexOf(plugin.name) > -1 || (sbx && sbx.showPlugins && sbx.showPlugins.indexOf(plugin.name) > -1);
    });
  };

  plugins.eachShownPlugins = function eachShownPlugins(sbx, f) {
    _.each(plugins.shownPlugins(sbx), f);
  };

  plugins.hasShownType = function hasShownType(pluginType, sbx) {
    return _.find(plugins.shownPlugins(sbx), function findWithType(plugin) {
      return plugin.pluginType === pluginType;
    }) !== undefined;
  };

  plugins.setProperties = function setProperties(sbx) {
    plugins.eachEnabledPlugin(function eachPlugin (plugin) {
      if (plugin.setProperties) {
        plugin.setProperties(sbx.withExtendedSettings(plugin));
      }
    });
  };

  plugins.checkNotifications = function checkNotifications(sbx) {
    plugins.eachEnabledPlugin(function eachPlugin (plugin) {
      if (plugin.checkNotifications) {
        plugin.checkNotifications(sbx.withExtendedSettings(plugin));
      }
    });
  };

  plugins.updateVisualisations = function updateVisualisations(sbx) {
    plugins.eachShownPlugins(sbx, function eachPlugin(plugin) {
      if (plugin.updateVisualisation) {
        plugin.updateVisualisation(sbx.withExtendedSettings(plugin));
      }
    });
  };

  plugins.getAllEventTypes = function getAllEventTypes(sbx) {
    var all = [];
    plugins.eachEnabledPlugin(function eachPlugin(plugin) {
      if (plugin.getEventTypes) {
        var eventTypes = plugin.getEventTypes(sbx.withExtendedSettings(plugin));
        if (_.isArray(eventTypes)) {
          all = all.concat(eventTypes);
        }
      }
    });

    return all;
  };

  plugins.enabledPluginNames = function enabledPluginNames() {
    return _.map(enabledPlugins, function mapped(plugin) {
      return plugin.name;
    }).join(' ');
  };

  plugins.extendedClientSettings = function extendedClientSettings (allExtendedSettings) {
    var clientSettings = {};
    _.each(clientDefaultPlugins, function eachClientPlugin (plugin) {
      clientSettings[plugin.name] = allExtendedSettings[plugin.name];
    });

    //HACK:  include devicestatus
    clientSettings.devicestatus = allExtendedSettings.devicestatus;

    return clientSettings;
  };

  return plugins();

}

module.exports = init;
