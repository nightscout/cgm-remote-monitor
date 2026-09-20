'use strict';

// Private production modules needed by component tests. Keep these out of the
// production bundle's public interface; webpack uses the same loader rules.
window.NightscoutTestModules = {
  makeBus: require('../../lib/bus'),
  utils: require('../../lib/utils'),
  profilefunctions: require('../../lib/profilefunctions'),
  browserSettings: require('../../lib/client/browser-settings'),
  browserUtils: require('../../lib/client/browser-utils'),
  careportal: require('../../lib/client/careportal'),
  boluscalc: require('../../lib/client/boluscalc'),
  profileeditor: require('../../lib/profile/profileeditor'),
  makeChart: require('./chart.source'),
  pluginbase: require('../../lib/plugins/pluginbase'),
  adminnotifies: require('../../lib/client/adminnotifiesclient')
};
