'use strict';

// The app entry initializes the shared client before this page entry.
window.Nightscout.admin_plugins = require('../lib/admin_plugins/')({moment: window.moment});

if (module.hot) module.hot.accept();
