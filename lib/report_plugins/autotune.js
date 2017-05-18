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

function appendMainRecords(table, header, current, recommended, translate) {
  var tr = $('<tr/>');
  $('<th>' + translate(header) + '</th>').appendTo(tr);
  $('<th>' + current + '</th>').appendTo(tr);
  $('<th>' + recommended + '</th>').appendTo(tr);
  $('<th/>').appendTo(tr);
  tr.appendTo(table);
}

function getCurrentISF(store) {
  return store.sens[0].value;
}

function getCurrentCSF(store) {
  return getCurrentISF(store) / getCurrentCarbRatio(store);
}

function getCurrentCarbRatio(store) {
  return store.carbratio[0].value;
}

function roundNum(num) {
  return Number(num).toFixed(3);
}

autotune.report = function report_autotune(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var profileRecords = datastorage.profiles;

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

  var profile = profileRecords[0];
  var store = profile.store[profile.defaultProfile];

  appendMainRecords(table, 'ISF', roundNum(getCurrentISF(store)), '', translate);
  appendMainRecords(table, 'CSF', roundNum(getCurrentCSF(store)), '', translate);
  appendMainRecords(table, 'Carb Ratio', roundNum(getCurrentCarbRatio(store)), '', translate);
  
  var trBasalProfile = $('<tr/>');
  $('<th>' + translate('Basal Profile') + '</th>').appendTo(trBasalProfile);
  $('<th/>').appendTo(trBasalProfile);
  $('<th/>').appendTo(trBasalProfile);
  $('<th/>').appendTo(trBasalProfile);
  trBasalProfile.appendTo(table);

  store.basal.forEach(function(basalRecord, i) {
    var tr = $('<tr/>');
    $('<th>' + basalRecord.time + '</th>').appendTo(tr);
    $('<th>' + basalRecord.value + '</th>').appendTo(tr);
    $('<th/>').appendTo(tr);
    $('<th/>').appendTo(tr);

    if (i > 0) {
      var tokens = basalRecord.time.split(':');
      var hours = Number(tokens[0]);
      var minutes = Number(tokens[1]);

      var prevTokens = store.basal[i - 1].time.split(':');
      var prevHours = Number(prevTokens[0]);
      var prevMinutes = Number(prevTokens[1]);


      while (hours !== prevHours || minutes !== prevMinutes) {
        var newMinutes = (prevMinutes + 30) % 60;
        prevHours = (prevHours + Math.floor((prevMinutes + 30) / 60)) % 24
        prevMinutes = newMinutes;

        if (hours === prevHours && minutes === prevMinutes) break;

        var emptyTr = $('<tr/>');
        $('<th>' + ('0' + prevHours).slice(-2) + ':'+  ('0' + prevMinutes).slice(-2) + '</th>').appendTo(emptyTr);
        $('<th/>').appendTo(emptyTr);
        $('<th/>').appendTo(emptyTr);
        $('<th/>').appendTo(emptyTr);
        emptyTr.appendTo(table)
      }
    }

    tr.appendTo(table)
  });
};
