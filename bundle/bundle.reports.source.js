import './bundle.source';

window.Nightscout.report_plugins = require('../lib/report_plugins/')();

console.info('Nightscout report bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept() // eslint-disable-line no-undef  
  }
