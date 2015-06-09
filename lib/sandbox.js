var utils = require('./utils');

function init ( ) {
  var sbx = {};

  function init() {
    sbx.properties = [];
  }

  /**
   * Initialize the sandbox using server state
   *
   * @param env - .js
   * @param ctx - created from bootevent
   * @returns {{sbx}}
   */
  sbx.serverInit = function serverInit(env, ctx) {
    init();

    sbx.time = Date.now();
    sbx.units = env.DISPLAY_UNITS;
    sbx.defaults = env.defaults;
    sbx.thresholds = env.thresholds;
    sbx.alarm_types = env.alarm_types;
    sbx.data = ctx.data.clone();

    //Plugins will expect the right profile based on time
    sbx.data.profile = data.profiles.length > 0 ? data.profiles[0] : undefined;
    delete sbx.data.profiles;

    sbx.properties = [];

    return sbx;
  };

  /**
   * Initialize the sandbox using client state
   *
   * @param app - app settings
   * @param clientSettings - specific settings from the client, starting with the defaults
   * @param time - could be a retro time
   * @param pluginBase - used by visualization plugins to update the UI
   * @param data - svgs, treatments, profile, etc
   * @returns {{sbx}}
   */
  sbx.clientInit = function clientInit(app, clientSettings, time, pluginBase, data) {
    init();

    sbx.units = clientSettings.units;
    sbx.defaults = clientSettings; //TODO: strip out extra stuff
    sbx.thresholds = app.thresholds;
    sbx.alarm_types = clientSettings.alarm_types;
    sbx.showPlugins = clientSettings.showPlugins;
    sbx.time = time;
    sbx.data = data;
    sbx.pluginBase = pluginBase;

    return sbx;
  };

  /**
   * Properties are immutable, first plugin to set it wins, plugins should be in the correct order
   *
   * @param name
   * @param setter
   */
  sbx.offerProperty = function offerProperty(name, setter) {
    if (!sbx.properties.hasOwnProperty(name)) {
      var value = setter();
      if (value) {
        sbx.properties[name] = value;
      }
    }
  };

  return sbx;
}

module.exports = init;

