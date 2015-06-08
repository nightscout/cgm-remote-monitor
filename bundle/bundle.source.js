(function () {

  window._ = require('lodash');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    nsUtils: require('../lib/nsUtils')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')().registerClientDefaults()
  };

  console.info("Nightscout bundle ready", window.Nightscout);

})();

