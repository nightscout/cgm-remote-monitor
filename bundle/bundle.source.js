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

// Many internet users are still using very old, out-dated browsers – most of them for no actual reason. 
// We want to remind these unobtrusively to update their browser.
var browserUpdate = require('browser-update');
browserUpdate({ required: {e:-4,f:-3,o:-3,s:-1,c:-3}, insecure:true, unsupported:true, api:2018.08 });

window.moment = require('moment-timezone');

window.Nightscout = window.Nightscout || {};

window.Nightscout = {
    client: require('../lib/client'),
    units: require('../lib/units')(),
    report_plugins: require('../lib/report_plugins/')(),
    admin_plugins: require('../lib/admin_plugins/')()
};

console.info('Nightscout bundle ready');