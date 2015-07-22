(function () {

  window._ = require('lodash');
  window.$ = window.jQuery = require('jquery');
  window.moment = require('moment-timezone');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    units: require('../lib/units')(),
    utils: require('../lib/utils')(),
    profile: require('../lib/profilefunctions')(),
    language: require('../lib/language')(),
    plugins: require('../lib/plugins/')().registerClientDefaults(),
    sandbox: require('../lib/sandbox')()
  };

  console.info('Nightscout bundle ready', window.Nightscout);

})();

