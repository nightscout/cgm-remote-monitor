import '../static/css/drawer.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';

$ = require("jquery");

require('jquery-ui-bundle');

window._ = require('lodash');
window.d3 = require('d3');

require('jquery.tooltips');

window.Storage = require('js-storage');

require('flot');
require('../node_modules/flot/jquery.flot.time');
require('../node_modules/flot/jquery.flot.pie');
require('../node_modules/flot/jquery.flot.fillbetween');

window.moment = require('moment-timezone');

window.Nightscout = window.Nightscout || {};

window.Nightscout = {
    client: require('../lib/client'),
    units: require('../lib/units')(),
    admin_plugins: require('../lib/admin_plugins/')()
};

window.Nightscout.report_plugins_preinit = require('../lib/report_plugins/');
window.Nightscout.predictions = require('../lib/report/predictions');
window.Nightscout.reportclient = require('../lib/report/reportclient');
window.Nightscout.profileclient = require('../lib/profile/profileeditor');
window.Nightscout.foodclient = require('../lib/food/food');

console.info('Nightscout bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept()
}
