(function () {

  window._ = require('lodash');
  window.d3 = require('d3');
  window.$ = window.jQuery = require('jquery');
  window.moment = require('moment-timezone');
  window.sugar = require('sugar');
  window.crossfilter = require('crossfilter');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    client: require('../lib/client')
    , units: require('../lib/units')()
    , report_plugins: require('../lib/report_plugins/')()
    , admin_plugins: require('../lib/admin_plugins/')()
  };

  console.info('Nightscout bundle ready');

})();

