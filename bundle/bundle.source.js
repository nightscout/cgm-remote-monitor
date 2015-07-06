(function () {

  window._ = require('lodash');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    utils: require('../lib/utils')(),
    profile: require('../lib/profilefunctions')(),
    plugins: require('../lib/plugins/')().registerClientDefaults(),
    sandbox: require('../lib/sandbox')()
  };

  console.info('Nightscout bundle ready', window.Nightscout);

})();

