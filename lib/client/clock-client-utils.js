'use strict';

var clientUtils = {};

// owm globals
var latestWeather = {};
var owmUnits = '';
var owmZip = '';
var owmKey = '';

// graph globals
var graphWidth = 0;
var graphHeight = 0;
var graphRadius = 0;
var graphHours = 0;
var accumSGV = [];
var lastTreatmentDate = null;
var treatmentData = {};
var outstandingSGVReq = false;

clientUtils.pluginInfo = function pluginInfo(iob, cob, basal, dbsize, cage, sage, iage, bage, upbat, sensorState,
                                             pump_data, pump_override, openaps_status, loop_display, loop_lastPredicted) {
  var pluginDisplayValue = '';

  if (iob && iob.display) {
    pluginDisplayValue += ' iob:' + iob.display.toLowerCase();
  }
  if (cob && cob.display) {
    pluginDisplayValue += ' cob:' + cob.display.toLowerCase();
  }
  if (basal && basal.display) {
    pluginDisplayValue += ' ' + basal.display.toLowerCase().replace(/ /g,'');
  }
  if (dbsize && dbsize.display) {
    pluginDisplayValue += ' db:' + dbsize.display.toLowerCase();
  }
  if (cage && cage.display) {
    if (cage.level > 0) {
      pluginDisplayValue += ' <div class="cage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">CAGE:' +
        cage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' cage:' + cage.display.toLowerCase();
    }
  }
  if (sage && sage['Sensor Start'] && sage['Sensor Start'].display) {
    if (sage['Sensor Start'].level > 0) {
      pluginDisplayValue += ' <div class="sage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">SAGE:' +
        sage['Sensor Start'].display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' sage:' + sage['Sensor Start'].display.toLowerCase();
    }
  }
  if (iage && iage.display) {
    if (iage.level > 0) {
      pluginDisplayValue += ' <div class="iage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">IAGE:' +
        iage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' iage:' + iage.display.toLowerCase();
    }
  }
  if (bage && bage.display) {
    if (bage.level > 0) {
      pluginDisplayValue += ' <div class="bage" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">BAGE:' +
        bage.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' bage:' + bage.display.toLowerCase();
    }
  }
  if (upbat && upbat.display) {
    if (upbat.level <= 25) {
      pluginDisplayValue += ' <div class="upbat" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">UP:' +
        upbat.display.toLowerCase() + '</div>';
    } else {
      pluginDisplayValue += ' up:' + upbat.display.toLowerCase();
    }
  }
  if (pump_data) {
    if (pump_data.status && pump_data.status.display) {
      if (pump_data.level > 0) {
        pluginDisplayValue += ' <div class="pump" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">P:' +
          pump_data.status.display + '</div>';
      } else {
        pluginDisplayValue += ' p:' + pump_data.status.display.toLowerCase();
      }
    }
    if (pump_data.reservoir && pump_data.reservoir.display) {
      if (pump_data.reservoir.level ? (pump_data.reservoir.level > 0) : (pump_data.level > 0)) {
        pluginDisplayValue += ' <div class="reservoir" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">R:' +
          pump_data.reservoir.display.toLowerCase().replace(/ /g,'') + '</div>';
      } else {
        pluginDisplayValue += ' r:' + pump_data.reservoir.display.toLowerCase().replace(/ /g,'');
      }
    }
    if (pump_data.battery && pump_data.battery.display) {
      if (pump_data.battery.level > 0) {
        pluginDisplayValue += ' <div class="pumpbat" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">PB:' +
          pump_data.battery.display.toLowerCase() + '</div>';
      } else {
        pluginDisplayValue += ' pb:' + pump_data.battery.display.toLowerCase();
      }
    }
  }
  if (pump_override && pump_override.active && pump_override.name && pump_override.active === true) {
    pluginDisplayValue += ' ovrd:' + pump_override.name;
  }
  if (openaps_status && openaps_status.symbol) {
    if ((openaps_status.symbol !== '⌁') && (openaps_status.symbol !== '↻')) {
      pluginDisplayValue += ' <div class="openaps" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">OAPS:' +
        openaps_status.symbol + '</div>';
    } else {
      pluginDisplayValue += ' oaps:' + openaps_status.symbol;
    }
  }
  if (loop_display && loop_display.symbol) {
    let lastPredDisp = '';
    if (loop_lastPredicted && loop_lastPredicted.values && (loop_lastPredicted.values.length > 0)) {
      lastPredDisp = ' ↝' + loop_lastPredicted.values[loop_lastPredicted.values.length-1];
    }
    if ((loop_display.symbol !== '⌁') && (loop_display.symbol !== '↻')) {
      pluginDisplayValue += ' <div class="loop" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">LOOP:' +
        loop_display.symbol + lastPredDisp + '</div>';
    } else {
      pluginDisplayValue += ' loop:' + loop_display.symbol + lastPredDisp;
    }
  }
  if (sensorState && sensorState.lastStateStringShort) {
    if (sensorState.level > 0) {
      pluginDisplayValue += ' <div class="sensorstate" style="background-color:grey; color:black; display: inline-block; border: 1px solid white;">CGM:' +
        sensorState.lastStateStringShort;
      if (sensorState.lastVoltageB !== undefined) {
        pluginDisplayValue += ' VB:' + sensorState.lastVoltageB;
      }
      pluginDisplayValue += '</div>';
    } else {
      pluginDisplayValue += ' cgm:' + sensorState.lastStateStringShort.toLowerCase();
      if (sensorState.lastVoltageB !== undefined) {
        pluginDisplayValue += ' vb:' + sensorState.lastVoltageB;
      }
    }
  }

  return pluginDisplayValue;
}

clientUtils.queryOWM = function queryOWM () {
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
      window.Nightscout.client.render();
    }
  });
}

clientUtils.setOWMParams = function setOWMParams(inOWMUnits, inOWMZip, inOWMKey) {
  owmUnits = inOWMUnits.toUpperCase();
  owmZip = inOWMZip.replace(/ /g,'%20');
  owmKey = inOWMKey;
}

clientUtils.weatherInfo = function weatherInfo () {
  let weatherDisplayValue = "";
  if (latestWeather.main && latestWeather.weather && latestWeather.main.temp && latestWeather.weather[0] && latestWeather.weather[0].main) {
    weatherDisplayValue = latestWeather.main.temp.toFixed(0) + "°" + owmUnits;
    if (latestWeather.main.feels_like && latestWeather.main.feels_like.toFixed(0) !== latestWeather.main.temp.toFixed(0)) {
      weatherDisplayValue += " (" + latestWeather.main.feels_like.toFixed(0) + "°" + owmUnits + ")";
    }
    weatherDisplayValue += " " + latestWeather.weather[0].main.toLowerCase();
  }
  return weatherDisplayValue;
}

clientUtils.getGraphHours = function getGraphHours() {
  return graphHours;
}

clientUtils.getLastTreatmentDate = function getLastTreatmentDate() {
  return lastTreatmentDate;
}

clientUtils.processTreatments = function processTreatments(data) {
  let render = false;
  for (let i = data.length - 1; i >= 0; i--) {
    render = true;
    if (i == 0) {
      lastTreatmentDate = data[0].created_at;
    }
    let event = data[i].eventType;
    if (event && (event == 'Announcement') || (event == 'Profile Switch') || (event == 'Exercise')) {
      treatmentData[event] = data[i];
    }
    if (render) {
      window.Nightscout.client.render();
    }
  }
}

function treatmentsDisplay() {
  let value = '';
  if ($('.gt').css('font-size')) {
    let fsz = $('.gt').css('font-size');
    value = '<div style="position: absolute"><table style="line-height: normal; font-size: ' + fsz + '">';
    let now = Date.now();
    const graphTime = graphHours * 60 * 60 * 1000;
    if (treatmentData['Announcement']) {
      let elapsedms = now - Date.parse(treatmentData['Announcement'].created_at);
      if (elapsedms < graphTime) {
        value += '<tr><td>Annc:</td><td>' + treatmentData['Announcement'].notes + '</td><td>' + Math.floor(elapsedms / 1000 / 60) + ' min ago</td></tr>';
      }
    }
    if (treatmentData['Profile Switch']) {
      let elapsedms = now - Date.parse(treatmentData['Profile Switch'].created_at);
      if (elapsedms < graphTime) {
        value += '<tr><td>Prof:</td><td>' + treatmentData['Profile Switch'].profile;
        if (treatmentData['Profile Switch'].duration > 0) {
          value += ', ' + treatmentData['Profile Switch'].duration + ' min';
        }
        value += '</td><td>' + Math.floor(elapsedms / 1000 / 60) + ' min ago</td></tr>';
      }
    }
    if (treatmentData['Exercise']) {
      let elapsedms = now - Date.parse(treatmentData['Exercise'].created_at);
      if (elapsedms < graphTime) {
        value += '<tr><td>Exer:</td><td>' + treatmentData['Exercise'].notes;
        if (treatmentData['Exercise'].duration > 0) {
          value += ', ' + treatmentData['Exercise'].duration + ' min';
        }
        value += '</td><td>' + Math.floor(elapsedms / 1000 / 60) + ' min ago</td></tr>';
      }
    }
    value += '</table></div>';
  }
  return value;
}

clientUtils.setGraphParams = function setGraphParams(inGraphWidth, inGraphHeight, inGraphRadius, inGraphHours) {
  graphWidth = inGraphWidth;
  graphHeight = inGraphHeight;
  graphRadius = inGraphRadius;
  graphHours = inGraphHours;
}

clientUtils.fetchGraphSGVs = function fetchGraphSGVs () {
  if ((graphHours <= 0) || (outstandingSGVReq == true)) {
    return;
  }
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

  outstandingSGVReq = true;
  $.ajax(src, {
    error: function gotError (err) {
      outstandingSGVReq = false;
      console.error(err);
    }
    , success: function gotData (data) {
      outstandingSGVReq = false;
      if (data) {
        for (var i = data.length - 1; i >= 0; i--) {  // go thru it backwards so we accum the most recent data last
          if (data[i] && data[i].date && data[i].sgv) {
            let mills = data[i].date;
            let mgdl = data[i].sgv;
            let minute = (((mills / 1000 / 60) + 0.5) % (graphHours * 60)).toFixed();
            accumSGV[minute] = [mills, mgdl];
          }
        }
        if (accumSGV.filter(x => x !== undefined).length >= 10) {
          window.Nightscout.client.render();
        }
      }
    }
  });
}

function formatTimeHHMMA(d) {
  function z(n){return (n<10?'0':'')+n}
  let h = d.getHours();
  let m = d.getMinutes();
  let t;
  if (window.Nightscout.client.settings.timeFormat && (window.Nightscout.client.settings.timeFormat === 24)) {
    t = z(h) + ':' + z(m);
  } else {
    t = (h%12 || 12) + ':' + z(m); // + ' ' + (h<12? 'AM' :'PM');
  }
  return t;
}

clientUtils.graphInfo = function graphInfo (buckets) {
  if ((graphHours > 0) && (accumSGV.filter(x => x !== undefined).length < 10)) {
    clientUtils.fetchGraphSGVs();
  }

  // 1) loop thru latestProperties.buckets, add them to accumSGV
  if (buckets) {
    for (let i in buckets) {
      if (buckets[i] && buckets[i].sgvs && 
          buckets[i].sgvs[0] && buckets[i].sgvs[0].mills && buckets[i].sgvs[0].mgdl) {
        let mills = buckets[i].sgvs[0].mills;
        let mgdl = buckets[i].sgvs[0].mgdl;
        let minute = (((mills / 1000 / 60) + 0.5) % (graphHours * 60)).toFixed();
        accumSGV[minute] = [mills, mgdl];
      }
    }
  }

  if (buckets && graphHours > 0) {
    // 2) loop thru accumSGV to create graph
    let thresholds = window.Nightscout.client.settings.thresholds;
    let units = 'px';
    let graphHTML = '<div id="graph" style="width: ' + graphWidth + units + '; height: ' + graphHeight + units + '; border: 1px solid grey; position: relative; background-color: black;">';
    const graphMinutes = graphHours * 60;
    const graphMills = graphMinutes * 60 * 1000;
    const offsetPct = 100 * (graphRadius / graphWidth);
    const chartFactor = .1;
    let maxMGDL = thresholds.bgTargetTop * (1 + chartFactor);
    let minMGDL = 40; // even more dynamic: thresholds.bgTargetBottom * (1 - chartFactor);

    for (let i in accumSGV) {
      let mills = accumSGV[i][0];
      let bg = accumSGV[i][1];
      if (bg < 40) {
        bg = 40;
      } else if (bg > 400) {
        bg = 400;
      }
      let xPct = 100 * (mills - (Date.now() - graphMills)) / graphMills;
      xPct = xPct - offsetPct; // leave some margin since points are non-zero size
      if ((xPct >= 0) && (xPct <= 100)) {
        if ((bg * (1 + chartFactor)) > maxMGDL) {
          maxMGDL = bg * (1 + chartFactor);
          if (maxMGDL > 400) {
            maxMGDL = 400;
          }
        }
      }
    }
    for (let i in accumSGV) {
      let mills = accumSGV[i][0];
      let bg = accumSGV[i][1];
      let xPct = 100 * (mills - (Date.now() - graphMills)) / graphMills;
      let yPct = 100 * (bg - minMGDL) / (maxMGDL - minMGDL);
      if (yPct > 100) {
        yPct = 100;
      }
      if (yPct < 0) {
        yPct = 0;
      }
      xPct = xPct - offsetPct; // leave some margin since points are non-zero size
      yPct = yPct - (offsetPct * 1.5);
      let bgColor = 'green';
      if (bg > thresholds.bgHigh) {
        bgColor = 'red';
      } else if (bg > thresholds.bgTargetTop) {
        bgColor = 'yellow';
      } else if (bg < thresholds.bgLow) {
        bgColor = 'red';
      } else if (bg < thresholds.bgTargetBottom) {
        bgColor = 'yellow';
      }
      if ((xPct >= 0) && (xPct <= 100)) {
        graphHTML += '<div style="position: absolute; margin-right: 0vmin; margin-left: 0vmin; bottom: ' + yPct + '%; left: ' + xPct + '%; width: ' + graphRadius + 'px; height: ' + graphRadius + 'px; background-color: ' + bgColor + '; border-radius: 100%;"></div>';
      } else if (xPct < 0) {
        delete accumSGV[i];
      }
    }

    // add nightscout-like dashed lines at the thresholds/targets:
    let yPct;
    yPct = (100 * (thresholds.bgTargetTop - minMGDL) / (maxMGDL - minMGDL)) - offsetPct;
    if ((yPct >= 0) && (yPct <= 100)) {
      graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dashed grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    }
    yPct = (100 * (thresholds.bgTargetBottom - minMGDL) / (maxMGDL - minMGDL)) - offsetPct;
    if ((yPct >= 0) && (yPct <= 100)) {
      graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dashed grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    }
    yPct = (100 * (thresholds.bgHigh - minMGDL) / (maxMGDL - minMGDL)) - offsetPct;
    if ((yPct >= 0) && (yPct <= 100)) {
      graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dotted grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    }
    yPct = (100 * (thresholds.bgLow - minMGDL) / (maxMGDL - minMGDL)) - offsetPct;
    if ((yPct >= 0) && (yPct <= 100)) {
      graphHTML += '<hr style="width: 100%; height: 0px; border: 1px dotted grey; bottom: ' + yPct + '%; margin: 0 auto; position: absolute;">';
    }
    // add axis annotations:
    let maxBGText = maxMGDL.toFixed();
    let minBGText = minMGDL.toFixed();
    if (units === 'mmol') {
      const mmolPerMGDL = 0.0555;
      maxBGText = (maxMGDL * mmolPerMGDL).toFixed(1);
      minBGText = (minMGDL * mmolPerMGDL).toFixed(1);
    }
    if ($('.gl').css('font-size')) {
      let fsz = $('.gl').css('font-size');
      graphHTML += '<span style="position: absolute; bottom: 100%; right: 0%; color: dimgrey; font-size: ' + fsz + '; line-height: normal;">' + maxBGText + '</span>';
      graphHTML += '<span style="position: absolute; top: 100%; right: 0%; color: dimgrey; font-size: ' + fsz + '; line-height: normal;">' + minBGText + '</span>';
      let d = new Date();
      d.setHours(d.getHours() - graphHours);
      graphHTML += '<span style="position: absolute; top: 100%; left: 0%; color: dimgrey; font-size: ' + fsz + '; line-height: normal;">' + formatTimeHHMMA(d) + '</span>';
    }

    graphHTML += treatmentsDisplay();

    return graphHTML;
  }

  return '';
}

module.exports = clientUtils;
