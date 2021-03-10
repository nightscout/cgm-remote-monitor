'use strict';

var browserSettings = require('./browser-settings');
var client = {};
var latestProperties = {};

client.query = function query () {
  var parts = (location.search || '?').substring(1).split('&');
  var token = '';
  parts.forEach(function(val) {
    if (val.startsWith('token=')) {
      token = val.substring('token='.length);
    }
  });

  var secret = localStorage.getItem('apisecrethash');
  var src = '/api/v2/properties'; // Use precalculated data from the backend

  if (secret) {
    var s = '?secret=' + secret;
    src += s;
  } else if (token) {
    var s2 = '?token=' + token;
    src += s2;
  }

  $.ajax(src, {
    error: function gotError (err) {
      console.error(err);
    }
    , success: function gotData (data) {
      latestProperties = data;
      client.render();
    }
  });
};

client.render = function render () {

  if (!latestProperties.bgnow && !latestProperties.bgnow.sgvs) {
    console.error('BG data not available');
    return;
  }

  let rec = latestProperties.bgnow.sgvs[0];
  let deltaDisplayValue;

  if (latestProperties.delta) {
    deltaDisplayValue = latestProperties.delta.display;
  }

  let $errorMessage = $('#errorMessage');
  let $inner = $('#inner');

  // If no one measured value found => show "-?-"
  if (!rec) {
    if (!$errorMessage.length) {
      $inner.after('<div id="errorMessage" title="No data found in DB">-?-</div>')
    } else {
      $errorMessage.show();
    }
    $inner.hide();
    return;
  } else {
    $errorMessage.length && $errorMessage.hide();
    $inner.show();
  }

  //Parse face parameters
  let face = $inner.data('face').toLowerCase();

  // Backward compatible
  if (face === 'clock-color') {
    face = 'c' + (window.serverSettings.settings.showClockLastTime ? 'y' : 'n') + '13-sg35-' + (window.serverSettings.settings.showClockDelta ? 'dt14-' : '') + 'nl-ar25-nl-ag6';
  } else if (face === 'clock') {
    face = 'bn0-sg40';
  } else if (face === 'bgclock') {
    face = 'b' + (window.serverSettings.settings.showClockLastTime ? 'y' : 'n') + '13-sg35-' + (window.serverSettings.settings.showClockDelta ? 'dt14-' : '') + 'nl-ar25-nl-ag6';
  } else if (face === 'config') {
    face = $inner.attr('data-face-config');
    $inner.empty();
  }

  let faceParams = face.split('-');
  let bgColor = false;
  let staleMinutes = 13;
  let alwaysShowTime = false;

  let clockCreated = ($inner.children().length > 0);

  for (let param in faceParams) {
    if (param === '0') {
      /* eslint-disable-next-line security/detect-object-injection */ // verified false positive
      let faceParam = faceParams[param];
      bgColor = (faceParam.substr(0, 1) === 'c'); // do we want colorful background?
      alwaysShowTime = (faceParam.substr(1, 1) === 'y'); // always show "stale time" text?
      staleMinutes = (faceParam.substr(2, 2) - 0 >= 0) ? faceParam.substr(2, 2) : 13; // threshold value (0=never)
    } else if (!clockCreated) {
      /* eslint-disable-next-line security/detect-object-injection */ // verified false positive
      let faceParam = faceParams[param];
      let div = '<div class="' + faceParam.substr(0, 2) + '"' + ((faceParam.substr(2, 2) - 0 > 0) ? ' style="' + ((faceParam.substr(0, 2) === 'ar') ? 'height' : 'font-size') + ':' + faceParam.substr(2, 2) + 'vmin"' : '') + '></div>';
      $inner.append(div);
    }
  }

  let displayValue = rec.scaled;

  // Insert the delta value text.
  $('.dt').html(deltaDisplayValue);

  // Color background
  if (bgColor) {

    // These are the particular shades of red, yellow, green, and blue.
    let red = 'rgba(213,9,21,1)';
    let yellow = 'rgba(234,168,0,1)';
    let green = 'rgba(134,207,70,1)';
    let blue = 'rgba(78,143,207,1)';

    // Threshold values
    let bgHigh = client.settings.thresholds.bgHigh;
    let bgLow = client.settings.thresholds.bgLow;
    let bgTargetBottom = client.settings.thresholds.bgTargetBottom;
    let bgTargetTop = client.settings.thresholds.bgTargetTop;

    let bgNum = parseFloat(rec.mgdl);

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

  } else {
    $('body').css('background-color', 'black');
  }

  // Time before data considered stale.
  let threshold = 1000 * 60 * staleMinutes;

  var elapsedms = Date.now() - rec.mills;
  let elapsedMins = Math.floor((elapsedms / 1000) / 60);
  let thresholdReached = (elapsedms > threshold) && threshold > 0;

  // Insert the BG value text, toggle stale if necessary.
  $('.sg').toggleClass('stale', thresholdReached).html(displayValue);

  if (thresholdReached || alwaysShowTime) {
    let staleTimeText;
    if (elapsedMins === 0) {
      staleTimeText = 'Just now';
    } else if (elapsedMins === 1) {
      staleTimeText = '1 minute ago';
    } else {
      staleTimeText = elapsedMins + ' minutes ago';
    }

    $('.ag').html(staleTimeText);
  } else {
    $('.ag').html('');
  }

  // Insert the trend arrow.
  let arrow = $('<img alt="arrow">').attr('src', '/images/' + (!rec.direction || rec.direction === 'NOT COMPUTABLE' ? 'NONE' : rec.direction) + '.svg');

  // Restyle body bg
  if (thresholdReached) {
    $('body').css('background-color', 'grey').css('color', 'black');
    $('.ar').css('filter', 'brightness(0%)').html(arrow);
  } else {
    $('body').css('color', bgColor ? 'white' : 'grey');
    $('.ar').css('filter', bgColor ? 'brightness(100%)' : 'brightness(50%)').html(arrow);
  }

  updateClock();
  
};

function updateClock () {
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
  $('.tm').html(h + ":" + m);
}

client.init = function init () {

  console.log('Initializing clock');
  client.settings = browserSettings(client, window.serverSettings, $);
  client.query();
  setInterval(client.query, 20 * 1000); // update every 20 seconds

  // time update
  setInterval(updateClock, 1000);
};

module.exports = client;
