'use strict';

// The app entry initializes the shared client before this page entry.
// Register only the report plugins; Flot's default distribution includes all plugins.
require('flot/source/jquery.canvaswrapper');
require('flot/source/jquery.colorhelpers');
require('flot/source/jquery.flot');
require('flot/source/jquery.flot.saturated');
require('flot/source/jquery.flot.browser');
require('flot/source/jquery.flot.drawSeries');
require('flot/source/jquery.flot.uiConstants');
require('flot/source/jquery.flot.time');
require('flot/source/jquery.flot.pie');
require('flot/source/jquery.flot.fillbetween');
require('flot/source/jquery.flot.legend');
// Preserve the report legends that were enabled by default in Flot 0.8.
$.plot.plugins.find(plugin => plugin.name === 'legend').options.legend.show = true;

window.Nightscout.report_plugins_preinit = require('../lib/report_plugins/');
window.Nightscout.predictions = require('../lib/report/predictions');
window.Nightscout.reportclient = require('../lib/report/reportclient');

if (module.hot) module.hot.accept();
