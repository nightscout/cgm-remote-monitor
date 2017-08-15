import '../static/css/drawer.css';
import '../static/css/main.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';
import '../node_modules/jquery.tipsy/src/jquery.tipsy.css';

   
(function () {

  window._ = require('lodash');
  window.d3 = require('d3');
  window.$ = window.jQuery = require('jquery');
  
  window.tipsy = require('jquery.tipsy');
  
  window.jqui = require('jquery-ui/ui/core');
  
  window.Storage = require('js-storage');
  
  window.flot = require('flot');
  
  window.moment = require('moment-timezone');
  
//  window.sugar = require('sugar');
//  window.crossfilter = require('crossfilter');
  window.Nightscout = window.Nightscout || {};

  window.Nightscout = {
    client: require('../lib/client')
    , units: require('../lib/units')()
    , report_plugins: require('../lib/report_plugins/')()
    , admin_plugins: require('../lib/admin_plugins/')()
  };

  console.info('Nightscout bundle ready');

})();

//import '../node_modules/jquery.tipsy/src/jquery.tipsy.js';
