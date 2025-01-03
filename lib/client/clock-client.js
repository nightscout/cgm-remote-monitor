'use strict';

var browserSettings = require('./browser-settings');
var client = {};
var latestProperties = {};

client.query = function query () {
  var parts = (location.search || '?').substring(1).split('&');
  var token = '';
  parts.forEach(function (val) {
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
  } else {
    face = $inner.data('face');
  }

  let faceParams = face.split('-');
  let bgColor = false;
  let staleMinutes = 13;
  let alwaysShowTime = false;

  let clockCreated = ($inner.children().length > 0);

  // These are the particular shades of red, yellow, green, and blue.
  let red = 'rgba(213,9,21,1)';
  let arrowRed = '#D50915';
  let yellow = 'rgba(234,168,0,1)';
  let arrowYellow = '#EAA800';
  let green = 'rgba(134,207,70,1)';
  let arrowGreen = '#86CF46';
  let blue = 'rgba(78,143,207,1)';
  let arrowBlue = '#4E8FCF';
  

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
      
      let classParam = faceParam.substr(0, 2);
      let colorParam = (classParam.charAt(0) == classParam.charAt(0).toUpperCase());
      classParam = classParam.toLowerCase();
      let sizeParam = '';
      if (faceParam.substr(2, 2) - 0 > 0) {
        sizeParam = faceParam.substr(2, 2);
      }
      let paramStyle = '';
      if (sizeParam) {
        if (classParam === 'ar') {
          paramStyle = (paramStyle + 'width: ' + sizeParam + 'vmin;');
        } else {
          paramStyle = (paramStyle + 'font-size: ' + sizeParam + 'vmin;');
        }
      }
      
      let div = '<div class="' + classParam + (colorParam ? ' color' : '') + '" style="' + paramStyle + '"></div>';
      $inner.append(div);
    }
  }

  let displayValue = rec.scaled;

  // Insert the delta value text.
  $('.dt').html(deltaDisplayValue);

  // Threshold values
  let bgHigh = client.settings.thresholds.bgHigh;
  let bgLow = client.settings.thresholds.bgLow;
  let bgTargetBottom = client.settings.thresholds.bgTargetBottom;
  let bgTargetTop = client.settings.thresholds.bgTargetTop;

  let bgNum = parseFloat(rec.mgdl);

  // Color background
  if (bgColor) {

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
  
  //Text color
  let arrowColor = '#FFFFFF';
  if (bgNum < bgLow) {
    $('.color').css('color', red);
    if ($('.ar').hasClass('color')) {
      arrowColor = arrowRed;
    }
  }
  if ((bgLow <= bgNum) && (bgNum < bgTargetBottom)) {
    $('.color').css('color', blue);
    if ($('.ar').hasClass('color')) {
      arrowColor = arrowBlue;
    }
  }
  if ((bgTargetBottom <= bgNum) && (bgNum < bgTargetTop)) {
    $('.color').css('color', green);
    if ($('.ar').hasClass('color')) {
      arrowColor = arrowGreen;
    }
  }
  if ((bgTargetTop <= bgNum) && (bgNum < bgHigh)) {
    $('.color').css('color', yellow);
    if ($('.ar').hasClass('color')) {
      arrowColor = arrowYellow;
    }
  }
  if (bgNum >= bgHigh) {
    $('.color').css('color', red);
    if ($('.ar').hasClass('color')) {
      arrowColor = arrowRed;
    }
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
  let trendArrow = {
    'NONE': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;"}</style><polygon class="st0" points="761.3,200.5 761.3,370.8 169.3,370.8 169.3,200.5"/></svg>'
	, 'Flat': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="761.3,283.1 504,85.2 504,200.5 169.3,200.5 169.3,370.8 504,370.8 504,482.7 "/></svg>'
    , 'FortyFiveDown': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="675.2,492.6 633.2,170.7 551.7,252.3 315,15.6 194.5,136.1 431.2,372.8 352.1,451.9 "/></svg>'
    , 'FortyFiveUp': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="674,74 352.1,116 433.6,197.5 197,434.2 317.4,554.7 554.1,318 633.2,397.1 "/></svg>'
    , 'SingleDown': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="466.1,579.9 664.1,322.6 548.7,322.6 548.7,-12.1 378.4,-12.1 378.4,322.6 266.5,322.6 "/></svg>'
    , 'SingleUp': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="464.4,-12.1 266.5,245.2 381.8,245.2 381.8,579.9 552.2,579.9 552.2,245.2 664.1,245.2 "/></svg>'
    , 'DoubleDown': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="693.6,579.9 891.6,322.6 776.2,322.6 776.2,-12.1 605.9,-12.1 605.9,322.6 494,322.6 "/><polygon class="st0" points="267.4,579.9 465.3,322.6 350,322.6 350,-12.1 179.6,-12.1 179.6,322.6 67.7,322.6 "/></svg>'
    , 'DoubleUp': '<svg alt=arrow" version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="67.7 -12.1 823.8 592" style="enable-background:new 67.7 -12.1 823.8 592;" xml:space="preserve"><style type="text/css">.st0{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><polygon class="st0" points="265.6,-12.1 67.7,245.2 183,245.2 183,579.9 353.4,579.9 353.4,245.2 465.3,245.2 "/><polygon class="st0" points="691.9,-12.1 494,245.2 609.3,245.2 609.3,579.9 779.7,579.9 779.7,245.2 891.6,245.2 "/></svg>'
    , 'TripleDown': '<svg alt=arrow" viewBox="0 0 1238 593" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"><style type="text/css">.arrowPath{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><path class="arrowPath" d="M619.6 593.9 L817.6 336.6 702.2 336.6 702.2 1.9 531.9 1.9 531.9 336.6 420 336.6 Z" fill-opacity="1" stroke="none"/><path class="arrowPath" d="M200.4 593.9 L398.3 336.6 283 336.6 283 1.9 112.6 1.9 112.6 336.6 0.7 336.6 Z" fill-opacity="1" stroke="none"/><path class="arrowPath" d="M1039.4 593.9 L1237.3 336.6 1122 336.6 1122 1.9 951.6 1.9 951.6 336.6 839.7 336.6 Z" fill-opacity="1" stroke="none"/></svg>'
    , 'TripleUp': '<svg alt=arrow" viewBox="0 0 1238 593" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"><style type="text/css">.arrowPath{fill:' + arrowColor + ';stroke-width:4;stroke:#000000;}</style><path class="arrowPath" d="M619.6 1.9 L817.6 259.2 702.2 259.2 702.2 593.9 531.9 593.9 531.9 259.2 420 259.2 Z" fill-opacity="1" stroke="none"/><path class="arrowPath" d="M200.4 1.9 L398.3 259.2 283 259.2 283 593.9 112.6 593.9 112.6 259.2 0.7 259.2 Z" fill-opacity="1" stroke="none"/><path class="arrowPath" d="M1039.4 1.9 L1237.3 259.2 1122 259.2 1122 593.9 951.6 593.9 951.6 259.2 839.7 259.2 Z" fill-opacity="1" stroke="none"/></svg>'
  };
  let arrow = $(trendArrow[(!rec.direction || rec.direction === 'NOT COMPUTABLE' ? 'NONE' : rec.direction)]);
  $('.ar').html(arrow);


  // Restyle body bg
  if (thresholdReached) {
    $('body').css('background-color', 'grey').css('color', 'black');
    $('.color').css('color', 'black');;
    $('.ar').css('filter', 'brightness(0%)');
  } else {
    /*$('body').css('color', bgColor ? 'white' : 'grey');
    $('.ar').not('.color').css('filter', bgColor ? 'brightness(100%)' : 'brightness(50%)');
    $('.ar.color').css('filter','brightness(100%)');*/
	$('body').css('color', 'white');
	$('.ar').css('filter','brightness(100%)');
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
