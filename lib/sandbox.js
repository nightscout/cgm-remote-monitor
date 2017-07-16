'use strict';

var _ = require('lodash');
var units = require('./units')();
var times = require('./times');

function init ( ) {
  var sbx = {};

  function reset () {
    sbx.properties = [];
  }

  function extend () {
    sbx.unitsLabel = unitsLabel();
    sbx.data = sbx.data || {};
    //default to prevent adding checks everywhere
    sbx.extendedSettings = {empty: true};
  }

  function withExtendedSettings(plugin, allExtendedSettings, sbx) {
    var sbx2 = _.extend({}, sbx);
    sbx2.extendedSettings = allExtendedSettings && allExtendedSettings[plugin.name] || {};
    return sbx2;
  }

  /**
   * A view into the safe notification functions for plugins
   *
   * @param ctx
   * @returns  {{notification}}
   */
  function safeNotifications (ctx) {
    return _.pick(ctx.notifications, ['requestNotify', 'requestSnooze', 'requestClear']);
  }

  /**
   * Initialize the sandbox using server state
   *
   * @param env - .js
   * @param ctx - created from bootevent
   * @returns {{sbx}}
   */
  sbx.serverInit = function serverInit (env, ctx) {
    reset();

    sbx.time = Date.now();
    sbx.settings = env.settings;
    sbx.data = ctx.ddata.clone();
    sbx.notifications = safeNotifications(ctx);

    var profile = require('./profilefunctions')();
    //Plugins will expect the right profile based on time
    profile.loadData(ctx.ddata.profiles);
    sbx.data.profile = profile;
    delete sbx.data.profiles;

    sbx.properties = [];

    sbx.withExtendedSettings = function getPluginExtendedSettingsOnly (plugin) {
      return withExtendedSettings(plugin, env.extendedSettings, sbx);
    };

    extend();

    return sbx;
  };

  /**
   * Initialize the sandbox using client state
   *
   * @param settings - specific settings from the client, starting with the defaults
   * @param time - could be a retro time
   * @param pluginBase - used by visualization plugins to update the UI
   * @param data - svgs, treatments, profile, etc
   * @returns {{sbx}}
   */
  sbx.clientInit = function clientInit (ctx, time, data) {
    reset();

    sbx.settings = ctx.settings;
    sbx.showPlugins = ctx.settings.showPlugins;
    sbx.time = time;
    sbx.data = data;
    sbx.pluginBase = ctx.pluginBase;
    sbx.notifications = safeNotifications(ctx);

    if (sbx.pluginBase) {
      sbx.pluginBase.forecastInfos = [];
      sbx.pluginBase.forecastPoints = [];
    }

    sbx.extendedSettings = {empty: true};
    sbx.withExtendedSettings = function getPluginExtendedSettingsOnly (plugin) {
      return withExtendedSettings(plugin, sbx.settings.extendedSettings, sbx);
    };

    extend();

    return sbx;
  };

  /**
   * Properties are immutable, first plugin to set it wins, plugins should be in the correct order
   *
   * @param name
   * @param setter
   */
  sbx.offerProperty = function offerProperty (name, setter) {
    if (!sbx.properties.hasOwnProperty(name)) {
      var value = setter();
      if (value) {
        sbx.properties[name] = value;
      }
    }
  };

  sbx.isCurrent = function isCurrent(entry) {
    return entry && sbx.time - entry.mills <= times.mins(15).msecs;
  };

  sbx.lastEntry = function lastEntry (entries) {
    return _.findLast(entries, function notInTheFuture (entry) {
      return sbx.entryMills(entry) <= sbx.time;
    });
  };

  sbx.lastNEntries = function lastNEntries (entries, n) {
    var lastN = [];

    _.takeRightWhile(entries, function (entry) {
      if (sbx.entryMills(entry) <= sbx.time) {
        lastN.push(entry);
      }
      return lastN.length < n;
    });

    lastN.reverse();

    return lastN;
  };

  sbx.prevEntry = function prevEntry (entries) {
    var last2 = sbx.lastNEntries(entries, 2);
    return _.first(last2);
  };

  sbx.prevSGVEntry = function prevSGVEntry () {
    return sbx.prevEntry(sbx.data.sgvs);
  };

  sbx.lastSGVEntry = function lastSGVEntry ( ) {
    return sbx.lastEntry(sbx.data.sgvs);
  };

  sbx.lastSGVMgdl = function lastSGVMgdl ( ) {
    var last = sbx.lastSGVEntry();
    return last && last.mgdl;
  };

  sbx.lastSGVMills = function lastSGVMills ( ) {
    return sbx.entryMills(sbx.lastSGVEntry());
  };

  sbx.entryMills = function entryMills(entry) {
    return entry && entry.mills;
  };

  sbx.lastScaledSGV = function lastScaledSVG ( ) {
    return sbx.scaleEntry(sbx.lastSGVEntry());
  };

  sbx.lastDisplaySVG = function lastDisplaySVG ( ) {
    return sbx.displayBg(sbx.lastSGVEntry());
  };

  sbx.buildBGNowLine = function buildBGNowLine ( ) {
    var line = 'BG Now: ' + sbx.lastDisplaySVG();

    var delta = sbx.properties.delta && sbx.properties.delta.display;
    if (delta) {
      line += ' ' + delta;
    }

    var direction = sbx.properties.direction && sbx.properties.direction.label;
    if (direction) {
      line += ' ' + direction;
    }

    line += ' ' + sbx.unitsLabel;

    return line;
  };

  sbx.propertyLine = function propertyLine (propertyName) {
    return sbx.properties[propertyName] && sbx.properties[propertyName].displayLine;
  };

  sbx.appendPropertyLine = function appendPropertyLine (propertyName, lines) {
    lines = lines || [];

    var displayLine = sbx.propertyLine(propertyName);
    if (displayLine) {
      lines.push(displayLine);
    }

    return lines;
  };

  sbx.prepareDefaultLines = function prepareDefaultLines() {
    var lines = [sbx.buildBGNowLine()];
    sbx.appendPropertyLine('rawbg', lines);
    sbx.appendPropertyLine('ar2', lines);
    sbx.appendPropertyLine('bwp', lines);
    sbx.appendPropertyLine('iob', lines);
    sbx.appendPropertyLine('cob', lines);

    return lines;
  };

  sbx.buildDefaultMessage = function buildDefaultMessage() {
    return sbx.prepareDefaultLines().join('\n');
  };

  sbx.displayBg = function displayBg (entry) {
    var isDex = entry && (!entry.device || entry.device === 'dexcom');
    if (isDex && Number(entry.mgdl) === 39) {
      return 'LOW';
    } else if (isDex && Number(entry.mgdl) === 401) {
      return 'HIGH';
    } else {
      return sbx.scaleEntry(entry);
    }
  };

  sbx.scaleEntry = function scaleEntry (entry) {

    if (entry && entry.scaled === undefined) {
      if (sbx.settings.units === 'mmol') {
        entry.scaled = entry.mmol || units.mgdlToMMOL(entry.mgdl);
      } else {
        entry.scaled = entry.mgdl || units.mmolToMgdl(entry.mmol);
      }
    }

    return entry && Number(entry.scaled);
  };

  sbx.scaleMgdl = function scaleMgdl (mgdl) {
    if (sbx.settings.units === 'mmol' && mgdl) {
      return Number(units.mgdlToMMOL(mgdl));
    } else {
      return Number(mgdl);
    }
  };

  sbx.roundInsulinForDisplayFormat = function roundInsulinForDisplayFormat (insulin) {

    if (insulin === 0) {
      return '0';
    }

    if (sbx.properties.roundingStyle === 'medtronic') {
      var denominator = 0.1;
      var digits = 1;
      if (insulin > 0.5 && iob < 1) {
        denominator = 0.05;
        digits = 2;
      }
      if (insulin <= 0.5) {
        denominator = 0.025;
        digits = 3;
      }
      return (Math.floor(insulin / denominator) * denominator).toFixed(digits);
    }

    return (Math.floor(insulin / 0.01) * 0.01).toFixed(2);

  };

  function unitsLabel ( ) {
    return sbx.settings.units === 'mmol' ? 'mmol/L' : 'mg/dl';
  }

  sbx.roundBGToDisplayFormat = function roundBGToDisplayFormat (bg) {
    return sbx.settings.units === 'mmol' ? Math.round(bg * 10) / 10 : Math.round(bg);
  };

  return sbx;
}

module.exports = init;

