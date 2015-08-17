(function () {

  window._ = require('lodash');
  window.$ = window.jQuery = require('jquery');
  window.moment = require('moment-timezone');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    client: require('../lib/client')
    , plugins: require('../lib/plugins/')().registerClientDefaults()
  };

  console.info('Nightscout bundle ready', window.Nightscout);

})();

