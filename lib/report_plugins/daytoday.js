'use strict';

const _ = require('lodash');
const moment = window.moment;
const times = require('../times');
const d3 = (global && global.d3) || require('d3');

const daytoday = {
  name: 'daytoday'
  , label: 'Day to day'
  , pluginType: 'report'
};

function init () {
  return daytoday;
}

module.exports = init;

daytoday.html = function html (client) {
  const reportStorage = require('../report/reportstorage');
  const translate = client.translate;
  return '<div class="no-print">' +
      '<h2>' + translate('Day to day') + '</h2>' +
      '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>'
      + translate('Display') + ': ' +
      `<label><input type="checkbox" id="rp_optionsinsulin" ${reportStorage.getValue('insulin') ? "checked" : ""}><span style="color:blue;opacity:0.5"> ${translate('Insulin')} </span></label>` +
      `<label><input type="checkbox" id="rp_optionscarbs" ${reportStorage.getValue('carbs') ? "checked" : ""}><span style="color:red;opacity:0.5">${translate('Carbs')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsbasal" ${reportStorage.getValue('basal') ? "checked" : ""}><span style="color:#0099ff;opacity:0.5">${translate('Basal rate')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsnotes" ${reportStorage.getValue('notes') ? "checked" : ""}>${translate('Notes')}</label>` +
      `<label><input type="checkbox" id="rp_optionsfood" ${reportStorage.getValue('food') ? "checked" : ""}>${translate('Food')}</label>` +
      `<label><input type="checkbox" id="rp_optionsraw" ${reportStorage.getValue('raw') ? "checked" : ""}><span style="color:gray;opacity:1">${translate('Raw')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsiob" ${reportStorage.getValue('iob') ? "checked" : ""}><span style="color:blue;opacity:0.5">${translate('IOB')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionscob" ${reportStorage.getValue('cob') ? "checked" : ""}><span style="color:red;opacity:0.5">${translate('COB')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionspredicted" ${reportStorage.getValue('predicted') ? "checked" : ""}><span style="color:sienna;opacity:0.5">${translate('Predictions')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsopenaps" ${reportStorage.getValue('openAps') ? "checked" : ""}><span style="color:sienna;opacity:0.5">${translate('OpenAPS')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsdistribution" ${reportStorage.getValue('insulindistribution') ? "checked" : ""}><span style="color:blue;opacity:0.5">${translate('Insulin distribution')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsbgcheck" ${reportStorage.getValue('bgcheck') ? "checked" : ""}><span style="color:#ff0000;opacity:0.5">${translate('BG Check')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsothertreatments" ${reportStorage.getValue('othertreatments') ? "checked" : ""}>${translate('View all treatments')}</span></label>` +
      '&nbsp;' + translate('Size') +
      ' <select id="rp_size">' +
      '  <option x="800" y="250">800x250px</option>' +
      '  <option x="1000" y="300">1000x300px</option>' +
      '  <option x="1200" y="400">1200x400px</option>' +
      '  <option x="1550" y="600" selected>1550x600px</option>' +
      '  <option x="2400" y="800">2400x800px</option>' +
      '  <option x="3840" y="1280">3840x1280px</option>' +
      '</select>' +
      '<br>' +
      translate('Scale') + ': ' +
      '<label><input type="radio" name="rp_scale" id="rp_linear" checked>' +
      translate('Linear') + '</label>' +
      '<label><input type="radio" name="rp_scale" id="rp_log">' +
      translate('Logarithmic') + '</label>' +
      `<div id="rp_predictedSettings" ${reportStorage.getValue('predicted') ? '' : 'style="display:none"'}>` +
      translate('Truncate predictions: ') +
      `<input type="checkbox" id="rp_optionsPredictedTruncate" ${reportStorage.getValue('predictedTruncate') ? "checked" : ""}>` +
      '<br>' +
      translate('Predictions offset') + ': ' +
      '<b><label id="rp_predictedOffset"></label> minutes</b>' +
      '&nbsp;&nbsp;&nbsp;&nbsp;' +
      '<input type="button" onclick="Nightscout.predictions.moreBackward();" value="' + translate('-30 min') + '">' +
      '<input type="button" onclick="Nightscout.predictions.backward();" value="' + translate('-5 min') + '">' +
      '<input type="button" onclick="Nightscout.predictions.reset();" value="' + translate('Zero') + '">' +
      '<input type="button" onclick="Nightscout.predictions.forward();" value="' + translate('+5 min') + '">' +
      '<input type="button" onclick="Nightscout.predictions.moreForward();" value="' + translate('+30 min') + '">' +
      '</div>' +
      '</div>' +
      '<div id="daytodaycharts"></div>';
};

daytoday.prepareHtml = function daytodayPrepareHtml (sorteddaystoshow) {
  $('#daytodaycharts').html('');
  sorteddaystoshow.forEach(function eachDay (d) {
    $('#daytodaycharts').append(
        '<div class="single-page"><div id="daytodaychart-' + d + '"></div><div id="daytodaystatchart-' + d + '"></div></div>'
    );
  });
};

daytoday.report = function report_daytoday (datastorage, sorteddaystoshow, options) {
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const profile = client.sbx.data.profile;
  const report_plugins = Nightscout.report_plugins;
  const scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  var tddSum = 0;
  var basalSum = 0;
  var baseBasalSum = 0;
  var bolusSum = 0;
  var carbsSum = 0;
  var proteinSum = 0;
  var fatSum = 0;

  daytoday.prepareHtml(sorteddaystoshow);
  console.log('DAY2DAY', 'sorteddaystoshow', sorteddaystoshow);
  sorteddaystoshow.forEach(function eachDay (day) {

    drawChart(day, datastorage[day], options);
  });

  const tddAverage = tddSum / datastorage.alldays;
  const basalAveragePercent = Math.round( (basalSum / datastorage.alldays) / tddAverage * 100);
  const baseBasalAveragePercent = Math.round( (baseBasalSum / datastorage.alldays) / tddAverage * 100);
  const bolusAveragePercent = Math.round( (bolusSum / datastorage.alldays) / tddAverage * 100);
  const carbsAverage = carbsSum / datastorage.alldays;
  const proteinAverage = proteinSum / datastorage.alldays;
  const fatAverage = fatSum / datastorage.alldays;

  if (options.insulindistribution) {
    let html = '<table class="no-print"><tbody>';
    html += '<tr><td>' + translate('TDD average')          + '</td><td>' + tddAverage.toFixed(1) + ' U</td></tr>';
    html += '<tr><td>' + translate('Bolus average')        + '</td><td>' + bolusAveragePercent + ' %</td></tr>';
    html += '<tr><td>' + translate('Basal average')        + '</td><td>' + basalAveragePercent + ' %</td></tr>';
    html += '<tr><td>' + translate('Base basal average:')  + '</td><td>' + baseBasalAveragePercent + ' %</td></tr>';
    html += '<tr><td>' + translate('Carbs average')        + '</td><td>' + carbsAverage.toFixed(1) + ' g</td></tr>';
    html += '<tr><td>' + translate('Protein average')      + '</td><td>' + proteinAverage.toFixed(1) + ' g</td></tr>';
    html += '<tr><td>' + translate('Fat average')          + '</td><td>' + fatAverage.toFixed(1) + ' g</td></tr>';
    html += '</tbody></table>';
    $('#daytodaycharts').append(html);
  }

  function timeTicks(n,i) {
    var t12 = [
      '12am', '', '2am', '', '4am', '', '6am', '', '8am', '', '10am', '',
      '12pm', '', '2pm', '', '4pm', '', '6pm', '', '8pm', '', '10pm', '', '12am'
    ];
    if (Nightscout.client.settings.timeFormat === 24) {
      return ('00' + i).slice(-2);
    } else {
      return t12[i];
    }
  }

  function drawChart (day, data, options) {
    const dateFn = function(d) { return new Date(d.date); };
    var foodtexts = 0;

    let tickValues = client.ticks(client, {
      scaleY: options.scale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
      , targetTop: options.targetHigh
      , targetBottom: options.targetLow
    });

    // add defs for combo boluses
    var dashWidth = 5;
    d3.select('body')
      .append('svg')
      .append('defs')
      .append('pattern')
      .attr('id', 'hash')
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 6)
      .attr('height', 6)
      .attr('x', 0)
      .attr('y', 0)
      .append('g')
      .style('fill', 'none')
      .style('stroke', '#0099ff')
      .style('stroke-width', 2)
      .append('path').attr('d', 'M0,0 l' + dashWidth + ',' + dashWidth)
      .append('path').attr('d', 'M' + dashWidth + ',0 l-' + dashWidth + ',' + dashWidth);

    // create svg and g to contain the chart contents
    let daytodaychart = d3.select('#daytodaychart-' + day);
    daytodaychart.html(
      '<h3>' + report_plugins.utils.localeDate(moment(day)) + '</h3>'
    )
    let chart = daytodaychart.append('div')
    chart.attr('class', 'chart')

    let charts = chart.append('svg')
        .attr('width', options.width)
        .attr('height', options.height);

    let context = charts.append('svg')
        .attr('viewBox', '0 0 ' + options.width + ' ' + (options.height + 30));

    // define the parts of the axis that aren't dependent on width or height
    let xScale2 = d3.scaleTime()
      .domain(d3.extent(data.sgv, dateFn));

    var yScale2;
    if (options.scale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scaleLog()
        .domain([client.utils.scaleMgdl(options.basal ? 30 : 36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scaleLinear()
        .domain([client.utils.scaleMgdl(options.basal ? -40 : 36), client.utils.scaleMgdl(420)]);
    }

    // allow insulin to be negative (when plotting negative IOB)
    let yInsulinScale = d3.scaleLinear()
      .domain([-2 * options.maxInsulinValue, 2 * options.maxInsulinValue]);

    let yCarbsScale = d3.scaleLinear()
      .domain([0, options.maxCarbsValue * 1.25]);

    let yScaleBasals = d3.scaleLinear();

    const xAxis2 = d3.axisBottom(xScale2)
      .tickFormat(timeTicks)
      .ticks(24);

    const yAxis2 = d3.axisLeft(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues);

    // get current data range
    var dataRange = d3.extent(data.sgv, dateFn);

    // get the entire container height and width subtracting the padding
    var chartHeight = options.height;

    // ranges are based on the width and height available so reset
    xScale2.range([0, options.width]);
    yScale2.range([chartHeight, 0]);
    yInsulinScale.range([chartHeight * 2, 0]);
    yCarbsScale.range([chartHeight, 0]);
    yScaleBasals.range([Number(yScale2(client.utils.scaleMgdl(72))).toFixed(1), chartHeight]);

    // add target BG rect
    context.append('rect')
      .attr('class', 'target-bg')
      .attr('x', Number(xScale2(dataRange[0])).toFixed(1))
      .attr('y', Number(yScale2(options.targetHigh)).toFixed(1))
      .attr('width', options.width)
      .attr('height', Number(yScale2(options.targetLow) - yScale2(options.targetHigh)).toFixed(1));

    // create the x axis container
    context.append('g')
        .attr('class', 'x axis')
        .attr('transform', 'translate(0,' + chartHeight + ')')
        .call(xAxis2)
        .attr('font-size', null)
        .attr('fill', null)
        .attr('font-family', null)
        .attr('text-anchor', null);

    // create the y axis container
    context.append('g')
        .attr('class', 'y axis')
        .call(yAxis2)
        .attr('font-size', null)
        .attr('fill', null)
        .attr('font-family', null)
        .attr('text-anchor', null);

    _.each(tickValues, function(n, li) {
      context.append('line')
        .attr('class', 'high-line')
        .attr('x1', Number(xScale2(dataRange[0])).toFixed(1))
        .attr('y1', Number(yScale2(tickValues[li])).toFixed(1))
        .attr('x2', Number(xScale2(dataRange[1])).toFixed(1))
        .attr('y2', Number(yScale2(tickValues[li])).toFixed(1));
    });

    function prepareContextCircles (sel) {
      var badData = [];
      sel
        .attr('class', function(d) {
          const classes = ['measurement'];
          if (d.color === 'transparent' || (d.color === 'gray' && !options.raw)) {
            classes.push('transparent');
          } else if (d.color === 'gray') {
            classes.push('raw-value');
          } else if (d.color === 'red') {
            classes.push('critical-value');
          } else if (d.color === 'purple') {
            classes.push('prediction-value');
          } else {
            classes.push('normal-value');
          }
          if (d.type === 'mbg') {
            classes.push('mbg');
          }
          return classes.join(' ');
        })
        .attr('cx', function(d) {
          return Number(xScale2(d.date)).toFixed(1);
        })
        .attr('cy', function(d) {
          if (isNaN(d.sgv)) {
            badData.push(d);
            return Number(yScale2(client.utils.scaleMgdl(450))).toFixed(1);
          } else {
            return Number(yScale2(d.sgv)).toFixed(1);
          }
        })
        .on('mouseover', function(d) {
          if (options.openAps && d.openaps) {
            client.tooltip.style('display', 'block');
            var text = '<b>BG:</b> ' + d.openaps.suggested.bg +
              ', ' + d.openaps.suggested.reason +
              (d.openaps.suggested.mealAssist ? ' <b>Meal Assist:</b> ' + d.openaps.suggested.mealAssist : '');
            client.tooltip.html(text)
              .style('left', (d3.event.pageX) + 'px')
              .style('top', (d3.event.pageY + 15) + 'px');
          }
        })
        .on('mouseout', hideTooltip);

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }
      return sel;
    }

    // PREDICTIONS START
    //
    function preparePredictedData () {

      var treatmentsTimestamps = []; // Only timestamps for (carbs and bolus insulin) treatments will be captured in this array
      treatmentsTimestamps.push(dataRange[0]); // Create a fake timestamp at midnight so we can show predictions during night
      for (var i in data.treatments) {
        var treatment = data.treatments[i];
        if (undefined !== treatment.carbs && null != treatment.carbs && treatment.carbs > 0) {
          if (treatment.timestamp)
            treatmentsTimestamps.push(treatment.timestamp);
          else if (treatment.created_at)
            treatmentsTimestamps.push(treatment.created_at);
        }
        if (undefined !== treatment.insulin && treatment.insulin > 0) {
          if (treatment.timestamp)
            treatmentsTimestamps.push(treatment.timestamp);
          else if (treatment.created_at)
            treatmentsTimestamps.push(treatment.created_at);
        }
      }

      var predictions = [];
      if (data && data.devicestatus) {
        for (i = data.devicestatus.length - 1; i >= 0; i--) {
          if (data.devicestatus[i].loop && data.devicestatus[i].loop.predicted) {
            predictions.push(data.devicestatus[i].loop.predicted);
          } else if (data.devicestatus[i].openaps && data.devicestatus[i].openaps.suggested && data.devicestatus[i].openaps.suggested.predBGs) {
            var entry = {};
            entry.startDate = data.devicestatus[i].openaps.suggested.timestamp;
            // For OpenAPS/AndroidAPS we fall back from COB if present, to UAM, then IOB
            if (data.devicestatus[i].openaps.suggested.predBGs.COB) {
              entry.values = data.devicestatus[i].openaps.suggested.predBGs.COB;
            } else if (data.devicestatus[i].openaps.suggested.predBGs.UAM) {
              entry.values = data.devicestatus[i].openaps.suggested.predBGs.UAM;
            } else entry.values = data.devicestatus[i].openaps.suggested.predBGs.IOB;
            predictions.push(entry);
          }
        }
      }

      var p = [];
      if (predictions.length > 0 && treatmentsTimestamps.length > 0) {

        // Iterate over all treatments, find the predictions for each and add them to the predicted array p
        for (var treatmentsIndex = 0; treatmentsIndex < treatmentsTimestamps.length; treatmentsIndex++) {
          var timestamp = treatmentsTimestamps[treatmentsIndex];
          // TODO refactor code so this is set here - now set as global in file loaded by the browser
          var predictedIndex = findPredicted(predictions, timestamp, Nightscout.predictions.offset); // Find predictions offset before or after timestamp

          if (predictedIndex != null) {
            entry = predictions[predictedIndex]; // Start entry
            var d = moment(entry.startDate);
            var end = moment().endOf('day');
            if (options.predictedTruncate) {
              if (Nightscout.predictions.offset >= 0) {
                // If we are looking forward we want to stop at the next treatment
                if (treatmentsIndex < treatmentsTimestamps.length - 1) {
                  end = moment(treatmentsTimestamps[treatmentsIndex + 1]);
                }
              } else {
                // If we are looking back, then we want to stop at "this" treatment
                end = moment(treatmentsTimestamps[treatmentsIndex]);
              }
            }
            for (var entryIndex in entry.values) {
              if (!d.isAfter(end)) {
                var value = {};
                value.sgv = client.utils.scaleMgdl(entry.values[entryIndex]);
                value.date = d.toDate();
                value.color = 'purple';
                p.push(value);
                d.add(5, 'minutes');
              }
            }
          }
        }
      }
      return p;
    }

    /* Find the earliest new predicted instance that has a timestamp equal to or larger than timestamp */
    /* (so if we have bolused or eaten we want to find the prediction that Loop has estimated just after that) */
    /* Returns the index into the predictions array that is the predicted we are looking for */
    function findPredicted (predictions, timestamp, offset) {
      var ts = moment(timestamp).add(offset, 'minutes');
      var predicted = null;
      if (offset && offset < 0) { // If offset is negative, start searching from first prediction going forward
        for (var i = 0; i < predictions.length; i++) {
          if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) <= ts) {
            predicted = i;
          }
        }
      } else { // If offset is positive or zero, start searching from last prediction going backward
        for (i = predictions.length - 1; i > 0; i--) {
          if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) >= ts) {
            predicted = i;
          }
        }
      }
      return predicted;
    }
    //
    // PREDICTIONS ENDS

    // bind up the context chart data to an array of circles
    var contextData = (options.predicted ? data.sgv.concat(preparePredictedData()) : data.sgv);
    var contextCircles = context.selectAll('circle').data(contextData);

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit()
      .remove();

    var from = moment.tz(moment(day), profile.getTimezone( )).startOf('day');
    var to = moment(from.clone( )).add(1, 'days');
    var iobpolyline = ''
      , cobpolyline = '';

    // basals data
    var linedata = [];
    var notemplinedata = [];
    var basalareadata = [];
    var tempbasalareadata = [];
    var comboareadata = [];
    var lastbasal = 0;
    var lastDt = from;
    var lastIOB;
    var basals = context.append('g');

    data.netBasalPositive = [];
    data.netBasalNegative = [];
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
      data.netBasalPositive[hour] = 0;
      data.netBasalNegative[hour] = 0;
    });

    profile.loadData(datastorage.profiles);

    profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

    var bolusInsulin = 0;
    var baseBasalInsulin = 0;
    var positiveTemps = 0;
    var negativeTemps = 0;

    iobpolyline += (xScale2(moment(from))) + ',' + (yInsulinScale(0)) + ' ';
    cobpolyline += (xScale2(moment(from))) + ',' + (yCarbsScale(0)) + ' ';
    var timestart = new Date();
    var cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
    var iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);

    console.log("Device COB status available: ", cobStatusAvailable);
    console.log("Device IOB status available: ", iobStatusAvailable);

    for (var dt = moment(from); dt < to; dt.add(5, 'minutes')) {
      if (options.iob && !iobStatusAvailable) {
        var iob = client.plugins('iob').calcTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).iob;
        // make the graph discontinuous when data is missing
        if (iob === undefined) {
          iobpolyline += ', ' + (xScale2(lastDt)) + ',' + (yInsulinScale(0));
          iobpolyline += ', ' + (xScale2(dt)) + ',' + (yInsulinScale(0));
        } else {
          if (lastIOB === undefined) {
            iobpolyline += ', ' + (xScale2(dt)) + ',' + (yInsulinScale(0));
          }
          iobpolyline += ', ' + (xScale2(dt)) + ',' + (yInsulinScale(iob));
        }
        lastDt = dt.clone();
        lastIOB = iob;
      }
      if (options.cob && !cobStatusAvailable) {
        var cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).cob;
        if (!dt.isSame(from)) {
          cobpolyline += ', ';
        }
        cobpolyline += (xScale2(dt.toDate())) + ',' + (yCarbsScale(cob)) + ' ';
      }
      if (options.basal) {
        var date = dt.format('x');
        var hournow = dt.hour();
        var basalvalue = profile.getTempBasal(date);
        // Calculate basal stats
        baseBasalInsulin += basalvalue.basal * 5 / 60; // 5 minutes part
        var tempPart = (basalvalue.tempbasal - basalvalue.basal) * 5 / 60;
        if (tempPart > 0) {
          positiveTemps += tempPart;
          data.netBasalPositive[hournow] += tempPart;
        }
        if (tempPart < 0) {
          negativeTemps += tempPart;
          data.netBasalNegative[hournow] += tempPart;
        }

        if (!_.isEqual(lastbasal, basalvalue)) {
          linedata.push({ d: date, b: basalvalue.totalbasal });
          notemplinedata.push({ d: date, b: basalvalue.basal });
          if (basalvalue.combobolustreatment && basalvalue.combobolustreatment.relative) {
            tempbasalareadata.push({ d: date, b: basalvalue.tempbasal });
            basalareadata.push({ d: date, b: 0 });
            comboareadata.push({ d: date, b: basalvalue.totalbasal });
          } else if (basalvalue.treatment) {
            tempbasalareadata.push({ d: date, b: basalvalue.totalbasal });
            basalareadata.push({ d: date, b: 0 });
            comboareadata.push({ d: date, b: 0 });
          } else {
            tempbasalareadata.push({ d: date, b: 0 });
            basalareadata.push({ d: date, b: basalvalue.totalbasal });
            comboareadata.push({ d: date, b: 0 });
          }
        }
        lastbasal = basalvalue;
      }
    }

    // Draw COB from devicestatuses if available
    if (cobStatusAvailable) {
      var lastdate = 0;
      var previousdate = 0;
      var cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(cobArray, function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          cobpolyline += ', ';
          cobpolyline += Number(xScale2(previousdate)).toFixed(1) + ',' + Number(yCarbsScale(0)).toFixed(1) + ' ';
          cobpolyline += ', ';
          cobpolyline += Number(xScale2(point.mills)).toFixed(1) + ',' + Number(yCarbsScale(0)).toFixed(1) + ' ';
        }
        cobpolyline += ', ';
        cobpolyline += Number(xScale2(point.mills)).toFixed(1) + ',' + Number(yCarbsScale(point.cob)).toFixed(1) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      cobpolyline += ', ' + Number(xScale2(lastdate)).toFixed(1) + ',' + Number(yCarbsScale(0)).toFixed(1);
    } else {
      cobpolyline += ', ' + Number(xScale2(to)).toFixed(1) + ',' + Number(yCarbsScale(0)).toFixed(1);
    }

    // Draw IOB from devicestatuses if available
    if (iobStatusAvailable) {
      lastdate = 0;
      previousdate = 0;
      var iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(iobArray, function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          iobpolyline += ', ';
          iobpolyline += Number(xScale2(previousdate)).toFixed(1) + ',' + Number(yInsulinScale(0)).toFixed(1) + ' ';
          iobpolyline += ', ';
          iobpolyline += Number(xScale2(point.mills)).toFixed(1) + ',' + Number(yInsulinScale(0)).toFixed(1) + ' ';
        }
        iobpolyline += ', ';
        iobpolyline += Number(xScale2(point.mills)).toFixed(1) + ',' + Number(yInsulinScale(point.iob)).toFixed(1) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      iobpolyline += ', ' + Number(xScale2(lastdate)).toFixed(1) + ',' + Number(yInsulinScale(0)).toFixed(1);
    } else {
      iobpolyline += ', ' + Number(xScale2(to)).toFixed(1) + ',' + Number(yInsulinScale(0)).toFixed(1);
    }

    if (options.iob) {
      context.append('polyline')
        .attr('class', 'iob')
        .attr('points', iobpolyline);
    }
    if (options.cob) {
      context.append('polyline')
        .attr('class', 'cob')
        .attr('points', cobpolyline);
    }

    if (options.basal) {
      var toTempBasal = profile.getTempBasal(to.format('x'));

      linedata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      notemplinedata.push({ d: to.format('x'), b: toTempBasal.basal });
      basalareadata.push({ d: to.format('x'), b: toTempBasal.basal });
      tempbasalareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      comboareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });

      var basalMax = d3.max(linedata, function(d) { return d.b; });
      basalMax = Math.max(basalMax, d3.max(basalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(tempbasalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(comboareadata, function(d) { return d.b; }));

      yScaleBasals.domain([basalMax, 0]);

      var valueline = d3.line()
        .curve(d3.curveStepAfter)
        .x(function(d) { return Number(xScale2(d.d)).toFixed(1); })
        .y(function(d) { return Number(yScaleBasals(d.b)).toFixed(1); });

      var area = d3.area()
        .curve(d3.curveStepAfter)
        .x(function(d) { return Number(xScale2(d.d)).toFixed(1); })
        .y0(yScaleBasals(0))
        .y1(function(d) { return Number(yScaleBasals(d.b)).toFixed(1); });

      basals.append('path')
        .attr('class', 'line basal')
        .attr('d', valueline(linedata))
        .attr('clip-path', 'url(#clip)');

      basals.append('path')
        .attr('class', 'line basal temp')
        .attr('d', valueline(notemplinedata))
        .attr('clip-path', 'url(#clip)');

      basals.append('path')
        .attr('class', 'area basal')
        .datum(basalareadata)
        .attr('d', area);

      basals.append('path')
        .attr('class', 'area temp basal')
        .datum(tempbasalareadata)
        .attr('d', area);

      basals.append('path')
        .attr('class', 'area comboarea')
        .datum(comboareadata)
        .attr('fill', 'url(#hash)')
        .attr('fill-opacity', .3)
        .attr('stroke-width', 1)
        .attr('d', area);

      datastorage.tempbasalTreatments.forEach(function(t) {
        // only if basal and focus interval overlap and there is a chance to fit
        if (t.mills < to.format('x') && t.mills + times.mins(t.duration).msecs > from.format('x')) {
          var text = basals.append('text')
            .attr('class', 'tempbasaltext')
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('fill', '#0099ff')
            .attr('text-anchor', 'middle')
            .attr('dy', '.35em')
            .attr('x', xScale2((Math.max(t.mills, from.format('x')) + Math.min(t.mills + times.mins(t.duration).msecs, to.format('x'))) / 2))
            .attr('y', yScaleBasals(0) - 10)
          //            .text((t.percent ? (t.percent > 0 ? '+' : '') + t.percent + '%' : '') + (t.absolute ? Number(t.absolute).toFixed(2) + 'U' : ''));
          // better hide if not fit
          if (text.node().getBBox().width > xScale2(t.mills + times.mins(t.duration).msecs) - xScale2(t.mills)) {
            text.attr('display', 'none');
          }
        }
      });
    }

    data.treatments.forEach(function(treatment) {
      // Calculate bolus stats
      if (treatment.insulin) {
        bolusInsulin += treatment.insulin;
      }
      // Combo bolus part
      if (treatment.relative) {
        bolusInsulin += treatment.relative;
      }

      var renderNotes = treatment.notes && options.notes;

      if (treatment.eventType === 'Note' && !options.notes) return;

      if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 || renderNotes) {
        var lastfoodtext = foodtexts;
        var drawpointer = false;
        if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 && options.food) {
          var foods = treatment.boluscalc.foods;
          for (var fi = 0; fi < foods.length; fi++) {
            var f = foods[fi];
            var text = '' + f.name + ' ';
            text += '' + (f.carbs * f.portions).toFixed(1) + ' g';
            context.append('text')
              .style('font-size', '10px')
              .style('font-weight', 'normal')
              .attr('fill', 'black')
              .attr('y', foodtexts * 15)
              .attr('transform', 'translate(' + (xScale2(treatment.mills)) + ',0)')
              .html(text);
            foodtexts = (foodtexts + 1) % 6;
            drawpointer = true;
          }
        }
        if (renderNotes && !treatment.duration && treatment.eventType !== 'Temp Basal') {
          context.append('text')
            .style('font-size', '10px')
            .style('font-weight', 'normal')
            .attr('fill', 'black')
            .attr('y', foodtexts * 15)
            .attr('transform', 'translate(' + (xScale2(treatment.mills)) + ',0)')
            .html(treatment.notes);
          foodtexts = (foodtexts + 1) % 6;
          drawpointer = true;
        }
        if (drawpointer) {
          context.append('line')
            .attr('class', 'high-line')
            .attr('x1', xScale2(treatment.mills))
            .attr('y1', lastfoodtext * 15)
            .attr('x2', xScale2(treatment.mills))
            .attr('y2', treatment.carbs ? yCarbsScale(treatment.carbs) : (treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight));
        }
      }

      if (treatment.carbs && options.carbs) {
        var label = ' ' + treatment.carbs + ' g';
        label += treatment.foodType ? ' ' + treatment.foodType : ''
        label += treatment.absorptionTime ? ' ' + (Math.round(treatment.absorptionTime / 60.0 * 10) / 10) + 'h' : ''
        if (treatment.protein) label += ' / ' + treatment.protein + ' g';
        if (treatment.fat) label += ' / ' + treatment.fat + ' g';

        context.append('rect')
          .attr('class', 'carbs treatmentRect')
          .attr('y', Number(yCarbsScale(treatment.carbs)).toFixed(1))
          .attr('height', Number(chartHeight - yCarbsScale(treatment.carbs)).toFixed(1))
          .attr('width', 5)
          .attr('transform', 'translate(' + Number(xScale2(treatment.mills)).toFixed(1) + ',0)');
        context.append('text')
          .attr('class', 'carbs treatmentText')
          .attr('transform', 'rotate(-45,' + Number(xScale2(treatment.mills)).toFixed(1) + ',' + Number(yCarbsScale(treatment.carbs)).toFixed(1) + ') ' +
            'translate(' + Number(xScale2(treatment.mills) + 10).toFixed(1) + ',' + Number(yCarbsScale(treatment.carbs)).toFixed(1) + ')')
          .text('' + label);
      }

      if (treatment.insulin && options.insulin) {
        var dataLabel = client.utils.toRoundedStr(treatment.insulin, 2)+ 'U';
        context.append('rect')
          .attr('class', 'insulin treatmentRect')
          .attr('y', Number(yInsulinScale(treatment.insulin)).toFixed(1))
          .attr('height', Number(chartHeight - yInsulinScale(treatment.insulin)).toFixed(1))
          .attr('width', 5)
          .attr('transform', 'translate(' + Number(xScale2(treatment.mills) - 2).toFixed(1) + ',0)');
        context.append('text')
          .attr('class', 'insulin treatmentText')
          //.attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'rotate(-45,' + Number(xScale2(treatment.mills) - 2).toFixed(1) + ',' + Number(yInsulinScale(treatment.insulin)).toFixed(1) + ')' +
            'translate(' + Number(xScale2(treatment.mills) + 10).toFixed(1) + ',' + Number(yInsulinScale(treatment.insulin)).toFixed(1) + ')')
          .text(dataLabel);
      }

      // process the rest
      if (treatment.insulin || treatment.carbs || treatment.eventType === 'Temp Basal' || treatment.eventType === 'Combo Bolus') {
        // ignore
      } else if (treatment.eventType === 'Profile Switch') {
        // profile switch
        appendProfileSwitch(context, treatment);
        if (treatment.duration && !treatment.cuttedby) {
          appendProfileSwitch(context, {
            cutting: treatment.profile
            , profile: client.profilefunctions.activeProfileToTime(times.mins(treatment.duration).msecs + treatment.mills + 1)
            , mills: times.mins(treatment.duration).msecs + treatment.mills
            , end: true
          });
        }
      } else if (treatment.eventType === 'Exercise' && treatment.duration) {
        context.append('rect')
          .attr('x', Number(xScale2(treatment.mills)).toFixed(1))
          .attr('y', Number(yScale2(client.utils.scaleMgdl(396))).toFixed(1))
          .attr('width', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills)).toFixed(1))
          .attr('height', Number(yScale2(client.utils.scaleMgdl(360)) - yScale2(client.utils.scaleMgdl(396))).toFixed(1))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'Violet');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Violet')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', Number(yScale2(client.utils.scaleMgdl(378))).toFixed(1))
          .attr('x', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs / 2)).toFixed(1))
          .text(treatment.notes);
      } else if (treatment.eventType === 'Note' && treatment.duration) {
        context.append('rect')
          .attr('x', Number(xScale2(treatment.mills)).toFixed(1))
          .attr('y', Number(yScale2(client.utils.scaleMgdl(360))).toFixed(1))
          .attr('width', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills)).toFixed(1))
          .attr('height', Number(yScale2(client.utils.scaleMgdl(324)) - yScale2(client.utils.scaleMgdl(360))).toFixed(1))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'Salmon');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Salmon')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', Number(yScale2(client.utils.scaleMgdl(342))).toFixed(1))
          .attr('x', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs / 2)).toFixed(1))
          .text(treatment.notes);
      } else if (treatment.eventType === 'OpenAPS Offline' && treatment.duration) {
        context.append('rect')
          .attr('class', 'open-aps treatment')
          .attr('x', Number(xScale2(treatment.mills)).toFixed(1))
          .attr('y', Number(yScale2(client.utils.scaleMgdl(324))).toFixed(1))
          .attr('width', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills)).toFixed(1))
          .attr('height', Number(yScale2(client.utils.scaleMgdl(288)) - yScale2(client.utils.scaleMgdl(324))).toFixed(1));
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Brown')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', yScale2(client.utils.scaleMgdl(306)))
          .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs / 2))
          .text(treatment.notes);
      } else if (treatment.eventType === 'Temporary Override' && treatment.duration ) {
         // Loop Overrides with duration
         context.append('rect')
           .attr('x', xScale2(treatment.mills))
           .attr('y', yScale2(client.utils.scaleMgdl(432)))
           .attr('width', xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills))
           .attr('height', yScale2(client.utils.scaleMgdl(396)) - yScale2(client.utils.scaleMgdl(432)))
           .attr('stroke-width', 1)
           .attr('opacity', .2)
           .attr('stroke', 'white')
           .attr('fill', 'black');
         context.append('text')
           .style('font-size', '12px')
           .style('font-weight', 'bold')
           .attr('fill', 'black')
           .attr('text-anchor', 'middle')
           .attr('dy', '.35em')
           .attr('y', yScale2(client.utils.scaleMgdl(414)))
           .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs / 2))
           .text(treatment.reason);
      } else if (treatment.eventType === 'BG Check' && !treatment.duration && options.bgcheck) {
        context.append('circle')
           .attr('class', 'measurement bg-check')
           .attr('cx', Number(xScale2(treatment.mills)).toFixed(1))
           .attr('cy', Number(yScale2(scaledTreatmentBG(treatment, data.sgv))).toFixed(1));
      } else if (!treatment.duration && options.othertreatments) {
        // other treatments without duration
        context.append('circle')
          .attr('class', 'measurement other')
          .attr('cx', Number(xScale2(treatment.mills)).toFixed(1))
          .attr('cy', Number(yScale2(scaledTreatmentBG(treatment, data.sgv))).toFixed(1))
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'purple')
          .attr('y', Number(yScale2(scaledTreatmentBG(treatment, data.sgv)) - 10).toFixed(1))
          .attr('x', Number(xScale2(treatment.mills) + 10).toFixed(1))
          .text(translate(client.careportal.resolveEventName(treatment.eventType)));
      } else if (treatment.duration && options.othertreatments) {
        // other treatments with duration
        context.append('rect')
          .attr('x', Number(xScale2(treatment.mills)).toFixed(1))
          .attr('y', Number(yScale2(client.utils.scaleMgdl(432))).toFixed(1))
          .attr('width', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills)).toFixed(1))
          .attr('height', Number(yScale2(client.utils.scaleMgdl(396)) - yScale2(client.utils.scaleMgdl(432))).toFixed(1))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'black');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'black')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', Number(yScale2(client.utils.scaleMgdl(414))).toFixed(1))
          .attr('x', Number(xScale2(treatment.mills + times.mins(treatment.duration).msecs / 2)).toFixed(1))
          .text(treatment.notes);
      } else {
        console.log("missed treatment", treatment);
      }
    });

    if (options.insulindistribution) {
      var boluscolor = 'blue';
      var basalcolor = '#0099ff';

      console.log('Insulin for day: ' + day + ' bolus: ' + bolusInsulin + ' basebasal: ' + baseBasalInsulin + ' positiveTemps: ' + positiveTemps + ' negativeTemps: ' + negativeTemps);
      var table = $('<table>');
      $('<tr><td><b>' + translate('Bolus insulin:') + '</b></td><td align="right">' + bolusInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      if (positiveTemps > 0 || negativeTemps > 0) {
        $('<tr><td>' + translate('Base basal insulin:') + '</td><td align="right">' + baseBasalInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      if (positiveTemps > 0) {
        $('<tr><td>' + translate('Positive temp basal insulin:') + '</td><td align="right">' + positiveTemps.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      if (negativeTemps < 0) {
        $('<tr><td>' + translate('Negative temp basal insulin:') + '</td><td align="right">' + negativeTemps.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      var totalBasalInsulin = baseBasalInsulin + positiveTemps + negativeTemps;
      $('<tr><td><b>' + translate('Total basal insulin:') + '</b></td><td align="right">' + totalBasalInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      var totalDailyInsulin = bolusInsulin + baseBasalInsulin + positiveTemps + negativeTemps;
      $('<tr><td><b>' + translate('Total daily insulin:') + '</b></td><td align="right">' + totalDailyInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);

      $('<tr><td>' + translate('Total carbs') + ':</td><td align="right">' + data.dailyCarbs + ' g</td></tr>').appendTo(table);
      $('<tr><td>' + translate('Total protein') + ':</td><td align="right">' + data.dailyProtein + ' g</td></tr>').appendTo(table);
      $('<tr><td>' + translate('Total fat') + ':</td><td align="right">' + data.dailyFat + ' g</td></tr>').appendTo(table);

      $('<tr><td colspan="2"><span id="daytodaystatinsulinpiechart-' + day + '"></span><span id="daytodaystatcarbspiechart-' + day + '"></span></td></tr>').appendTo(table);
      $('#daytodaystatchart-' + day).append(table);

      var chartData = [
        {
          label: translate('Basal')
          , count: totalBasalInsulin
          , pct: (totalBasalInsulin / totalDailyInsulin * 100).toFixed(0)
        }
        , { label: translate('Bolus'), count: bolusInsulin, pct: (bolusInsulin / totalDailyInsulin * 100).toFixed(0) }
      ];

      // Insulin distribution chart
      var width = 120;
      var height = 120;
      var radius = Math.min(width, height) / 2;

      var color = d3.scaleOrdinal().range([basalcolor, boluscolor]);

      var labelArc = d3.arc()
        .outerRadius(radius / 2)
        .innerRadius(radius / 2);

      var svg = d3.select('#daytodaystatinsulinpiechart-' + day)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', 'translate(' + (width / 2) +
          ',' + (height / 2) + ')');

      var arc = d3.arc()
        .innerRadius(0)
        .outerRadius(radius);

      var pie = d3.pie()
        .value(function(d) {
          return d.count;
        })
        .sort(null);

      var insulg = svg.selectAll('.insulinarc')
        .data(pie(chartData))
        .enter()
        .append('g')
        .attr('class', 'insulinarc');

      insulg.append('path')
        .attr('d', arc)
        .attr('opacity', '0.5')
        .attr('fill', function(d) {
          return color(d.data.label);
        });

      insulg.append('text')
        .attr('transform', function(d) {
          return 'translate(' + labelArc.centroid(d) + ')';
        })
        .attr('dy', '.15em')
        .style('font-weight', 'bold')
        .attr('text-anchor', 'middle')
        .text(function(d) {
          return d.data.pct + '%';
        });

      // Carbs pie chart

      var carbscolor = d3.scaleOrdinal().range(['red']);

      var carbsData = [
        { label: translate('Carbs'), count: data.dailyCarbs }
      ];

      var carbssvg = d3.select('#daytodaystatcarbspiechart-' + day)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', 'translate(' + (width / 2) +
          ',' + (height / 2) + ')');

      var carbsarc = d3.arc()
        .outerRadius(radius * data.dailyCarbs / options.maxDailyCarbsValue);

      var carbspie = d3.pie()
        .value(function(d) {
          return d.count;
        })
        .sort(null);

      var carbsg = carbssvg.selectAll('.carbsarc')
        .data(carbspie(carbsData))
        .enter()
        .append('g')
        .attr('class', 'carbsarc');

      carbsg.append('path')
        .attr('d', carbsarc)
        .attr('opacity', '0.5')
        .attr('fill', function(d) {
          return carbscolor(d.data.label);
        });

      carbsg.append('text')
        .attr('transform', function() {
          return 'translate(0,0)';
        })
        .attr('dy', '.15em')
        .style('font-weight', 'bold')
        .attr('text-anchor', 'middle')
        .text(function(d) {
          return d.data.count + 'g';
        });
    }

    tddSum += totalDailyInsulin;
    basalSum += totalBasalInsulin;
    baseBasalSum += baseBasalInsulin;
    bolusSum += bolusInsulin;
    carbsSum += data.dailyCarbs;
    proteinSum += data.dailyProtein;
    fatSum += data.dailyFat;

    appendProfileSwitch(context, {
      //eventType: 'Profile Switch'
      profile: client.profilefunctions.activeProfileToTime(from)
      , mills: from + times.mins(15).msecs
      , first: true
    });

    function appendProfileSwitch (context, treatment) {

      if (!treatment.cutting && !treatment.profile) { return; }

      var sign = treatment.first ? '▲▲▲' : '▬▬▬';
      var text;
      if (treatment.cutting) {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.cutting) + '    ' + '►►►' + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      } else {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      }
      context.append('text')
        .style('font-size', 12)
        .style('font-weight', 'bold')
        .attr('fill', '#0099ff')
        .attr('text-anchor', 'start')
        .attr('dy', '.35em')
        .attr('transform', 'rotate(-90 ' + (xScale2(treatment.mills)) + ',' + (yScaleBasals(0) - 10) + ') ' +
          'translate(' + (xScale2(treatment.mills)) + ',' + (yScaleBasals(0) - 10) + ')')
        .text(text);
    }

    console.log("Rendering " + day, new Date().getTime() - timestart.getTime(), "msecs");
  }

  function hideTooltip () {
    client.tooltip.style('display', 'none');
  }
};
