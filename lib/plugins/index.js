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

  // `ENABLE` is matched against the registered plugin name, and for these
  // plugins that is not the name of the file that defines them. An operator who
  // writes the file name gets no plugin, no warning and a site that looks fine,
  // so keep the mapping here and use it to say what was probably meant.
  // `tests/plugins.test.js` fails if a plugin is added whose file name differs
  // from its registered name without an entry here.
  plugins.moduleNameAliases = {
    boluswizardpreview: 'bwp'
    , cannulaage: 'cage'
    , sensorage: 'sage'
    , insulinage: 'iage'
    , batteryage: 'bage'
    , basalprofile: 'basal'
  };

  var warnedEnableEntries = {};

  function editDistance (a, b) {
    var prev = [];
    var i;
    for (i = 0; i <= b.length; i++) prev[i] = i;
    for (i = 1; i <= a.length; i++) {
      var current = [i];
      for (var j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          prev[j] + 1
          , current[j - 1] + 1
          , prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)
        );
      }
      prev = current;
    }
    return prev[b.length];
  }

  // Only suggest when there is a plausible intended plugin. `ENABLE` also
  // carries features that are not plugins at all (`delta`, `devicestatus`,
  // `food`, `cors`, `bridge`), and plugins that are registered only on the
  // other side of the client/server split, so warning on every unmatched entry
  // would be noise on a stock install.
  function suggestPluginName (entry) {
    if (Object.prototype.hasOwnProperty.call(plugins.moduleNameAliases, entry)) {
      return plugins.moduleNameAliases[entry];
    }

    var best = null;

    // Two edits is half of a four-letter word, and `ENABLE` carries several of
    // those (`food` is two edits from `loop`, `cors` two from `cob`), so scale
    // the tolerance with the length of the entry.
    var tolerance = entry.length > 4 ? 2 : 1;

    function consider (candidate, pluginName) {
      if (!candidate) return;
      var distance = editDistance(entry, candidate);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { name: pluginName, distance: distance };
      }
    }

    Object.keys(plugins.moduleNameAliases).forEach(function eachAlias (alias) {
      consider(alias, plugins.moduleNameAliases[alias]);
    });
    allPlugins.forEach(function eachPlugin (plugin) {
      consider(plugin.name, plugin.name);
    });

    return best && best.name;
  }

  function warnAboutUnmatchedEnableEntries (enable) {
    var entries = Array.isArray(enable) ? enable : String(enable).split(/\s+/);

    entries.forEach(function eachEntry (entry) {
      if (!entry || warnedEnableEntries[entry]) return;
      if (allPlugins.some(function matches (plugin) { return plugin.name === entry; })) return;

      var suggestion = suggestPluginName(entry);
      if (!suggestion) return;

      warnedEnableEntries[entry] = true;
      console.warn('ENABLE lists "' + entry + '", which is not a plugin name, so nothing was enabled for it. Did you mean "' + suggestion + '"?');
    });
  }

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

    if (enable) {
      warnAboutUnmatchedEnableEntries(enable);
    }
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
