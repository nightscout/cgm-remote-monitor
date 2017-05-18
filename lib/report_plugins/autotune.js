'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');

var autotune = {
  name: 'autotune'
  , label: 'Autotune'
  , pluginType: 'report'
};

function init() {
  return autotune;
}

module.exports = init;
autotune.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Autotune') + '</h2>'
    + '<div id="autotune-report"></div>'
    ;
    return ret;
};

autotune.prepareHtml = function autotunePrepareHtml(sorteddaystoshow) {
};

autotune.report = function report_autotune(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var report = $('#autotune-report');
  report.empty();

  var table = $('<table class="centeraligned">');
  report.append(table);

  var thead = $('<tr/>');
  $('<th>' + translate('Date') + '</th>').appendTo(thead);
  $('<th>' + translate('Current') + '</th>').appendTo(thead);
  $('<th>' + translate('Recommended') + '</th>').appendTo(thead);
  $('<th/>').appendTo(thead);
  thead.appendTo(table);
};
