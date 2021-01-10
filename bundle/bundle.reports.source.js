import './bundle.source';

window.Nightscout.report_plugins = require('../lib/report_plugins/')();
window.Nightscout.predictions = require('../lib/report/predictions');

console.info('Nightscout report bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept()
  }
