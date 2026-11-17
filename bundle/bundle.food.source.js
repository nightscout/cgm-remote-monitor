'use strict';

// The app entry initializes the shared client before this page entry.
window.Nightscout.foodclient = require('../lib/food/food');

if (module.hot) module.hot.accept();
