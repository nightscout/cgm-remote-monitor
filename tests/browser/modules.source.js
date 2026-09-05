'use strict';

// Private production modules needed by component tests. Keep these out of the
// production bundle's public interface; webpack uses the same loader rules.
window.NightscoutTestModules = {
  utils: require('../../lib/utils'),
  browserSettings: require('../../lib/client/browser-settings'),
  careportal: require('../../lib/client/careportal'),
  boluscalc: require('../../lib/client/boluscalc'),
  makeChart: require('./chart.source')
};
