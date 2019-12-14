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
  let delta;

  xhr.forEach(element => {
    if (element.sgv && !rec && !delta) {
      rec = element;
    }
    else if (element.sgv && rec && !delta) {
      delta = (rec.sgv - element.sgv)/((rec.date - element.date)/(5*60*1000));
    }
  });

  let $errorMessage = $('#errorMessage');

  // If no one measured value found => show "-?-"
  if (!rec) {
    if (!$errorMessage.length) {
      $('#arrowDiv').append('<div id="errorMessage" title="No data found in DB">-?-</div>');
      $('#arrow').hide();
    } else {
      $errorMessage.show();
    }
    return;
  } else {
    $errorMessage.length && $errorMessage.hide();
    $('#arrow').show();
  }
  
  let last = new Date(rec.date);
  let now = new Date();

  // Convert BG to mmol/L if necessary.
  if (window.serverSettings.settings.units === 'mmol') {
    var displayValue = window.Nightscout.units.mgdlToMMOL(rec.sgv);
    var deltaDisplayValue = window.Nightscout.units.mgdlToMMOL(delta);
  } else {
    displayValue = rec.sgv;
    deltaDisplayValue = Math.round(delta);
  }

  if (deltaDisplayValue > 0) {
    deltaDisplayValue = '+' +  deltaDisplayValue;
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

    var elapsedMins = Math.round(((now - last) / 1000) / 60);

    // Insert the BG stale time text.
    let staleTimeText;
    if (elapsedMins == 0) {
      staleTimeText = 'Just now';
    }
    else if (elapsedMins == 1) {
      staleTimeText = '1 minute ago';
    }
    else {
      staleTimeText = elapsedMins + ' minutes ago';
    }
    $('#staleTime').text(staleTimeText);

    // Force NS to always show 'x minutes ago'
    if (window.serverSettings.settings.showClockLastTime) {
      $('#staleTime').css('display', 'block');
    }

    // Insert the delta value text.
    $('#delta').html(deltaDisplayValue);

    // Show delta
    if (window.serverSettings.settings.showClockDelta) {
      $('#delta').css('display', 'inline-block');
    }

    // Threshold background coloring.
    if (bgNum < bgLow) {
      $('body').css('background-color', red);
    }
    if ((bgLow <= bgNum) && (bgNum < bgTargetBottom)) {
      $('body').css('background-color', blue);
    }
    if ((bgTargetBottom <= bgNum) && (bgNum < bgTargetTop)) {
      $('body').css('background-color', green);
    }
    if ((bgTargetTop <= bgNum) && (bgNum < bgHigh)) {
      $('body').css('background-color', yellow);
    }
    if (bgNum >= bgHigh) {
      $('body').css('background-color', red);
    }

    // Restyle body bg, and make the "x minutes ago" visible too.
    if (now - last > threshold) {
      $('body').css('background-color', 'grey');
      $('body').css('color', 'black');
      $('#arrow').css('filter', 'brightness(0%)');

      if (!window.serverSettings.settings.showClockLastTime) {
        $('#staleTime').css('display', 'block');
      }

    } else {
      $('body').css('color', 'white');
      $('#arrow').css('filter', 'brightness(100%)');

      if (!window.serverSettings.settings.showClockLastTime) {
        $('#staleTime').css('display', 'none');
      }

    }
  }
};

client.init = function init () {
  console.log('init');
  client.query();
  setInterval(client.query, 1 * 60 * 1000);
};

module.exports = client;
