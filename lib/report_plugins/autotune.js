'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');
var tz = require('moment-timezone');
var lastResult = null;
var autotune_prep = require('./autotune/autotune-prep');
var autotune = {
  name: 'autotune'
  , label: 'Autotune'
  , pluginType: 'report'
};

var libAutotune = require('./autotune/index');
//autotune.tune = libAutotune.tuneAllTheThings;
autotune.tune = require('./autotune/index');
autotune.percentile = libAutotune.percentile;
autotune.percentRank = libAutotune.percentRank;

function init() {
  return autotune;
}

module.exports = init;
autotune.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Autotune') + '</h2>'
    + '<p><b>WARNING</b>: Autotune is a DIY tool for recommending potential changes to (a single) ISF, basal rate, and (a single) carb ratio. If you have questions or concerns about your personal settings, you should talk with your healthcare provider about them.</p>'
    + '<p><b>NOTE</b>: The “current” basal rate, ISF, and carb ratio is based on what you manually input into the Nightscout profile. If you have updated your pump or use other tools (i.e. one of the DIY closed loops), this may not be up to date with your settings there.</p>'
    + '<p><i>More details about autotune and documentation around interpreting autotune can be found <a href="http://openaps.readthedocs.io/en/latest/docs/Customize-Iterate/autotune.html">here</a>.</i></p>'
    + '<p><input type="checkbox" id="compute_autotune">Compute autotune</p>'
    + '<div id="autotune-report"></div>'
    ;
    return ret;
};

autotune.css =
    '#autotune-report .autotune-report {'
  + '  border-spacing: 0;'
  + '}'
  + '#autotune-report .autotune-report th {'
  + '  width: 160px;'
  + '  border-bottom: 1px solid black;'
  + '  background: #b7b7b7'
  + '}'
  + '#autotune-report .autotune-report tr:nth-child(even) {'
  + '  background: #efefef;'
  + '}'
  + '#autotune-report .autotune-report td {'
  + '  width: 160px;'
  + '  padding: 4px 0;'
  + '}'

autotune.prepareHtml = function autotunePrepareHtml(sorteddaystoshow) {
};

function appendMainRecords(table, header, current, recommended, translate) {
  var tr = $('<tr/>');
  if (current || recommended) {
    $('<td>' + translate(header) + '</td>').appendTo(tr);
    $('<td>' + current + '</td>').appendTo(tr);
    $('<td>' + recommended + '</td>').appendTo(tr);
  }
  var td = $('<td/>')
  appendArrowIcon(td, current, recommended);
  td.appendTo(tr);
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

function appendArrowIcon(td, current, recommended) {
  var icon = $('<img/>');
  if (recommended > current) {
    $('<img src="/images/up_arrow.png" />').appendTo(td);
  } else if (recommended < current) {
    $('<img src="/images/down_arrow.png" />').appendTo(td);
  }
}

function findActiveProfiles(profiles, sorteddaystoshow) {
  var result = {};
  result.activeIndex = -1;
  result.manyActive = false;

  var dateFrom = new Date(sorteddaystoshow[0]);
  var dateTo = new Date(sorteddaystoshow[sorteddaystoshow.length-1]);
  var sortedProfiles = [];
  for (var i = 0; i < profiles.length; i++) {
    var record = {};
    record.profileIndex = i;
    if (! profiles[i].startDate) { continue; }
    var splittedString = profiles[i].startDate.split("T");
    record.startDate = new Date(splittedString[0]);
    sortedProfiles.push(record);
  }
  sortedProfiles.sort(function (r1, r2) {
    return (r1.startDate < r2.startDate) ? -1 : ((r1.startDate > r2.startDate) ? 1 : 0);
  });
  for (i = 0; i < sortedProfiles.length; i++) {
    var profile = sortedProfiles[i];
    if (profile.startDate <= dateFrom) {
      result.activeIndex = profile.profileIndex;
      continue;
    }
    if (profile.startDate >= dateFrom && profile.startDate <= dateTo)
      result.manyActive = true;
    if (profile.startDate > dateFrom)
      break;
  }

  return result;
}

function getHourMinuteText(hour, minute)
{
  var text = "";
  if (hour < 10)
    text += "0";
  text += hour.toString();
  text += ":";
  if (minute < 10)
    text += "0";
  text += minute.toString();
  return text;
}

function findBasalRecord(data, time)
{
  for(var i = 0; i < data.length; i++)
  {
    if (data[i].time == time)
      return data[i];
  }
  return null;
}

function findRecommendedRecord(data, minutes) {
  for(var i = 0; i < data.length; i++)
  {
    if (data[i].minutes == minutes)
      return data[i];
  }
  return null;
}

autotune.report = function report_autotune(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;

  if (!$('#compute_autotune').is(':checked')) return;

  var profileRecords = datastorage.profiles;

  var report = $('#autotune-report');
  report.empty();

  var foundActiveProfile = findActiveProfiles(datastorage.profiles, sorteddaystoshow);
  if (foundActiveProfile.activeIndex < 0 || foundActiveProfile.manyActive)
  {
    // Show error
    $('<div class="error">' + "Error: Many profiles are active during choosen period." + "</div>").appendTo(report);
    return;
  }

  var table = $('<table class="centeraligned autotune-report">');
  report.append(table);

  var thead = $('<tr/>');
  $('<th/>').appendTo(thead);
  $('<th>' + translate('Current NS Profile') + '</th>').appendTo(thead);
  $('<th>' + translate('Calculated') + '</th>').appendTo(thead);
  $('<th/>').appendTo(thead);
  thead.appendTo(table);

  var profile = profileRecords[foundActiveProfile.activeIndex];
  var store = profile.store[profile.defaultProfile];

  const re = /\d{4}-\d{2}-\d{2}/g;
  var keys = _.filter(Object.keys(datastorage), function (key) { return key.match(re)});

  var convertedProfile = autotune.convertProfile(profile);
  var opts = {
        profile: convertedProfile //inputs.profile
      // TODO: figure out how to use only the relevant treatments so it's not so slow on >1d of data
      , history: _.flatMap(keys, function(key){return datastorage[key].treatments;}) //inputs.history
      , glucose: _.flatMap(keys, function(key){return datastorage[key].sgv;})//inputs.glucose
      , prepped_glucose: undefined// inputs.prepped_glucose
      , basalprofile: convertedProfile.basalprofile
      , carbs: []
  };

  if (Nightscout.client.settings.units == 'mmol') {
   var g = _.cloneDeep(opts.glucose);
    _.forEach(g, function(e) { e.sgv = e.sgv * 18; });
    opts.glucose = g;
  }

  var prepared = autotune_prep(opts);

  var inputs = {
        preppedGlucose: prepared
      , previousAutotune: convertedProfile
      , pumpProfile: convertedProfile
  };

  var result = autotune.tune(inputs);

  appendMainRecords(table, 'ISF', roundNum(getCurrentISF(store)), result.sens, translate);
  //appendMainRecords(table, 'CSF', roundNum(getCurrentCSF(store)), result.csf, translate);
  appendMainRecords(table, 'Carb Ratio', roundNum(getCurrentCarbRatio(store)), result.carb_ratio, translate);

  var trBasalProfile = $('<tr/>');
  $('<td>' + translate('Basal Profile') + '</td>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  $('<td/>').appendTo(trBasalProfile);
  trBasalProfile.appendTo(table);

  var lastBasalRecord;
  for (var iTime = 0; iTime < 24*2; iTime++) {
    var time = getHourMinuteText(Math.floor(iTime / 2), (iTime % 2) * 30);
    var basalRecord = findBasalRecord(store.basal, time);
    var recommendedRecord = findRecommendedRecord(result.basalprofile, iTime*30);

    if (basalRecord !== null || recommendedRecord !== null) {
      var tr = $('<tr/>');
      $('<td>' + time + '</td>').appendTo(tr);
      if (basalRecord !== null) {
        lastBasalRecord = basalRecord;
        $('<td>' + basalRecord.value + '</td>').appendTo(tr);
      } else {
        $('<td/>').appendTo(tr);
      }
      if (recommendedRecord !== null) {
        var criticalLimit = 1.2;
        var style = "";
        if (lastBasalRecord !== null) {
          var wasCriticalChange = false;
          if (lastBasalRecord.value < recommendedRecord.rate)
          {
            wasCriticalChange = (recommendedRecord.rate / lastBasalRecord.value >= criticalLimit);
          }
          else if (lastBasalRecord.value > recommendedRecord.rate) {
            wasCriticalChange = (lastBasalRecord.value / recommendedRecord.rate >= criticalLimit);
          }
          if (wasCriticalChange)
            style = "background-color: #FF9999";
        }
        $('<td style="' + style + '">' + recommendedRecord.rate + '</td>').appendTo(tr);
      } else {
        $('<td/>').appendTo(tr);
      }
      var lastTd = $('<td/>').appendTo(tr);
    }

    if (recommendedRecord && lastBasalRecord) {
      appendArrowIcon(lastTd, lastBasalRecord.value, recommendedRecord.rate);
    }

    tr.appendTo(table)
  }
};

autotune.convertBasal = function convertBasal(item)
{
    var convertedBasal = {
      "start": item.time + ":00",
      "minutes": Math.round(item.timeAsSeconds / 60),
      "rate": item.value
  };
  return convertedBasal;
}

autotune.convertProfile = function convertProfile(profile)
{
	var p = profile.store[profile.defaultProfile];
	
    var autotuneProfile =
    {
      "min_5m_carbimpact": 3,
      "dia": Number(p.dia),
      "basalprofile": _.map(p.basal, autotune.convertBasal),
      "isfProfile": {
        "sensitivities": [
          {
              "i": 0,
              "start": p.sens[0].time + ":00",
              "sensitivity": Number(p.sens[0].value),
              "offset": 0,
              "x": 0,
              "endOffset": 1440
          }
        ]
      },
      "carb_ratio": Number(p.carbratio[0].value),
      "autosens_max": 1.2,
      "autosens_min": 0.7
  };
  return autotuneProfile;
}

var isf = require('./autotune/profile/isf');
autotune.isfLookup = isf.isfLookup;

var history = require('./autotune/meal/history');
autotune.arrayHasElementWithSameTimestampAndProperty = history.arrayHasElementWithSameTimestampAndProperty;

var basal = require('./autotune/profile/basal');
autotune.basalLookup = basal.basalLookup;
/* Return basal rate(U / hr) at the provided timeOfDay */

autotune.maxDailyBasal = function maxDailyBasal (inputs) {
    var maxRate = _.maxBy(inputs.basals,function(o) { return Number(o.rate); });
    return (Number(maxRate.rate) *1000)/1000;
}

/*Return maximum daily basal rate(U / hr) from profile.basals */
autotune.maxBasalLookup = function maxBasalLookup (inputs) {
    return inputs.settings.maxBasal;
}

