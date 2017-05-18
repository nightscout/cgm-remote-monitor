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
  $('<td>' + translate(header) + '</td>').appendTo(tr);
  $('<td>' + current + '</td>').appendTo(tr);
  $('<td>' + recommended + '</td>').appendTo(tr);
  $('<td/>').appendTo(tr);
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

function findActiveProfiles(profiles, sorteddaystoshow) {
  var result = {};
  result.activeIndex = -1;
  result.manyActive = false;

  var dateFrom = new Date(sorteddaystoshow[0]);
  var dateTo = new Date(sorteddaystoshow[sorteddaystoshow.length-1]);
  var sortedProfiles = [];
  for (i = 0; i < profiles.length; i++) {
    var record = {};
    record.profileIndex = i;
    splittedString = profiles[i].created_at.split("T");
    record.created_at = new Date(splittedString[0]);
    sortedProfiles.push(record);
  }
  sortedProfiles.sort(function (r1, r2) {
    return (r1.created_at < r2.created_at) ? -1 : ((r1.created_at > r2.created_at) ? 1 : 0);
  });
  for (i = 0; i < sortedProfiles.length; i++) {
    var profile = sortedProfiles[i];
    if (profile.created_at <= dateFrom) {
      result.activeIndex = profile.profileIndex;
      continue;
    }
    if (profile.created_at >= dateFrom && profile.created_at <= dateTo)
      result.manyActive = true;
    if (profile.created_at > dateFrom)
      break;
  }

  return result;
}

autotune.report = function report_autotune(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  var profileRecords = datastorage.profiles;

  var report = $('#autotune-report');
  report.empty();

  var foundActiveProfile = findActiveProfiles(datastorage.profiles, sorteddaystoshow);
  if (foundActiveProfile.activeIndex < 0 || foundActiveProfile.manyActive)
  {
    // Show error
    $('<div>' + "Many profiles are active during choosen period." + "</div>").appendTo(report);
    return;
  }

  var table = $('<table class="centeraligned">');
  report.append(table);

  var thead = $('<tr/>');
  $('<th>' + translate('Date') + '</th>').appendTo(thead);
  $('<th>' + translate('Current') + '</th>').appendTo(thead);
  $('<th>' + translate('Recommended') + '</th>').appendTo(thead);
  $('<th/>').appendTo(thead);
  thead.appendTo(table);

  var profile = profileRecords[foundActiveProfile.activeIndex];
  var store = profile.store[profile.defaultProfile];

  appendMainRecords(table, 'ISF', roundNum(getCurrentISF(store)), '', translate);
  appendMainRecords(table, 'CSF', roundNum(getCurrentCSF(store)), '', translate);
  appendMainRecords(table, 'Carb Ratio', roundNum(getCurrentCarbRatio(store)), '', translate);
  
  var trBasalProfile = $('<tr/>');
  $('<td>' + translate('Basal Profile') + '</td>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  trBasalProfile.appendTo(table);

  store.basal.forEach(function(basalRecord, i) {
    var tr = $('<tr/>');
    $('<td>' + basalRecord.time + '</td>').appendTo(tr);
    $('<td>' + basalRecord.value + '</td>').appendTo(tr);
    $('<td/>').appendTo(tr);
    $('<td/>').appendTo(tr);

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
        $('<td>' + ('0' + prevHours).slice(-2) + ':'+  ('0' + prevMinutes).slice(-2) + '</td>').appendTo(emptyTr);
        $('<td/>').appendTo(emptyTr);
        $('<td/>').appendTo(emptyTr);
        $('<td/>').appendTo(emptyTr);
        emptyTr.appendTo(table)
      }
    }

    tr.appendTo(table)
  });
};
