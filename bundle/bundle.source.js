import '../static/css/drawer.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';

// Keep the existing light/dark palettes while matching maintained widget markup.
import 'jquery-ui/themes/base/core.css';
import 'jquery-ui/themes/base/button.css';
import 'jquery-ui/themes/base/dialog.css';
import 'jquery-ui/themes/base/draggable.css';
import 'jquery-ui/themes/base/resizable.css';
import 'jquery-ui/themes/base/sortable.css';

// expose-loader initializes window.$ for page scripts and plugins.
require('jquery');

// Dialog includes its draggable/resizable dependencies. Food editing also
// needs droppable and sortable; unused UI widgets are not bundled.
require('jquery-ui/ui/widgets/dialog');
require('jquery-ui/ui/widgets/droppable');
require('jquery-ui/ui/widgets/sortable');

window.d3 = require('../lib/d3.mjs');

require('jquery.tooltips');

window.Storage = require('../lib/client/storage');


const moment = require('moment-timezone');

window.moment = moment;

window.Nightscout = window.Nightscout || {};

// Shared hot updates must retain the exports installed by page entries.
Object.assign(window.Nightscout, {
    client: require('../lib/client'),
    units: require('../lib/units')()
});


console.info('Nightscout bundle ready');

// Needed for Hot Module Replacement
if(typeof(module.hot) !== 'undefined') {
    module.hot.accept()
}
