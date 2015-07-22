(function () {

  window._ = require('lodash');
  window.$ = window.jQuery = require('jquery');
  window.moment = require('moment-timezone');
  window.Nightscout = window.Nightscout || {};

  var plugins = require('../lib/plugins/')().registerClientDefaults();

  window.Nightscout = {
    units: require('../lib/units')(),
    utils: require('../lib/utils')(),
    profile: require('../lib/profilefunctions')(),
    language: require('../lib/language')(),
    plugins: plugins,
    sandbox: require('../lib/sandbox')()
  };

  window.Nightscout.client = require('../lib/client');

  console.info('Nightscout bundle ready', window.Nightscout);

})();

