(function () {

  window._ = require('lodash');
  window.$ = window.jQuery = require('jquery');
  window.moment = require('moment-timezone');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    client: require('../lib/client')
    , units: require('../lib/units')()
    , plugins: require('../lib/plugins/')().registerClientDefaults()
    , report_plugins: require('../lib/report_plugins/')()
  };

  console.info('Nightscout bundle ready');

})();

