(function () {

  window._ = require('lodash');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')().registerClientDefaults()
  };

  console.info("Nightscout bundle ready", window.Nightscout);

})();

