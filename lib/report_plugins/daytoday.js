'use strict';

const _ = require('lodash');
const moment = window.moment;
const times = require('../times');
const d3 = (global && global.d3) || require('d3');
const htmlUtils = require('../utils/html');

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

  return `<div class="no-print">
<h2>${translate('Day to day')}</h2>
<b>${translate('To see this report, press SHOW while in this view')}</b>
<div>${translate('Scale')}:
<label><input type="radio" name="rp_scale" id="rp_linear" checked> ${translate('Linear')}</label>
<label><input type="radio" name="rp_scale" id="rp_log">${translate('Logarithmic')}</label>
</div>
<div>${translate('Display')}:
<label><input type="checkbox" id="rp_optionsinsulin" ${reportStorage.getValue('insulin') ? "checked" : ""}><span class="report-option insulin-option">${translate('Insulin')}</span></label>
<label><input type="checkbox" id="rp_optionscarbs" ${reportStorage.getValue('carbs') ? "checked" : ""}><span class="report-option carbs-option">${translate('Carbs')}</span></label>
<label><input type="checkbox" id="rp_optionsbasal" ${reportStorage.getValue('basal') ? "checked" : ""}><span class="report-option basal-option">${translate('Basal rate')}</span></label>
<label><input type="checkbox" id="rp_optionsnotes" ${reportStorage.getValue('notes') ? "checked" : ""}>${translate('Notes')}</label>
<label><input type="checkbox" id="rp_optionsfood" ${reportStorage.getValue('food') ? "checked" : ""}>${translate('Food')}</label>
<label><input type="checkbox" id="rp_optionsraw" ${reportStorage.getValue('raw') ? "checked" : ""}><span class="report-option raw-option">${translate('Raw')}</span></label>
<label><input type="checkbox" id="rp_optionsiob" ${reportStorage.getValue('iob') ? "checked" : ""}><span class="report-option iob-option">${translate('IOB')}</span></label>
<label><input type="checkbox" id="rp_optionscob" ${reportStorage.getValue('cob') ? "checked" : ""}><span class="report-option cob-option">${translate('COB')}</span></label>
<label><input type="checkbox" id="rp_optionspredicted" ${reportStorage.getValue('predicted') ? "checked" : ""}><span class="report-option predictions-option">${translate('Predictions')}</span></label>
<label><input type="checkbox" id="rp_optionsopenaps" ${reportStorage.getValue('openAps') ? "checked" : ""}><span class="report-option openaps-option">${translate('OpenAPS')}</span></label>
<label><input type="checkbox" id="rp_optionsdistribution" ${reportStorage.getValue('insulindistribution') ? "checked" : ""}><span class="report-option insulin-option">${translate('Insulin distribution')}</span></label>
<label><input type="checkbox" id="rp_optionsbgcheck" ${reportStorage.getValue('bgcheck') ? "checked" : ""}><span class="report-option bgcheck-option">${translate('BG Check')}</span></label>
<label><input type="checkbox" id="rp_optionsothertreatments" ${reportStorage.getValue('othertreatments') ? "checked" : ""}>${translate('View all treatments')}</label>
</div>
<div id="rp_predictedSettings" class="${reportStorage.getValue('predicted') ? '' : 'is-hidden'}">${translate('Truncate predictions: ')}<input type="checkbox" id="rp_optionsPredictedTruncate" ${reportStorage.getValue('predictedTruncate') ? "checked" : ""}>
<br>${translate('Predictions offset')}:
<b><label id="rp_predictedOffset"></label>${translate('minutes')}</b>
<input type="button" onclick="Nightscout.predictions.moreBackward();" value="${translate('-30 min')}">
<input type="button" onclick="Nightscout.predictions.backward();" value="${translate('-5 min')}">
<input type="button" onclick="Nightscout.predictions.reset();" value="${translate('Zero')}">
<input type="button" onclick="Nightscout.predictions.forward();" value="${translate('+5 min')}">
<input type="button" onclick="Nightscout.predictions.moreForward();" value="${translate('+30 min')}">
</div>
</div>
<div id="daytodaycharts"></div>`;
};

daytoday.prepareHtml = function daytodayPrepareHtml (sorteddaystoshow) {
  $('#daytodaycharts').html('');
  sorteddaystoshow.forEach(function eachDay (d) {
    $('#daytodaycharts').append(
      `<div class="single-page"><div id="daytodaychart-${d}"></div><div id="daytodaystatchart-${d}"></div></div>`
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

  let tddSum = 0;
  let basalSum = 0;
  let baseBasalSum = 0;
  let bolusSum = 0;
  let carbsSum = 0;
  let proteinSum = 0;
  let fatSum = 0;

  daytoday.prepareHtml(sorteddaystoshow);
  console.log('DAY2DAY', 'sorteddaystoshow', sorteddaystoshow);
  sorteddaystoshow.forEach(function eachDay (day) {

    drawChart(day, datastorage[day], options);
  });

  const tddAverage = tddSum / datastorage.alldays;
  const bolusAveragePercent = Math.round((bolusSum / datastorage.alldays) / tddAverage * 100);
  const basalAveragePercent = Math.round((basalSum / datastorage.alldays) / tddAverage * 100);
  const baseBasalAveragePercent = Math.round((baseBasalSum / datastorage.alldays) / tddAverage * 100);
  const carbsAverage = carbsSum / datastorage.alldays;
  const proteinAverage = proteinSum / datastorage.alldays;
  const fatAverage = fatSum / datastorage.alldays;

  if (options.insulindistribution) {
    $('#daytodaycharts').append(`
<table class="no-print insulin">
  <tbody>
    <tr><td>${translate('TDD average')}</td><td>${tddAverage.toFixed(1)} ${translate('U')}</td></tr>
    <tr><td>${translate('Bolus average')}</td><td>${bolusAveragePercent} %</td></tr>
    <tr><td>${translate('Basal average')}</td><td>${basalAveragePercent} %</td></tr>
    <tr><td>${translate('Base basal average:')}</td><td>${baseBasalAveragePercent} %</td></tr>
    <tr><td>${translate('Carbs average')}</td><td>${carbsAverage.toFixed(1)} g</td></tr>
    <tr><td>${translate('Protein average')}</td><td>${proteinAverage.toFixed(1)} g</td></tr>
    <tr><td>${translate('Fat average')}</td><td>${fatAverage.toFixed(1)} g</td></tr>
  </tbody>
</table>
`);
  }

  function drawChart (day, data, options) {
    const dateFn = function(d) { return new Date(d.date); };
    let foodtexts = 0;
    const cformat = d3.format(".1f");

    let tickValues = client.ticks(client, {
      scaleY: options.scale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
      , targetTop: options.targetHigh
      , targetBottom: options.targetLow
    });

    let daytodaychart = d3.select('#daytodaychart-' + day);
    daytodaychart.html(
      `<h3>${report_plugins.utils.localeDate(moment(day))}</h3>`
    )
    let chart = daytodaychart.append('div')
    chart.attr('class', 'chart daytoday-chart')

    const container = chart.node();
    const width = container && container.clientWidth ? container.clientWidth : 800;
    const height = container && container.clientHeight ? container.clientHeight : 500;
    const chartWidth = Math.max(100, width - 60);
    const chartHeight = Math.max(100, height - 30);

    // create svg contain the chart contents
    let context = chart.append('svg')
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('viewBox', [-60, 0, width, height]);

    // add defs for combo boluses
    const dashWidth = 5;
    context.append('defs')
      .append('pattern')
      .attr('id', 'hash')
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('width', 6)
      .attr('height', 6)
      .attr('x', 0)
      .attr('y', 0)
      .append('g')
      .attr('class', 'combo-pattern')
      .append('path').attr('d', 'M0,0 l' + dashWidth + ',' + dashWidth)
      .append('path').attr('d', 'M' + dashWidth + ',0 l-' + dashWidth + ',' + dashWidth);

    // get current data range
    const dataRange = d3.extent(data.sgv, dateFn);

    // define the parts of the axis that aren't dependent on width or height
    let xScale2 = d3.scaleUtc().domain(dataRange);

    let yScale2;
    if (options.scale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scaleLog().domain([client.utils.scaleMgdl(options.basal ? 30 : 36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scaleLinear().domain([client.utils.scaleMgdl(options.basal ? -40 : 36), client.utils.scaleMgdl(420)]);
    }

    // allow insulin to be negative (when plotting negative IOB)
    let yInsulinScale = d3.scaleLinear().domain([-2 * options.maxInsulinValue, 2 * options.maxInsulinValue]);
    let yCarbsScale = d3.scaleLinear().domain([0, options.maxCarbsValue * 1.25]);
    let yScaleBasals = d3.scaleLinear();
    // ranges are based on the width and height available so reset
    xScale2.range([0, chartWidth]);
    yScale2.range([chartHeight, 0]);

    yInsulinScale.range([chartHeight * 2, 0]);
    yCarbsScale.range([chartHeight, 0]);
    yScaleBasals.range([cformat(yScale2(client.utils.scaleMgdl(55))), chartHeight]);

    // add target BG rect
    context.append('rect')
      .attr('class', 'target-bg')
      .attr('x', cformat(xScale2(dataRange[0])))
      .attr('y', cformat(yScale2(options.targetHigh)))
      .attr('width', chartWidth)
      .attr('height', cformat(yScale2(options.targetLow) - yScale2(options.targetHigh)));

    // create the x-axis container
    context.append('g')
      .attr('class', 'x axis')
      .attr('transform', `translate(0, ${chartHeight})`)
      .call(d3.axisBottom(xScale2).tickFormat(d3.timeFormat(Nightscout.client.settings.timeFormat === 24 ? "%H" : "%I %p")).ticks(24))
      .attr('font-size', null)
      .attr('fill', null)
      .attr('font-family', null)
      .attr('text-anchor', null);

    // create the y-axis container
    context.append('g')
      .attr('class', 'y axis')
      .call(d3.axisLeft(yScale2).tickFormat(d3.format('d')).tickValues(tickValues))
      .attr('font-size', null)
      .attr('fill', null)
      .attr('font-family', null)
      .attr('text-anchor', null);

    let gridLines = context.append('g')
    _.each(tickValues, function(n, li) {
      gridLines.append('line')
        .attr('class', 'high-line')
        .attr('x1', cformat(xScale2(dataRange[0])))
        .attr('y1', cformat(yScale2(tickValues[li])))
        .attr('x2', cformat(xScale2(dataRange[1])))
        .attr('y2', cformat(yScale2(tickValues[li])));
    });

    function prepareContextCircles (sel) {
      let badData = [];
      sel.attr('class', function(d) {
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
          return cformat(xScale2(d.date))
        })
        .attr('cy', function(d) {
          if (isNaN(d.sgv)) {
            badData.push(d);
            return cformat(yScale2(client.utils.scaleMgdl(450)));
          } else {
            return cformat(yScale2(d.sgv));
          }
        })
        .on('mouseover', function(event, d) {
          if (options.openAps && d.openaps) {
            client.tooltip.style('display', 'block');
            const bg = client.utils.roundBGForDisplay(client.utils.scaleMgdl(d.openaps.suggested.bg));
            const text = '<b>BG:</b> ' + bg +
              ', ' + htmlUtils.textAsHtml(d.openaps.suggested.reason) +
              (d.openaps.suggested.mealAssist ? ' <b>Meal Assist:</b> ' + htmlUtils.textAsHtml(d.openaps.suggested.mealAssist) : '');
            client.tooltip.html(text)
              .style('left', `${event.pageX}px`)
              .style('top', `${event.pageY + 15}px`);
          }
        })
        .on('mouseout', hideTooltip);

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }
      return sel;
    }

    // PREDICTIONS START
    function pushTreatment (treatment, treatmentsTimestamps) {
      if (treatment.timestamp)
        treatmentsTimestamps.push(treatment.timestamp);
      else if (treatment.created_at)
        treatmentsTimestamps.push(treatment.created_at);
    }

    function preparePredictedData () {

      const treatmentsTimestamps = []; // Only timestamps for (carbs and bolus insulin) treatments will be captured in this array
      treatmentsTimestamps.push(dataRange[0]); // Create a fake timestamp at midnight, so we can show predictions during night
      for (let treatment of data.treatments) {
        if (undefined !== treatment.carbs && null != treatment.carbs && treatment.carbs > 0) {
          pushTreatment(treatment, treatmentsTimestamps);
        }
        if (undefined !== treatment.insulin && treatment.insulin > 0) {
          pushTreatment(treatment, treatmentsTimestamps);
        }
      }

      let predictions = [];
      if (data && data.devicestatus) {

        for (const deviceStatus of data.devicestatus.slice().reverse()) {
          if (deviceStatus.loop && deviceStatus.loop.predicted) {
            predictions.push(deviceStatus.loop.predicted);
            continue;
          }

          if (deviceStatus.openaps && deviceStatus.openaps.suggested && deviceStatus.openaps.suggested.predBGs) {
            const entry = {};
            entry.startDate = deviceStatus.openaps.suggested.timestamp;
            // For OpenAPS/AndroidAPS we fall back from COB if present, to UAM, then IOB
            if (deviceStatus.openaps.suggested.predBGs.COB) {
              entry.values = deviceStatus.openaps.suggested.predBGs.COB;
            } else if (deviceStatus.openaps.suggested.predBGs.UAM) {
              entry.values = deviceStatus.openaps.suggested.predBGs.UAM;
            } else entry.values = deviceStatus.openaps.suggested.predBGs.IOB;
            predictions.push(entry);
          }
        }
      }

      let p = [];
      if (predictions.length > 0 && treatmentsTimestamps.length > 0) {

        // Iterate over all treatments, find the predictions for each and add them to the predicted array p
        for (let treatmentsIndex = 0; treatmentsIndex < treatmentsTimestamps.length; treatmentsIndex++) {
          let timestamp = treatmentsTimestamps[treatmentsIndex];
          // TODO refactor code so this is set here - now set as global in file loaded by the browser
          let predictedIndex = findPredicted(predictions, timestamp, Nightscout.predictions.offset); // Find predictions offset before or after timestamp

          if (predictedIndex != null) {
            const entry = predictions[predictedIndex]; // Start entry
            const d = profile.applyTimezone(moment(entry.startDate));
            let end = profile.parseInTimezone(day).endOf('day');
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
            for (const entryIndex in entry.values) {
              if (!d.isAfter(end)) {
                let value = {};
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
      let timestampWithOffset = moment(timestamp).add(offset, 'minutes');
      let predicted = null;
      if (offset < 0) { // If offset is negative, start searching from first prediction going forward
        for (let i = 0; i < predictions.length; i++) {
          if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) <= timestampWithOffset) {
            predicted = i;
          }
        }
      } else { // If offset is positive or zero, start searching from last prediction going backward
        for (let i = predictions.length - 1; i > 0; i--) {
          if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) >= timestampWithOffset) {
            predicted = i;
          }
        }
      }
      return predicted;
    }
    //
    // PREDICTIONS ENDS

    // bind up the context chart data to an array of circles
    const contextData = (options.predicted ? data.sgv.concat(preparePredictedData()) : data.sgv);
    const bgValues = context.append('g').attr('id', 'bg-values');
    const contextCircles = bgValues.selectAll('circle').data(contextData);

    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit().remove();

    let from = profile.parseInTimezone(day);
    let to = moment(from.clone()).add(1, 'days');
    let iobpolyline = ''
      , cobPolyLine = '';

    // basals data
    let linedata = [];
    let notemplinedata = [];
    let basalareadata = [];
    let tempbasalareadata = [];
    let comboareadata = [];
    let lastbasal = 0;
    let lastDt = from;
    let lastIOB;
    let basals = context.append('g').attr('id', 'basal');

    data.netBasalPositive = [];
    data.netBasalNegative = [];
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].forEach(function(hour) {
      data.netBasalPositive[hour] = 0;
      data.netBasalNegative[hour] = 0;
    });

    profile.loadData(datastorage.profiles);

    profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

    let bolusInsulin = 0;
    let baseBasalInsulin = 0;
    let positiveTemps = 0;
    let negativeTemps = 0;

    iobpolyline += `${xScale2(moment(from))}, ${yInsulinScale(0)} `;
    cobPolyLine += `${xScale2(moment(from))}, ${yCarbsScale(0)} `;

    let timestart = new Date();
    let cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
    let iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);

    console.log("Device COB status available: ", cobStatusAvailable);
    console.log("Device IOB status available: ", iobStatusAvailable);

    for (let dt = moment(from); dt < to; dt.add(5, 'minutes')) {
      if (options.iob && !iobStatusAvailable) {
        const iob = client.plugins('iob').calcTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).iob;
        // make the graph discontinuous when data is missing
        if (iob === undefined) {
          iobpolyline += `,${xScale2(lastDt)},${yInsulinScale(0)},${xScale2(dt)},${yInsulinScale(0)}`;
        } else {
          if (lastIOB === undefined) {
            iobpolyline += `,${xScale2(dt)},${yInsulinScale(0)}`;
          }
          iobpolyline += `,${xScale2(dt)},${yInsulinScale(iob)}`;
        }
        lastDt = dt.clone();
        lastIOB = iob;
      }
      if (options.cob && !cobStatusAvailable) {
        const cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).cob;
        if (!dt.isSame(from)) {
          cobPolyLine += ',';
        }
        cobPolyLine += `${xScale2(dt.toDate())},${yCarbsScale(cob)} `;
      }
      if (options.basal) {
        const date = dt.format('x');
        const hournow = dt.hour();
        const basalvalue = profile.getTempBasal(date);
        // Calculate basal stats
        baseBasalInsulin += basalvalue.basal * 5 / 60; // 5 minutes part
        const tempPart = (basalvalue.tempbasal - basalvalue.basal) * 5 / 60;
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
      let lastDate = 0;
      let previousDate = 0;
      const cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(cobArray, function drawCob (point) {
        if (previousDate !== 0 && point.mills - previousDate > times.mins(15).msecs) {
          cobPolyLine += `,${cformat(xScale2(previousDate))},${cformat(yCarbsScale(0))},${cformat(xScale2(point.mills))},${cformat(yCarbsScale(0))}`;
        }
        cobPolyLine += `,${cformat(xScale2(point.mills))},${cformat(yCarbsScale(point.cob))}`;
        if (point.mills > lastDate) lastDate = point.mills;
        previousDate = point.mills;
      });
      cobPolyLine += `,${cformat(xScale2(lastDate))},${cformat(yCarbsScale(0))}`;
    } else {
      cobPolyLine += `,${cformat(xScale2(to))},${cformat(yCarbsScale(0))}`;
    }

    // Draw IOB from devicestatuses if available
    if (iobStatusAvailable) {
      let lastdate = 0;
      let previousdate = 0;
      let iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(iobArray, function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          iobpolyline += `,${cformat(xScale2(previousdate))},${cformat(yInsulinScale(0))}`;
          iobpolyline += `,${cformat(xScale2(point.mills))},${cformat(yInsulinScale(0))}`;
        }
        iobpolyline += `,${cformat(xScale2(point.mills))},${cformat(yInsulinScale(point.iob))}`;
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      iobpolyline += ', ' + cformat(xScale2(lastdate)) + ',' + cformat(yInsulinScale(0));
    } else {
      iobpolyline += ', ' + cformat(xScale2(to)) + ',' + cformat(yInsulinScale(0));
    }

    if (options.iob) {
      context.append('polyline')
        .attr('class', 'iob')
        .attr('points', iobpolyline);
    }
    if (options.cob) {
      context.append('polyline')
        .attr('class', 'cob')
        .attr('points', cobPolyLine);
    }

    if (options.basal) {
      const toTempBasal = profile.getTempBasal(to.format('x'));

      linedata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      notemplinedata.push({ d: to.format('x'), b: toTempBasal.basal });
      basalareadata.push({ d: to.format('x'), b: toTempBasal.basal });
      tempbasalareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      comboareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });

      let basalMax = d3.max(linedata, function(d) { return d.b; });
      basalMax = Math.max(basalMax, d3.max(basalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(tempbasalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(comboareadata, function(d) { return d.b; }));

      yScaleBasals.domain([basalMax, 0]);

      const valueline = d3.line()
        .curve(d3.curveStepAfter)
        .x(function(d) { return cformat(xScale2(d.d)); })
        .y(function(d) { return cformat(yScaleBasals(d.b)); });

      const area = d3.area()
        .curve(d3.curveStepAfter)
        .x(function(d) { return cformat(xScale2(d.d)); })
        .y0(yScaleBasals(0))
        .y1(function(d) { return cformat(yScaleBasals(d.b)); });

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
        .attr('d', area);

      datastorage.tempbasalTreatments.forEach(function(t) {
        // only if basal and focus interval overlap and there is a chance to fit
        if (t.mills < to.format('x') && t.mills + times.mins(t.duration).msecs > from.format('x')) {
          const text = basals.append('text')
            .attr('class', 'tempbasaltext')
            .attr('dy', '.35em')
            .attr('x', cformat(xScale2((Math.max(t.mills, from.format('x')) + Math.min(t.mills + times.mins(t.duration).msecs, to.format('x'))) / 2)))
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
      const insulinNumberFormat = new Intl.NumberFormat(navigator.languages, { minimumFractionDigits: 2 })

      // Calculate bolus stats
      if (treatment.insulin) {
        bolusInsulin += treatment.insulin;
      }
      // Combo bolus part
      if (treatment.relative) {
        bolusInsulin += treatment.relative;
      }

      const renderNotes = treatment.notes && options.notes;

      if (treatment.eventType === 'Note' && !options.notes) return;

      if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 || renderNotes) {
        let lastfoodtext = foodtexts;
        let drawpointer = false;
        if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 && options.food) {
          let foods = treatment.boluscalc.foods;
          for (let fi = 0; fi < foods.length; fi++) {
            const f = foods[fi];
            context.append('text')
              .attr('class', 'treatment')
              .attr('y', foodtexts * 15)
              .attr('transform', 'translate(' + cformat(xScale2(treatment.mills)) + ',20)')
              .html(htmlUtils.textAsHtml(f.name) + ' ' + (f.carbs * f.portions).toFixed(1) + ' g');
            foodtexts = (foodtexts + 1) % 6;
            drawpointer = true;
          }
        }
        if (renderNotes && !treatment.duration && treatment.eventType !== 'Temp Basal') {

          let noteLines = treatment.notes.split('\n')
          let noteText = ""
          for (const line of noteLines) {
            noteText += `<tspan x="0" dy="1.5em">${htmlUtils.textAsHtml(line)}</tspan>`
          }
          context.append('text')
            .attr('class', 'treatment')
            .attr('y', foodtexts * 15)
            .attr('transform', 'translate(' + cformat(xScale2(treatment.mills)) + ',20)')
            .html(noteText);
          foodtexts = (foodtexts + 1) % 6;
          drawpointer = true;
        }
        if (drawpointer) {
          context.append('line')
            .attr('class', 'high-line')
            .attr('x1', cformat(xScale2(treatment.mills)))
            .attr('y1', lastfoodtext * 15 + 20)
            .attr('x2', cformat(xScale2(treatment.mills)))
            .attr('y2', cformat(treatment.carbs ? yCarbsScale(treatment.carbs) : (treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight)));
        }
      }

      if (treatment.carbs && options.carbs) {
        let label = ' ' + treatment.carbs + ' g';
        label += treatment.foodType ? ' ' + treatment.foodType : ''
        label += treatment.absorptionTime ? ' ' + (Math.round(treatment.absorptionTime / 60.0 * 10) / 10) + 'h' : ''
        if (treatment.protein) label += ' / ' + treatment.protein + ' g';
        if (treatment.fat) label += ' / ' + treatment.fat + ' g';

        let carbsScaled = yCarbsScale(treatment.carbs);
        let xScaled = xScale2(treatment.mills);
        context.append('rect')
          .attr('class', 'carbs treatment')
          .attr('y', cformat(carbsScaled))
          .attr('height', cformat(chartHeight - carbsScaled))
          .attr('width', 5)
          .attr('transform', 'translate(' + cformat(xScaled) + ',0)');
        context.append('text')
          .attr('class', 'carbs treatment')
          .attr('transform', `rotate(-45, ${cformat(xScaled)}, ${cformat(carbsScaled)}) translate(${cformat(xScaled + 10)}, ${cformat(carbsScaled)})`)
          .text(label);
      }

      if (treatment.insulin && options.insulin) {
        let insulinScaled = yInsulinScale(treatment.insulin);
        let dataLabel = insulinNumberFormat.format(treatment.insulin) + ' ' + translate('U');
        context.append('rect')
          .attr('class', 'insulin treatment')
          .attr('y', cformat(insulinScaled))
          .attr('height', cformat(chartHeight - insulinScaled))
          .attr('width', 5)
          .attr('transform', 'translate(' + cformat(xScale2(treatment.mills) - 2) + ',0)');
        context.append('text')
          .attr('class', 'insulin treatment')
          //.attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'rotate(-45,' + cformat(xScale2(treatment.mills) - 2) + ',' + cformat(insulinScaled) + ')' + 'translate(' + cformat(xScale2(treatment.mills) + 10) + ',' + cformat(insulinScaled) + ')')
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
      } else if (treatment.duration) {
        appendDurationEvent(treatment);
      } else if (treatment.eventType === 'BG Check' && !treatment.duration && options.bgcheck) {
        context.append('circle')
          .attr('class', 'measurement bg-check')
          .attr('cx', cformat(xScale2(treatment.mills)))
          .attr('cy', cformat(yScale2(scaledTreatmentBG(treatment, data.sgv))));
      } else if (!treatment.duration && options.othertreatments) {
        // other treatments without duration
        context.append('circle')
          .attr('class', 'measurement other')
          .attr('cx', cformat(xScale2(treatment.mills)))
          .attr('cy', cformat(yScale2(scaledTreatmentBG(treatment, data.sgv))))
        context.append('text')
          .attr('class', 'other-treatment')
          .attr('y', cformat(yScale2(scaledTreatmentBG(treatment, data.sgv)) - 10))
          .attr('x', cformat(xScale2(treatment.mills) + 10))
          .text(translate(client.careportal.resolveEventName(treatment.eventType)));
      } else {
        console.log("missed treatment", treatment);
      }
    });

    // Events with a duration that started on an earlier day and are still active.
    datastorage.treatments.forEach(function(treatment) {
      if (!treatment.duration || treatment.mills >= from.valueOf()) return;
      if (treatment.mills + times.mins(treatment.duration).msecs <= from.valueOf()) return;
      if (treatment.insulin || treatment.carbs || treatment.eventType === 'Temp Basal' || treatment.eventType === 'Combo Bolus' || treatment.eventType === 'Profile Switch') return;
      if (treatment.eventType === 'Note' && !options.notes) return;
      appendDurationEvent(treatment);
    });

    if (options.insulindistribution) {
      console.log(`Insulin for day: ${day} bolus: ${bolusInsulin} base basal: ${baseBasalInsulin}, positiveTemps: ${positiveTemps}, negativeTemps: ${negativeTemps}`);
      let table = $('<table class="insulin">');
      $(`<tr><td><b>${translate('Bolus insulin:')}</b></td><td>${bolusInsulin.toFixed(1)} ${translate('U')}</td></tr>`).appendTo(table);
      if (positiveTemps > 0 || negativeTemps < 0) {
        $(`<tr><td>${translate('Base basal insulin:')}</td><td>${baseBasalInsulin.toFixed(1)} ${translate('U')}</td></tr>`).appendTo(table);
        if (positiveTemps > 0) {
          $(`<tr><td>${translate('Positive temp basal insulin:')}</td><td>${positiveTemps.toFixed(1)} ${translate('U')}</td></tr>`).appendTo(table);
        }
        if (negativeTemps < 0) {
          $(`<tr><td>${translate('Negative temp basal insulin:')}</td><td>${negativeTemps.toFixed(1)} ${translate('U')}</td></tr>`).appendTo(table);
        }
      }

      var totalBasalInsulin = baseBasalInsulin + positiveTemps + negativeTemps;
      var totalDailyInsulin = bolusInsulin + totalBasalInsulin;
      $(`<tr><td><b>${translate('Total basal insulin:')}</b></td><td>${totalBasalInsulin.toFixed(1)} ${translate('U')}</td></tr>
<tr><td><b>${translate('Total daily insulin:')}</b></td><td>${totalDailyInsulin.toFixed(1)} ${translate('U')}</td></tr>
<tr><td>${translate('Total carbs')}:</td><td>${data.dailyCarbs} g</td></tr>
<tr><td>${translate('Total protein')}:</td><td>${data.dailyProtein} g</td></tr>
<tr><td>${translate('Total fat')}:</td><td>${data.dailyFat} g</td></tr>`).appendTo(table);

      let statcharts = $('#daytodaystatchart-' + day);
      statcharts.append(table);
      $(`<span id="daytodaystatinsulinpiechart-${day}"></span><span id="daytodaystatcarbspiechart-${day}">`).appendTo(statcharts);

      const chartData = [
        {
          label: translate('Basal')
          , count: totalBasalInsulin
          , pct: (totalBasalInsulin / totalDailyInsulin * 100).toFixed(0)
      }
      
        , { label: translate('Bolus'), count: bolusInsulin, pct: (bolusInsulin / totalDailyInsulin * 100).toFixed(0) }
    ];

      // Insulin distribution chart
      const width = 120;
      const height = 120;
      const radius = Math.min(width, height) / 2;

      const labelArc = d3.arc()
        .outerRadius(radius / 2)
        .innerRadius(radius / 2);

      const svg = d3.select('#daytodaystatinsulinpiechart-' + day)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2},${height / 2})`);

      const arc = d3.arc()
        .innerRadius(0)
        .outerRadius(radius);

      const pie = d3.pie().value(function(d) {
        return d.count;
      }).sort(null);

      const insulg = svg.selectAll('.insulinarc')
        .data(pie(chartData))
        .enter()
        .append('g')
        .attr('class', 'insulinarc');

      insulg.append('path')
        .attr('class', function(d) { return 'insulin-slice ' + (d.data.label === translate('Basal') ? 'basal-slice' : 'bolus-slice'); })
        .attr('d', arc)
        .attr('data-label', function(d) { return d.data.label; });

      insulg.append('text')
        .attr('class', 'pie-label')
        .attr('transform', function(d) {
          return 'translate(' + labelArc.centroid(d) + ')';
        })
        .attr('dy', '.15em')
        .text(function(d) {
          return d.data.pct + ' %';
        });

      // Carbs pie chart

      const carbsData = [
        { label: translate('Carbs'), count: data.dailyCarbs }
    ];

      const carbssvg = d3.select('#daytodaystatcarbspiechart-' + day)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2},${height / 2})`);

      const carbsarc = d3.arc()
        .outerRadius(radius * data.dailyCarbs / options.maxDailyCarbsValue);

      const carbspie = d3.pie()
        .value(function(d) {
          return d.count;
        })
        .sort(null);

      const carbsg = carbssvg.selectAll('.carbsarc')
        .data(carbspie(carbsData))
        .enter()
        .append('g')
        .attr('class', 'carbsarc');

      carbsg.append('path')
        .attr('class', 'carbs-slice')
        .attr('d', carbsarc)
        .attr('data-label', function(d) { return d.data.label; });

      carbsg.append('text')
        .attr('class', 'pie-label')
        .attr('transform', "translate(0,0)")
        .attr('dy', '.15em')
        .text(function(d) {
          return d.data.count + ' g';
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

    function getProfileSwitchText (treatment) {
      const sign = treatment.first ? '▲▲▲' : '▬▬▬';
      if (treatment.cutting) {
        return `${sign} ${client.profilefunctions.profileSwitchName(treatment.cutting)}  ►►►  ${client.profilefunctions.profileSwitchName(treatment.profile)} ${sign}`;
      } else {
        return `${sign} ${client.profilefunctions.profileSwitchName(treatment.profile)} ${sign}`;
      }
    }

    function appendDurationEvent (treatment) {
      let top;
      let className;
      let label = treatment.notes;
      if (treatment.eventType === 'Exercise') {
        top = 396;
        className = 'duration-event exercise';
      } else if (treatment.eventType === 'Note') {
        top = 360;
        className = 'duration-event note';
      } else if (treatment.eventType === 'OpenAPS Offline') {
        top = 324;
        className = 'open-aps treatment';
      } else if (treatment.eventType === 'Temporary Override') {
        top = 432;
        className = 'override';
        label = treatment.reason;
      } else if (options.othertreatments) {
        top = 432;
        className = 'duration-event other-treatment';
      } else {
        return;
      }

      const start = Math.max(treatment.mills, from.valueOf());
      const end = Math.min(treatment.mills + times.mins(treatment.duration).msecs, to.valueOf());
      const labelY = yScale2(client.utils.scaleMgdl(top - 18));
      const eventRect = context.append('rect')
        .attr('class', className)
        .attr('x', cformat(xScale2(start)))
        .attr('y', cformat(yScale2(client.utils.scaleMgdl(top))))
        .attr('width', cformat(xScale2(end) - xScale2(start)))
        .attr('height', cformat(yScale2(client.utils.scaleMgdl(top - 36)) - yScale2(client.utils.scaleMgdl(top))));
      const eventText = context.append('text')
        .attr('class', className)
        .attr('dy', '.35em')
        .attr('y', cformat(labelY))
        .attr('x', cformat(xScale2((start + end) / 2)))
        .text(label);

      if (treatment.eventType === 'Temporary Override') {
        const textNode = eventText.node();
        eventText.attr('dy', null).attr('dominant-baseline', 'middle');
        const textBox = textNode && typeof textNode.getBBox === 'function' ? textNode.getBBox() : null;
        const padding = 3;
        const rectHeight = textBox ? textBox.height + 2 * padding : 18;
        eventRect
          .attr('y', labelY - rectHeight / 2)
          .attr('height', rectHeight);
      }
    }

    function appendProfileSwitch (context, treatment) {

      if (!treatment.cutting && !treatment.profile) {
        return;
      }
      context.append('text')
        .attr('class', 'profile-switch')
        .attr('dy', '.35em')
        .attr('transform', `rotate(-90 ${xScale2(treatment.mills)},${yScaleBasals(0) - 10}) ` + `translate(${xScale2(treatment.mills)},${yScaleBasals(0) - 10})`)
        .text(getProfileSwitchText(treatment));
    }

    console.log(`Rendering ${day} in ${new Date().getTime() - timestart.getTime()} msecs`);
  }

  function hideTooltip () {
    client.tooltip.style('display', 'none');
  }
};
