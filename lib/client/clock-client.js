'use strict';

const browserSettings = require('./browser-settings');

var client = {};

client.settings = browserSettings(client, window.serverSettings, $);

// console.log('settings', client.settings);
// client.settings now contains all settings

client.query = function query () {
  console.log('query');
  var parts = (location.search || '?').substring(1).split('&');
  var token = '';
  parts.forEach(function (val) {
    if (val.startsWith('token=')) {
      token = val.substring('token='.length);
    }
  });

  var secret = localStorage.getItem('apisecrethash');
  var src = '/api/v1/entries.json?count=3&t=' + new Date().getTime();

  if (secret) {
    src += '&secret=' + secret;
  } else if (token) {
    src += '&token=' + token;
  }

  $.ajax(src, {
    success: client.render
  });
};

client.render = function render (xhr) {
  console.log('got data', xhr);

  let rec;

  xhr.some(element => {
    if (element.sgv) {
      rec = element;
      return true;
    }
  });

  let last = new Date(rec.date);
  let now = new Date();

  // Convert BG to mmol/L if necessary.
  if (window.serverSettings.settings.units === 'mmol') {
    var displayValue = window.Nightscout.units.mgdlToMMOL(rec.sgv);
  } else {
    displayValue = rec.sgv;
  }

  // Insert the BG value text.
  $('#bgnow').html(displayValue);

  // Insert the trend arrow.
  $('#arrow').attr('src', '/images/' + (!rec.direction || rec.direction === 'NOT COMPUTABLE' ? 'NONE' : rec.direction) + '.svg');

  // Time before data considered stale.
  let staleMinutes = 13;
  let threshold = 1000 * 60 * staleMinutes;

  // Toggle stale if necessary.
  $('#bgnow').toggleClass('stale', (now - last > threshold));

  // Generate and insert the clock.
  let timeDivisor = parseInt(client.settings.timeFormat ? client.settings.timeFormat : 12, 10);
  let today = new Date()
    , h = today.getHours() % timeDivisor;
  if (timeDivisor === 12) {
    h = (h === 0) ? 12 : h; // In the case of 00:xx, change to 12:xx for 12h time
  }
  if (timeDivisor === 24) {
    h = (h < 10) ? ("0" + h) : h; // Pad the hours with a 0 in 24h time
  }
  let m = today.getMinutes();
  if (m < 10) m = "0" + m;
  $('#clock').text(h + ":" + m);

  var queryDict = {};
  location.search.substr(1).split("&").forEach(function(item) { queryDict[item.split("=")[0]] = item.split("=")[1] });

  if (!window.serverSettings.settings.showClockClosebutton || !queryDict['showClockClosebutton']) {
    $('#close').css('display', 'none');
  }

  // defined in the template this is loaded into
  // eslint-disable-next-line no-undef
  if (clockFace === 'clock-color') {

    var bgHigh = window.serverSettings.settings.thresholds.bgHigh;
    var bgLow = window.serverSettings.settings.thresholds.bgLow;
    var bgTargetBottom = window.serverSettings.settings.thresholds.bgTargetBottom;
    var bgTargetTop = window.serverSettings.settings.thresholds.bgTargetTop;

    var bgNum = parseFloat(rec.sgv);

    // These are the particular shades of red, yellow, green, and blue.
    var red = 'rgba(213,9,21,1)';
    var yellow = 'rgba(234,168,0,1)';
    var green = 'rgba(134,207,70,1)';
    var blue = 'rgba(78,143,207,1)';

    var darkRed = 'rgba(183,9,21,1)';
    var darkYellow = 'rgba(214,168,0,1)';
    var darkGreen = 'rgba(110,192,70,1)';
    var darkBlue = 'rgba(78,143,187,1)';

    var elapsedMins = Math.round(((now - last) / 1000) / 60);

    // Insert the BG stale time text.
    $('#staleTime').text(elapsedMins + ' minutes ago');

    // Threshold background coloring.
    if (bgNum < bgLow) {
      $('body').css('background-color', red);
      $('#close').css('border-color', darkRed);
      $('#close').css('color', darkRed);
    }
    if ((bgLow <= bgNum) && (bgNum < bgTargetBottom)) {
      $('body').css('background-color', blue);
      $('#close').css('border-color', darkBlue);
      $('#close').css('color', darkBlue);
    }
    if ((bgTargetBottom <= bgNum) && (bgNum < bgTargetTop)) {
      $('body').css('background-color', green);
      $('#close').css('border-color', darkGreen);
      $('#close').css('color', darkGreen);
    }
    if ((bgTargetTop <= bgNum) && (bgNum < bgHigh)) {
      $('body').css('background-color', yellow);
      $('#close').css('border-color', darkYellow);
      $('#close').css('color', darkYellow);
    }
    if (bgNum >= bgHigh) {
      $('body').css('background-color', red);
      $('#close').css('border-color', darkRed);
      $('#close').css('color', darkRed);
    }

    // Restyle body bg, and make the "x minutes ago" visible too.
    if (now - last > threshold) {
      $('body').css('background-color', 'grey');
      $('body').css('color', 'black');
      $('#staleTime').css('display', 'block');
      $('#arrow').css('filter', 'brightness(0%)');
    } else {
      $('#staleTime').css('display', 'none');
      $('body').css('color', 'white');
      $('#arrow').css('filter', 'brightness(100%)');
    }
  }
};

client.init = function init () {
  console.log('init');
  client.query();
  setInterval(client.query, 1 * 60 * 1000);
};

module.exports = client;