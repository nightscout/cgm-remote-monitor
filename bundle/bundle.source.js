(function () {

  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')()
  };

  window._ = require('lodash');
  window.Nightscout.plugins.registerDefaults();

  console.info("Nightscout bundle ready", window.Nightscout);

})();

