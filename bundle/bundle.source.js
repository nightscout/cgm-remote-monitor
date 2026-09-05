import '../static/css/drawer.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';

// expose-loader initializes window.$ for page scripts and plugins.
require('jquery');

require('jquery-ui-bundle');

window.d3 = require('../lib/d3.mjs');

require('jquery.tooltips');

window.Storage = require('js-storage');


const moment = require('moment-timezone');

window.moment = moment;

window.Nightscout = window.Nightscout || {};

window.Nightscout = {
    client: require('../lib/client'),
    units: require('../lib/units')()
};


console.info('Nightscout bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept()
}
