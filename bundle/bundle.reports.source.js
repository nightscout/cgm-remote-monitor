'use strict';

// The app entry initializes the shared client before this page entry.
require('flot');
require('flot/jquery.flot.time');
require('flot/jquery.flot.pie');
require('flot/jquery.flot.fillbetween');

window.Nightscout.report_plugins_preinit = require('../lib/report_plugins/');
window.Nightscout.predictions = require('../lib/report/predictions');
window.Nightscout.reportclient = require('../lib/report/reportclient');

if (module.hot) module.hot.accept();
