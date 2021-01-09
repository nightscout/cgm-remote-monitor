import './bundle.source';

console.info('Nightscout report bundle start');

window.Nightscout.report_plugins_preinit = require('../lib/report_plugins/');
window.Nightscout.predictions = require('../lib/report/predictions');
window.Nightscout.reportclient = require('../lib/report/reportclient');

console.info('Nightscout report bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept()
}
