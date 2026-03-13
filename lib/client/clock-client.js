'use strict';

var browserSettings = require('./browser-settings');
var clientUtils = require('./clock-client-utils');
var client = {};
var latestProperties = {};
var alwaysShowTime = false;
var staleMinutes = 13;

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
  var treatmentSrc = '/api/v2/treatments';

  if (secret) {
    var s = '?secret=' + secret;
    src += s;
    treatmentSrc += s + '&';
  } else if (token) {
    var s2 = '?token=' + token;
    src += s2;
    treatmentSrc += s2 + '&';
  } else {
    treatmentSrc += '?';
  }

  const d = new Date();
  treatmentSrc += "find[eventType][$ne]=Temp+Basal&find[created_at][$lte]=" + d.toISOString();
  if (clientUtils.getLastTreatmentDate() != null) {
    treatmentSrc += "&find[created_at][$gt]=" + clientUtils.getLastTreatmentDate();
  } else {
    treatmentSrc += "&count=30";
  }

  $.ajax(src, {
    error: function gotError (err) {
      client.render();  // even on failures must update the stale data state
      console.error(err);
    }
    , success: function gotData (data) {
      latestProperties = data;
      client.render();
    }
  });

  if (clientUtils.getGraphHours() > 0) {
    $.ajax(treatmentSrc, {
      error: function gotError (jqXHR, textStatus, errorThrown) {
        //var data = [{"eventType":"Announcement","notes":"client err:"+textStatus+"/"+errorThrown,"created_at":d.toISOString()}];
        //clientUtils.processTreatments(data);
        console.error(err);
      }
      , success: function gotData (data) {
        clientUtils.processTreatments(data);
      }
    });
  }
};

client.render = function render () {

  if (!latestProperties.bgnow || !latestProperties.bgnow.sgvs) {
    console.error('BG data not available');
    return;
  }

  let rec = latestProperties.bgnow.sgvs[0];
  let deltaDisplayValue = '';

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

  let bgNum = parseFloat(rec.mgdl);
  let displayValue;
  if (bgNum === 9) {
    displayValue = '';
  } else if (bgNum < 39) {
    displayValue = bgNum + '??';
  } else if (bgNum < 40) {
    displayValue = 'LOW';
  } else if (bgNum > 400) {
    displayValue = 'HIGH';
  } else {
    displayValue = rec.scaled;
  }
  
  // Insert the delta value text.
  $('.dt').html(deltaDisplayValue);

  let pluginDisplayValue = clientUtils.pluginInfo(latestProperties.iob, latestProperties.cob, latestProperties.basal, latestProperties.dbsize,
                                                  latestProperties.cage, latestProperties.sage, latestProperties.iage, latestProperties.bage,
                                                  latestProperties.upbat, latestProperties.sensorState,
                                                  latestProperties.pump ? latestProperties.pump.data : null,
                                                  latestProperties.pump ? latestProperties.pump.override : null,
                                                  latestProperties.openaps ? latestProperties.openaps.status : null,
                                                  latestProperties.loop ? latestProperties.loop.display : null,
                                                  latestProperties.loop ? latestProperties.loop.lastPredicted : null);
  $('.pl').html(pluginDisplayValue);
  $('.ow').html(clientUtils.weatherInfo());
  $('.gr').html(clientUtils.graphInfo(latestProperties.buckets));

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

    // Threshold background coloring.
    if (bgNum < bgLow) {
      $('body').css('background-color', red);
      $('.pl').css('background-color', red);
    }
    if ((bgLow <= bgNum) && (bgNum < bgTargetBottom)) {
      $('body').css('background-color', blue);
      $('.pl').css('background-color', blue);
    }
    if ((bgTargetBottom <= bgNum) && (bgNum < bgTargetTop)) {
      $('body').css('background-color', green);
      $('.pl').css('background-color', green);
    }
    if ((bgTargetTop <= bgNum) && (bgNum < bgHigh)) {
      $('body').css('background-color', yellow);
      $('.pl').css('background-color', yellow);
    }
    if (bgNum >= bgHigh) {
      $('body').css('background-color', red);
      $('.pl').css('background-color', red);
    }
  } else {
    $('body').css('background-color', 'black');
    $('.pl').css('background-color', 'black');
  }

  // Insert the BG value text
  $('.sg').html(displayValue);

  // Insert the trend arrow.
  let arrow = $('<img alt="arrow">').attr('src', '/images/' + (!rec.direction || rec.direction === 'NOT COMPUTABLE' ? 'NONE' : rec.direction) + '.svg');

  // Restyle body bg
  let thresholdReached = updateClock();
  if (thresholdReached) {
    $('body').css('background-color', 'grey').css('color', 'black');
    $('.ar').css('filter', 'brightness(0%)').html(arrow);
    $('.pl').css('background-color', 'black').css('color', 'grey');
  } else {
    $('body').css('color', bgColor ? 'white' : 'grey');
    $('.ar').css('filter', bgColor ? 'brightness(100%)' : 'brightness(50%)').html(arrow);
    $('.pl').css('color', bgColor ? 'white' : 'grey');
  }
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
  $('.da').html(today.toLocaleString(client.settings.language, { month: 'short', day: 'numeric', weekday: 'short' }).split(" at ")[0]);

  // Update stale time text and stale class
  if (latestProperties && latestProperties.bgnow && latestProperties.bgnow.sgvs) {
    let threshold = 1000 * 60 * staleMinutes;
    let elapsedms = Date.now() - latestProperties.bgnow.sgvs[0].mills;
    let elapsedMins = Math.floor((elapsedms / 1000) / 60);
    let thresholdReached = (elapsedms > threshold) && threshold > 0;

    $('.sg').toggleClass('stale', thresholdReached);
    $('.dt').toggleClass('stale', thresholdReached);

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
    return thresholdReached;
  }

  return false;
}

function timerClock() {
  let thresholdReached = updateClock();
  let today = new Date();
  if (thresholdReached && ((today.getSeconds() % 20) === 0)) {
    // ensure the screen reflects threshold reached, in case the client query process has died (which has been seen)
    client.render();
  }
}

client.updateParams = function updateParams () {
  let $inner = $('#inner');
  let face = $inner.data('face').toLowerCase();
  if (face === 'config') {
      face = $inner.attr('data-face-config');
  }
  let faceParams = face.split('-');
  for (let param in faceParams) {
    let faceParam = faceParams[param];

    // open weathermap params: -ow{font size}:{F|C}:{zip}:{api key}
    // example: -ow16:F:01108:D17C57239B5661055D459A608F770208 (note: this example is not a valid OWM key)
    if (faceParam.substr(0, 2) === 'ow') {
      const owmParams = faceParam.substr(2).split(':');
      clientUtils.setOWMParams(owmParams[1], owmParams[2], owmParams[3]);
    }

    // SGV graph size params: -gr{width}:{height}:{radius pixels}:{hours}
    // example: -gr100:100:10:1
    // not completed (support lacking for threshold exceeded): :{overlaySGV bool} note: if overlaySGV is 1 then width,height are in %, otherwise pixels
    if (faceParam.substr(0, 2) === 'gr') {
      const graphParams = faceParam.substr(2).split(':');
      clientUtils.setGraphParams(graphParams[0], graphParams[1], graphParams[2], graphParams[3]);
    }
  }
};

client.queryOWM = function queryOWM () {
  clientUtils.queryOWM();
}

client.fetchInitialSGVs = function fetchInitialSGVs () {
  clientUtils.fetchGraphSGVs();
}

client.init = function init () {

  console.log('Initializing clock');
  client.settings = browserSettings(client, window.serverSettings, $);
  client.updateParams();
  client.query();
  setInterval(client.query, 20 * 1000); // update every 20 seconds

  // time update
  setInterval(timerClock, 1000);

  // open weathermap:
  client.queryOWM();
  setInterval(client.queryOWM, 20 * 60 * 1000); // update every 20 minutes

  client.fetchInitialSGVs();
};

module.exports = client;
