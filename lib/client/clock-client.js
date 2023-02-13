'use strict';

var browserSettings = require('./browser-settings');
var client = {};
var latestProperties = {};
var latestWeather = {};
var owmUnits = '';
var owmZip = '';
var owmKey = '';
var graphWidth = 0;
var graphHeight = 0;
var graphRadius = 0;
var graphOverlaySGV = '0';
var graphHours = 0;
var accumSGV = [];

client.queryOWM = function queryOWM () {
  if (owmKey === '') {
    return;
  }
  let units = 'imperial';
  if (owmUnits === 'C') {
    units = 'metric';
  }
  var src = 'https://api.openweathermap.org/data/2.5/weather?zip=' + owmZip + '&units=' + units + '&APPID=' + owmKey;
  $.ajax(src, {
    error: function gotError (err) {
      console.error(err);
    }
    , success: function gotData (data) {
      latestWeather = data;
      client.render();
    }
  });
}

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
      client.render();  // even on failures must update the stale data state
      console.error(err);
    }
    , success: function gotData (data) {
      latestProperties = data;
      client.render();
    }
  });
};

function fetchInitialSGVs () {
  var parts = (location.search || '?').substring(1).split('&');
  var token = '';
  parts.forEach(function(val) {
    if (val.startsWith('token=')) {
      token = val.substring('token='.length);
    }
  });

  var secret = localStorage.getItem('apisecrethash');
  const count = graphHours * 60; // it is ok to fetch extra data for CGM's that read every 5 minutes vs every 1 minute
  var src = '/api/v1/entries/sgv.json?count=' + count;

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
      if (data) {
        for (var i = data.length - 1; i >= 0; i--) {  // go thru it backwards so we accum the most recent data last
          if (data[i] && data[i].date && data[i].sgv) {
            let mills = data[i].date;
            let mgdl = data[i].sgv;
            let minute = (((mills / 1000 / 60) + 0.5) % (graphHours * 60)).toFixed();
            accumSGV[minute] = [mills, mgdl];
          }
        }
        if (accumSGV.length >= 10) {
          client.render();
        }
      }
    }
  });
}

function pluginInfo() {
  var pluginDisplayValue = '';

  if (latestProperties.iob && latestProperties.iob.display) {
    pluginDisplayValue += ' iob:' + latestProperties.iob.display.toLowerCase();
  }
  if (latestProperties.basal && latestProperties.basal.display) {
    pluginDisplayValue += ' ' + latestProperties.basal.display.toLowerCase().replace(/ /g,'');
  }
  if (latestProperties.dbsize && latestProperties.dbsize.display) {
    pluginDisplayValue += ' db:' + latestProperties.dbsize.display.toLowerCase();
  }
  if (latestProperties.cage && latestProperties.cage.display) {
    if (latestProperties.cage.level > 0) {
      pluginDisplayValue += ' <div class="cage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">CAGE:' + latestProperties.cage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' cage:' + latestProperties.cage.display.toLowerCase();
    }
  }
  if (latestProperties.sage && latestProperties.sage['Sensor Start'] && latestProperties.sage['Sensor Start'].display) {
    if (latestProperties.sage['Sensor Start'].level > 0) {
      pluginDisplayValue += ' <div class="sage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">SAGE:' + latestProperties.sage['Sensor Start'].display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' sage:' + latestProperties.sage['Sensor Start'].display.toLowerCase();
    }
  }
  if (latestProperties.iage && latestProperties.iage.display) {
    if (latestProperties.iage.level > 0) {
      pluginDisplayValue += ' <div class="iage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">IAGE:' + latestProperties.iage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' iage:' + latestProperties.iage.display.toLowerCase();
    }
  }
  if (latestProperties.bage && latestProperties.bage.display) {
    if (latestProperties.bage.level > 0) {
      pluginDisplayValue += ' <div class="bage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">BAGE:' + latestProperties.bage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' bage:' + latestProperties.bage.display.toLowerCase();
    }
  }
  if (latestProperties.upbat && latestProperties.upbat.display) {
    if (latestProperties.upbat.level <= 25) {
      pluginDisplayValue += ' <div class="upbat" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">UP:' + latestProperties.upbat.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' up:' + latestProperties.upbat.display.toLowerCase();
    }
  }
  if (latestProperties.pump && latestProperties.pump.data && latestProperties.pump.data.status && latestProperties.pump.data.status.display) {
    if (latestProperties.pump.data.level > 0) {
      pluginDisplayValue += ' <div class="pump" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">P:' + latestProperties.pump.data.status.display + '</div>';
    } else {
      pluginDisplayValue += ' p:' + latestProperties.pump.data.status.display.toLowerCase();
    }
    if (latestProperties.pump.data.reservoir && latestProperties.pump.data.reservoir.display) {
      if (latestProperties.pump.data.reservoir.level > 0) {
        pluginDisplayValue += ' <div class="reservoir" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">R:' + latestProperties.pump.data.reservoir.display.toLowerCase() + '</div>';
      } else {
        pluginDisplayValue += ' r:' + latestProperties.pump.data.reservoir.display.toLowerCase();
      }
    }
    if (latestProperties.pump.data.battery && latestProperties.pump.data.battery.display) {
      if (latestProperties.pump.data.battery.level > 0) {
        pluginDisplayValue += ' <div class="pumpbat" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">PB:' + latestProperties.pump.data.battery.display.toLowerCase() + '</div>';
      } else {
        pluginDisplayValue += ' pb:' + latestProperties.pump.data.battery.display.toLowerCase();
      }
    }
  }
  if (latestProperties.openaps && latestProperties.openaps.status && latestProperties.openaps.status.symbol) {
    if ((latestProperties.openaps.status.symbol !== '⌁') &&
        (latestProperties.openaps.status.symbol !== '↻')) {
      pluginDisplayValue += ' <div class="openaps" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">OAPS:' + latestProperties.openaps.status.symbol + '</div>';
    } else {
      pluginDisplayValue += ' oaps:' + latestProperties.openaps.status.symbol;
    }
  }
  if (latestProperties.sensorState && latestProperties.sensorState.lastStateStringShort) {
    if (latestProperties.sensorState.level > 0) {
      pluginDisplayValue += ' <div class="sensorstate" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">CGM:' + latestProperties.sensorState.lastStateStringShort;
      if (latestProperties.sensorState.lastVoltageB !== undefined) {
        pluginDisplayValue += ' VB:' + latestProperties.sensorState.lastVoltageB;
      }
      pluginDisplayValue += '</div>';
    } else {
      pluginDisplayValue += ' cgm:' + latestProperties.sensorState.lastStateStringShort.toLowerCase();
      if (latestProperties.sensorState.lastVoltageB !== undefined) {
        pluginDisplayValue += ' vb:' + latestProperties.sensorState.lastVoltageB;
      }
    }
  }

  return pluginDisplayValue;
}

function graphInfo () {
  if ((graphHours > 0) && (accumSGV.length < 10)) {
    fetchInitialSGVs();
  }

  // 1) loop thru latestProperties.buckets, add them to accumSGV
  if (latestProperties.buckets) {
    for (let i in latestProperties.buckets) {
      if (latestProperties.buckets[i] && latestProperties.buckets[i].sgvs && 
          latestProperties.buckets[i].sgvs[0] && latestProperties.buckets[i].sgvs[0].mills && latestProperties.buckets[i].sgvs[0].mgdl) {
        let mills = latestProperties.buckets[i].sgvs[0].mills;
        let mgdl = latestProperties.buckets[i].sgvs[0].mgdl;
        let minute = (((mills / 1000 / 60) + 0.5) % (graphHours * 60)).toFixed();
        accumSGV[minute] = [mills, mgdl];
      }
    }
  }
  // 2) loop thru accumSGV to create graph
  let units = (graphOverlaySGV == '1') ? '%' : 'px';
  let graphHTML = '<div id="graph" style="width: ' + graphWidth + units + '; height: ' + graphHeight + units + '; border: 1px solid grey; position: relative; background-color: black;">';
  const graphMinutes = graphHours * 60;
  const graphMills = graphMinutes * 60 * 1000;
  const offsetPct = 100 * (graphRadius / graphWidth);
  const maxMGDL = 500;
  for (let i in accumSGV) {
    let mills = accumSGV[i][0];
    let bg = accumSGV[i][1];
    let xPct = 100 * (mills - (Date.now() - graphMills)) / graphMills;
    let yPct = 100 * bg / maxMGDL;
    if (yPct > 100) {
      yPct = 100;
    }
    if (yPct < 0) {
      yPct = 0;
    }
    xPct = xPct - offsetPct; // leave some margin since points are non-zero size
    yPct = yPct - (offsetPct * 1.5);
    let bgColor = 'green';
    if (bg > client.settings.thresholds.bgHigh) {
      bgColor = 'red';
    } else if (bg > client.settings.thresholds.bgTargetTop) {
      bgColor = 'yellow';
    } else if (bg < client.settings.thresholds.bgLow) {
      bgColor = 'red';
    } else if (bg < client.settings.thresholds.bgTargetBottom) {
      bgColor = 'yellow';
    }
    if ((xPct >= 0) && (xPct <= 100)) {
      graphHTML += '<div style="position: absolute; margin-right: 0vmin; margin-left: 0vmin; bottom: ' + yPct + '%; left: ' + xPct + '%; width: ' + graphRadius + 'px; height: ' + graphRadius + 'px; background-color: ' + bgColor + '; border-radius: 100%;"></div>';
    }
  }
  if (graphOverlaySGV != '1') {
    // add nightscout-like dashed lines at the thresholds/targets:
    let yPct;
    yPct = (100 * client.settings.thresholds.bgTargetTop / maxMGDL) - offsetPct;
    graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dashed grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    yPct = (100 * client.settings.thresholds.bgTargetBottom / maxMGDL) - offsetPct;
    graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dashed grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    yPct = (100 * client.settings.thresholds.bgHigh / maxMGDL) - offsetPct;
    graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dotted grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    yPct = (100 * client.settings.thresholds.bgLow / maxMGDL) - offsetPct;
    graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dotted grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
  }

  return graphHTML;
}

client.render = function render () {

  if (!latestProperties.bgnow || !latestProperties.bgnow.sgvs) {
    console.error('BG data not available');
    return;
  }

  let rec = latestProperties.bgnow.sgvs[0];
  let deltaDisplayValue;

  if (latestProperties.delta) {
    deltaDisplayValue = latestProperties.delta.display;
  }

  let pluginDisplayValue = pluginInfo();

  // process latestWeather:
  let weatherDisplayValue = "";
  if (latestWeather.main && latestWeather.weather && latestWeather.main.temp && latestWeather.weather[0] && latestWeather.weather[0].main) {
    weatherDisplayValue = latestWeather.main.temp.toFixed(0) + "°" + owmUnits;
    if (latestWeather.main.feels_like && latestWeather.main.feels_like.toFixed(0) !== latestWeather.main.temp.toFixed(0)) {
      weatherDisplayValue += " (" + latestWeather.main.feels_like.toFixed(0) + "°" + owmUnits + ")";
    }
    weatherDisplayValue += " " + latestWeather.weather[0].main.toLowerCase();
  }

  // process buckets for graph:
  let graphHTMLPre = "";
  let graphHTMLPost = "";
  if (latestProperties.buckets && graphHours > 0) {
    graphHTMLPre = graphInfo();
    graphHTMLPost = '</div>';
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

  let displayValue;
  if (graphOverlaySGV == '1') {
    displayValue = graphHTMLPre + rec.scaled + graphHTMLPost;
  } else {
    displayValue = rec.scaled;
    $('.gr').html(graphHTMLPre + graphHTMLPost);
  }

  // Insert the delta value text.
  $('.dt').html(deltaDisplayValue);
  $('.ow').html(weatherDisplayValue);
  $('.pl').html(pluginDisplayValue);
  
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
    $('.pl').css('background-color', 'black').css('color', 'grey');
  } else {
    $('body').css('color', bgColor ? 'white' : 'grey');
    $('.ar').css('filter', bgColor ? 'brightness(100%)' : 'brightness(50%)').html(arrow);
    $('.pl').css('color', bgColor ? 'white' : 'grey');
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
      owmUnits = owmParams[1].toUpperCase();
      owmZip = owmParams[2].replace(/ /g,'%20');
      owmKey = owmParams[3];
    }

    // SGV graph size params: -gr{width}:{height}:{radius pixels}:{hours}
    // example: -gr100:100:10:1
    // not completed (support lacking for threshold exceeded): :{overlaySGV bool} note: if overlaySGV is 1 then width,height are in %, otherwise pixels
    if (faceParam.substr(0, 2) === 'gr') {
      const graphParams = faceParam.substr(2).split(':');
      graphWidth = graphParams[0];
      graphHeight = graphParams[1];
      graphRadius = graphParams[2];
      graphHours = graphParams[3];
      //graphOverlaySGV = graphParams[4];
    }
  }
};

client.init = function init () {

  console.log('Initializing clock');
  client.settings = browserSettings(client, window.serverSettings, $);
  client.query();
  setInterval(client.query, 20 * 1000); // update every 20 seconds

  // time update
  setInterval(updateClock, 1000);

  client.updateParams();

  // open weathermap:
  if (owmKey !== '') {
    client.queryOWM();
    setInterval(client.queryOWM, 20 * 60 * 1000); // update every 20 minutes
  }

  if (graphHours > 0) {
    fetchInitialSGVs();
  }
};

module.exports = client;
