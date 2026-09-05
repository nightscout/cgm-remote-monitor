'use strict';

function init (ctx) {

  var allPlugins = []
    , enabledPlugins = [];
  function plugins (name) {
    if (name) {
      return allPlugins.find(plugin => plugin.name === name);
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
    , require('./xdripjs')(ctx)
    , require('./loop')(ctx)
    , require('./override')(ctx)
    , require('./boluswizardpreview')(ctx)
    , require('./cannulaage')(ctx)
    , require('./sensorage')(ctx)
    , require('./insulinage')(ctx)
    , require('./batteryage')(ctx)
    , require('./basalprofile')(ctx)
    , require('./bolus')(ctx) // fake plugin to hold extended settings
    , require('./boluscalc')(ctx) // fake plugin to show/hide
    , require('./profile')(ctx) // fake plugin to hold extended settings
    , require('./speech')(ctx)
    , require('./dbsize')(ctx)
  ];

  /*
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
    , require('./xdripjs')(ctx)
    , require('./loop')(ctx)
    , require('./boluswizardpreview')(ctx)
    , require('./cannulaage')(ctx)
    , require('./sensorage')(ctx)
    , require('./insulinage')(ctx)
    , require('./batteryage')(ctx)
    , require('./treatmentnotify')(ctx)
    , require('./timeago')(ctx)
    , require('./basalprofile')(ctx)
    , require('./dbsize')(ctx)
    , require('./runtimestate')(ctx)
    , require('./webhook')(ctx) // NEW: Webhook plugin to send SGV updates to a local server address (e.g. Raspberry Pi)
  ];
*/

  function getServerDefaultPlugins () {
    var plugins = [
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
      , require('./xdripjs')(ctx)
      , require('./loop')(ctx)
      , require('./boluswizardpreview')(ctx)
      , require('./cannulaage')(ctx)
      , require('./sensorage')(ctx)
      , require('./insulinage')(ctx)
      , require('./batteryage')(ctx)
      , require('./treatmentnotify')(ctx)
      , require('./timeago')(ctx)
      , require('./basalprofile')(ctx)
      , require('./dbsize')(ctx)
      , require('./runtimestate')(ctx)
    ];

  // Only load webhook plugin in Node/server (avoid webpack/browser bundling).
  // NOTE: Use eval('require') so webpack won't statically include './webhook' in the client bundle.
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      var req = eval('require');
      plugins.push(req('./webhook')(ctx));
    }

    return plugins;
  }

  /*
  plugins.registerServerDefaults = function registerServerDefaults () {
    plugins.register(serverDefaultPlugins);
    return plugins;
  };
*/

  plugins.registerServerDefaults = function registerServerDefaults () {
    plugins.register(getServerDefaultPlugins());
    return plugins;
  };
  
  plugins.registerClientDefaults = function registerClientDefaults () {
    plugins.register(clientDefaultPlugins);
    return plugins;
  };

  plugins.register = function register (all) {
    all.forEach(function eachPlugin (plugin) {
      allPlugins.push(plugin);
    });

    enabledPlugins = [];

    var enable = ctx?.settings?.enable;

    function isEnabled (plugin) {
      //TODO: unify client/server env/app
      return enable && enable.indexOf(plugin.name) > -1;
    }

    allPlugins.forEach(function eachPlugin (plugin) {
      plugin.enabled = isEnabled(plugin);
      if (plugin.enabled) {
        enabledPlugins.push(plugin);
      }
    });
  };
  plugins.isPluginEnabled = function isPluginEnabled (pluginName) {
    var p = enabledPlugins.find(plugin => plugin.name === pluginName);
    return (p !== null);
  }

  plugins.getPlugin = function getPlugin (pluginName) {
    return enabledPlugins.find(plugin => plugin.name === pluginName);
  }

  plugins.eachPlugin = function eachPlugin (f) {
    allPlugins.forEach(f);
  };

  plugins.eachEnabledPlugin = function eachEnabledPlugin (f) {
    enabledPlugins.forEach(f);
  };

  //these plugins are either always on or have custom settings
  plugins.specialPlugins = 'ar2 bgnow delta direction timeago upbat rawbg errorcodes profile bolus';
  plugins.shownPlugins = function(sbx) {
    return enabledPlugins.filter(function filterPlugins (plugin) {
      return plugins.specialPlugins.indexOf(plugin.name) > -1 || (sbx && sbx.showPlugins && sbx.showPlugins.indexOf(plugin.name) > -1);
    });
  };

  plugins.eachShownPlugins = function eachShownPlugins (sbx, f) {
    plugins.shownPlugins(sbx).forEach(f);
  };
  plugins.hasShownType = function hasShownType (pluginType, sbx) {
    return plugins.shownPlugins(sbx).find(function findWithType (plugin) {
      return plugin.pluginType === pluginType;
    }) !== undefined;
  };

  plugins.setProperties = function setProperties (sbx) {
    plugins.eachEnabledPlugin(function eachPlugin (plugin) {
      if (plugin.setProperties) {
        try {
          plugin.setProperties(sbx.withExtendedSettings(plugin));
        } catch (error) {
          console.error('Plugin error on setProperties(): ', plugin.name, error);
        }
      }
    });
  };

  plugins.checkNotifications = function checkNotifications (sbx) {
    plugins.eachEnabledPlugin(function eachPlugin (plugin) {
      if (plugin.checkNotifications) {
        try {
          plugin.checkNotifications(sbx.withExtendedSettings(plugin));
        } catch (error) {
          console.error('Plugin error on checkNotifications(): ', plugin.name, error);
        }
      }
    });
  };

  plugins.visualizeAlarm = function visualizeAlarm (sbx, alarm, alarmMessage) {
    plugins.eachShownPlugins(sbx, function eachPlugin (plugin) {
      if (plugin.visualizeAlarm) {
        try {
          plugin.visualizeAlarm(sbx.withExtendedSettings(plugin), alarm, alarmMessage);
        } catch (error) {
          console.error('Plugin error on visualizeAlarm(): ', plugin.name, error);
        }
      }
    });
  };

  plugins.updateVisualisations = function updateVisualisations (sbx) {
    plugins.eachShownPlugins(sbx, function eachPlugin (plugin) {
      if (plugin.updateVisualisation) {
        try {
          plugin.updateVisualisation(sbx.withExtendedSettings(plugin));
        } catch (error) {
          console.error('Plugin error on visualizeAlarm(): ', plugin.name, error);
        }
      }
    });
  };

  plugins.getAllEventTypes = function getAllEventTypes (sbx) {
    var all = [];
    plugins.eachEnabledPlugin(function eachPlugin (plugin) {
      if (plugin.getEventTypes) {
        var eventTypes = plugin.getEventTypes(sbx.withExtendedSettings(plugin));
        if (Array.isArray(eventTypes)) {
          all = all.concat(eventTypes);
        }
      }
    });

    return all;
  };

  plugins.enabledPluginNames = function enabledPluginNames () {
    return enabledPlugins.map(function mapped (plugin) {
      return plugin.name;
    }).join(' ');
  };

  plugins.extendedClientSettings = function extendedClientSettings (allExtendedSettings) {
    var clientSettings = {};
    clientDefaultPlugins.forEach(function eachClientPlugin (plugin) {
      clientSettings[plugin.name] = allExtendedSettings[plugin.name];
    });

    //HACK:  include devicestatus
    clientSettings.devicestatus = allExtendedSettings.devicestatus;

    return clientSettings;
  };

  return plugins();

}

module.exports = init;
