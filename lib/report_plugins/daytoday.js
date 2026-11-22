'use strict';

const moment = window.moment;
const times = require('../times');
const d3 = (global && global.d3) || require('../d3.mjs');
const plainAxis = require('../report/plain-axis');
const htmlUtils = require('../utils/html');
const glucoseTrace = require('../client/glucose-trace');
const dateFormat = require('../report/date-format');

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
  return '<h2 class="no-print">' + translate('Day to day') + '</h2>' +
      '<b class="daily-report-hint no-print">' + translate('To see this report, press SHOW while in this view') + '</b><br class="no-print">' +
      '<div class="daily-display-controls no-print">' + translate('Display') + ': ' +
      `<label><input type="checkbox" id="rp_optionsinsulin" ${reportStorage.getValue('insulin') ? "checked" : ""}><span class="daily-option-insulin"> ${translate('Insulin')} </span></label>` +
      `<label><input type="checkbox" id="rp_optionscarbs" ${reportStorage.getValue('carbs') ? "checked" : ""}><span class="daily-option-carbs">${translate('Carbs')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsbasal" ${reportStorage.getValue('basal') ? "checked" : ""}><span class="daily-option-basal">${translate('Basal rate')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsnotes" ${reportStorage.getValue('notes') ? "checked" : ""}>${translate('Notes')}</label>` +
      `<label><input type="checkbox" id="rp_optionsfood" ${reportStorage.getValue('food') ? "checked" : ""}>${translate('Food')}</label>` +
      `<label><input type="checkbox" id="rp_optionsraw" ${reportStorage.getValue('raw') ? "checked" : ""}><span class="daily-option-raw">${translate('Raw')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsiob" ${reportStorage.getValue('iob') ? "checked" : ""}><span class="daily-option-insulin">${translate('IOB')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionscob" ${reportStorage.getValue('cob') ? "checked" : ""}><span class="daily-option-carbs">${translate('COB')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionspredicted" ${reportStorage.getValue('predicted') ? "checked" : ""}><span class="daily-option-predicted">${translate('Predictions')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsopenaps" ${reportStorage.getValue('openAps') ? "checked" : ""}><span class="daily-option-predicted">${translate('OpenAPS')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsdistribution" ${reportStorage.getValue('insulindistribution') ? "checked" : ""}><span class="daily-option-insulin">${translate('Insulin distribution')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsbgcheck" ${reportStorage.getValue('bgcheck') ? "checked" : ""}><span class="daily-option-bgcheck">${translate('BG Check')}</span></label>` +
      `<label><input type="checkbox" id="rp_optionsothertreatments" ${reportStorage.getValue('othertreatments') ? "checked" : ""}>${translate('View all treatments')}</span></label>` +
      '&nbsp;' + translate('Size') +
      ' <select id="rp_size">' +
      '  <option x="800" y="250">800x250px</option>' +
      '  <option x="1000" y="300">1000x300px</option>' +
      '  <option x="1200" y="400">1200x400px</option>' +
      '  <option x="1550" y="600" selected>1550x600px</option>' +
      '  <option x="2400" y="800">2400x800px</option>' +
      '</select>' +
      '<br>' +
      translate('Scale') + ': ' +
      '<label><input type="radio" name="rp_scale" id="rp_linear" checked>' +
      translate('Linear') + '</label>' +
      '<label><input type="radio" name="rp_scale" id="rp_log">' +
      translate('Logarithmic') + '</label>' +
      `<div id="rp_predictedSettings" ${reportStorage.getValue('predicted') ? '' : 'hidden'}>` +
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
      '<br>' +
      '</div><div id="daytodaycharts">' +
      '</div>';
};

daytoday.prepareHtml = function daytodayPrepareHtml (sorteddaystoshow) {
  $('#daytodaycharts').html('');
  sorteddaystoshow.forEach(function eachDay (d) {
    $('#daytodaycharts').append($('<table class="daily-report-card single-page"><tr><td class="daily-chart-main"><div id="daytodaychart-' + d + '"></div></td><td class="daily-chart-aside"><div id="daytodaystatchart-' + d + '"></div></td></tr></table>'));
  });
};

daytoday.report = function report_daytoday (datastorage, sorteddaystoshow, options) {
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const profile = client.sbx.data.profile;
  const report_plugins = Nightscout.report_plugins;
  const scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;
  const basalReport = require('../report/basal-adjustments').prepare(profile, datastorage, moment);
  const basalProfile = basalReport.profile;

  const premium = client.settings.theme === 'modern';
  const padding = premium ? {top: 30, right: 24, bottom: 28, left: 48} : {top: 15, right: 22, bottom: 30, left: 35};

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
    basalReport.reset();
  });

  const tddAverage = tddSum / datastorage.alldays;
  const basalAveragePercent = Math.round((basalSum / datastorage.alldays) / tddAverage * 100);
  const baseBasalAveragePercent = Math.round((baseBasalSum / datastorage.alldays) / tddAverage * 100);
  const bolusAveragePercent = Math.round((bolusSum / datastorage.alldays) / tddAverage * 100);
  const carbsAverage = carbsSum / datastorage.alldays;
  const proteinAverage = proteinSum / datastorage.alldays;
  const fatAverage = fatSum / datastorage.alldays;

  if (options.insulindistribution) {
    const insulinAverage = function (value, digits, unit) {
      return Number.isFinite(value) ? value.toFixed(digits) + unit : '—';
    };
    let html = '<br><br><b>' + translate('TDD average') + ':</b> ' + insulinAverage(tddAverage, 1, 'U') + '&nbsp; ';
    html += '<b>' + translate('Bolus average') + ':</b> ' + insulinAverage(bolusAveragePercent, 0, '%') + '&nbsp; ';
    html += '<b>' + translate('Basal average') + ':</b> ' + insulinAverage(basalAveragePercent, 0, '%') + '&nbsp; ';
    html += '<b>(' + translate('Base basal average:') + '</b> ' + insulinAverage(baseBasalAveragePercent, 0, '%') + '<b>)</b>&nbsp; ';
    html += '<b>' + translate('Carbs average') + ':</b> ' + carbsAverage.toFixed(0) + 'g&nbsp; ';
    html += '<b>' + translate('Protein average') + ':</b> ' + proteinAverage.toFixed(0) + 'g&nbsp; ';
    html += '<b>' + translate('Fat average') + ':</b> ' + fatAverage.toFixed(0) + 'g';
    $('#daytodaycharts').append($('<div class="no-print">').html(html));
  }

  function timeTicks(n,i) {
    const t12 = [
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
    let tickValues
      , svgNode
      , context
      , xScale2, yScale2
      , yInsulinScale, yCarbsScale, yScaleBasals
      , xAxis2, yAxis2
      , dateFn = function(d) { return new Date(d.date); }
      , foodtexts = 0;

    tickValues = client.ticks(client, {
      scaleY: options.scale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
      , targetTop: options.targetHigh
      , targetBottom: options.targetLow
    });

    const chartHost = d3.select('#daytodaychart-' + day).html('');
    if (premium) {
      const header = chartHost.append('div').attr('class', 'daily-chart-header');
      header.append('div').append('h3').text(dateFormat(client).longDate(profile.parseInTimezone(day)));
      header.append('span').attr('class', 'daily-trend-pill').text(translate('Smoothed trend'));
    } else {
      chartHost.append('b').text(report_plugins.utils.localeDate(day));
      chartHost.append('br');
    }
    svgNode = chartHost.append('svg').attr('class', 'daily-chart-svg chart-width-' + options.width).classed('is-modern', premium);

    // Hover tooltip inside the chart container, so it is replaced together with the chart on every run.
    const tooltip = chartHost.append('div').attr('class', 'tooltip no-print').style('display', 'none');
    function hideTooltip () {
      tooltip.style('display', 'none').classed('daytoday-reading-tooltip', false);
    }

    // add defs for combo boluses
    const sharedDefs = svgNode.append('defs');
    // One page-wide gradient for the glucose wash; report.css references it by id.
    if (premium && !document.getElementById('daily-glucose-fade')) {
      var gradient = sharedDefs.append('linearGradient').attr('id', 'daily-glucose-fade').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
      gradient.append('stop').attr('class', 'daily-glucose-fade-top').attr('offset', '0%');
      gradient.append('stop').attr('class', 'daily-glucose-fade-bottom').attr('offset', '100%');
    }
    const dashWidth = 5;
    sharedDefs
        .append('pattern')
        .attr('id', 'hash')
        .attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 6)
        .attr('height', 6)
        .attr('x', 0)
        .attr('y', 0)
        .append('g')
        .attr('class', 'daily-combo-hatch')
        .append('path').attr('d', 'M0,0 l' + dashWidth + ',' + dashWidth)
        .append('path').attr('d', 'M' + dashWidth + ',0 l-' + dashWidth + ',' + dashWidth);

    svgNode.append('rect')
      .attr('class', 'daily-chart-background')
      .attr('width', '100%')
      .attr('height', '100%');

    context = svgNode.append('g');

    // define the parts of the axis that aren't dependent on width or height
    xScale2 = d3.scaleTime()
      .domain(d3.extent(data.sgv, dateFn));

    if (options.scale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scaleLog()
        .domain([client.utils.scaleMgdl(premium ? 36 : options.basal ? 30 : 36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scaleLinear()
        .domain([client.utils.scaleMgdl(premium ? 36 : options.basal ? -40 : 36), client.utils.scaleMgdl(420)]);
    }

    // allow insulin to be negative (when plotting negative IOB)
    yInsulinScale = d3.scaleLinear()
      .domain([-2 * options.maxInsulinValue, 2 * options.maxInsulinValue]);

    yCarbsScale = d3.scaleLinear()
      .domain([0, options.maxCarbsValue * 1.25]);

    yScaleBasals = d3.scaleLinear();

    xAxis2 = d3.axisBottom(xScale2).offset(0)
      .tickFormat(timeTicks)
      .ticks(24);

    yAxis2 = d3.axisLeft(yScale2).offset(0)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues);

    // get current data range
    const dataRange = d3.extent(data.sgv, dateFn);

    // get the entire container height and width subtracting the padding
    const chartWidth = options.width - padding.left - padding.right;
    let chartHeight = options.height - padding.top - padding.bottom;
    if (premium) chartHeight = Math.max(240, chartHeight);
    const basalTop = chartHeight + (premium ? 32 : 46);
    const plotBottom = premium && options.basal ? basalTop + 64 : chartHeight;
    if (premium) {
      xAxis2.tickFormat(function(date) { return profile.applyTimezone(moment(date)).format(client.settings.timeFormat === 24 ? 'HH:mm' : 'ha'); })
        .ticks(d3.timeHour.every(2)).tickSizeOuter(0);
    }

    //set the width and height of the SVG element
    const svgHeight = premium ? plotBottom + padding.top + padding.bottom : options.height;
    svgNode.attr('width', options.width).attr('height', svgHeight)
      .attr('viewBox', '0 0 ' + options.width + ' ' + svgHeight);

    // ranges are based on the width and height available so reset
    xScale2.rangeRound([0, chartWidth]);
    yScale2.rangeRound([chartHeight, 0]);
    yInsulinScale.rangeRound([chartHeight * 2, 0]);
    yCarbsScale.rangeRound([chartHeight, 0]);
    yScaleBasals.rangeRound(premium ? [basalTop, plotBottom] : [yScale2(client.utils.scaleMgdl(72)), chartHeight]);

    // add target BG rect
    context.append('rect')
      .attr('x', xScale2(dataRange[0]) + padding.left)
      .attr('y', yScale2(options.targetHigh) + padding.top)
      .attr('width', xScale2(dataRange[1]) - xScale2(dataRange[0]))
      .attr('height', yScale2(options.targetLow) - yScale2(options.targetHigh))
      .attr('class', 'daily-target-band');

    // create the x axis container
    context.append('g')
      .attr('class', 'x axis');

    // create the y axis container
    context.append('g')
      .attr('class', 'y axis');

    context.select('.y')
      .attr('transform', 'translate(' + (padding.left) + ',' + padding.top + ')')
      .call(yAxis2).call(plainAxis, 'left');

    // if first run then just display axis with no transition
    context.select('.x')
      .attr('transform', 'translate(' + padding.left + ',' + (plotBottom + padding.top) + ')')
      .call(xAxis2).call(plainAxis, 'bottom');
    if (premium) {
      context.select('.x').selectAll('.tick line').attr('y2', -plotBottom);
      context.append('text').attr('class', 'daily-axis-label').attr('x', padding.left).attr('y', 16)
        .text(translate('Glucose') + ' (' + (client.settings.units === 'mmol' ? 'mmol/L' : 'mg/dL') + ')');
    }
    tickValues?.forEach(function(n, li) {
      context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(dataRange[0]) + padding.left)
        .attr('y1', yScale2(tickValues[li]) + padding.top)
        .attr('x2', xScale2(dataRange[1]) + padding.left)
        .attr('y2', yScale2(tickValues[li]) + padding.top);
    });

    var connectedReadings = new Set();

    // Sensor readings are only ever in range (green) or out of range (red);
    // the stroke colour for each tone lives in report.css.
    function glucoseTone (color) {
      return color === 'red' ? 'glucose-out-of-range' : 'glucose-in-range';
    }

    function showReadingTooltip (event, d, selectedAt) {
      var at = selectedAt === undefined ? +d.date : selectedAt;
      var units = client.settings.units === 'mmol' ? 'mmol/L' : 'mg/dL';
      var clockFormat = client.settings.timeFormat === 24 ? 'HH:mm' : 'h:mm a';
      function clock (date) { return profile.applyTimezone(moment(date)).format(clockFormat); }
      function metric (name, value, detail, kind) {
        return '<div class="daily-tooltip-metric daily-tooltip-' + kind + '"><span>' + htmlUtils.textAsHtml(translate(name)) +
          '</span><strong>' + htmlUtils.textAsHtml(value) + '</strong><small>' + htmlUtils.textAsHtml(detail) + '</small></div>';
      }
      var label = d && (d.type === 'rawbg' ? 'Raw' : d.type === 'mbg' ? 'BG Check' : d.type === 'sgv' ? 'Glucose' : 'Prediction');
      var rate = rateAt(linedata, at), scheduled = rateAt(notemplinedata, at);
      var text = '<div class="daily-tooltip-header"><strong>' + htmlUtils.textAsHtml(clock(at)) + '</strong><span>' +
        htmlUtils.textAsHtml(dateFormat(client).shortDate(profile.applyTimezone(moment(at)))) + '</span></div><div class="daily-tooltip-metrics">' +
        metric(label || 'Glucose', d ? String(client.utils.roundBGForDisplay(d.sgv)) + ' ' + units : '—',
          d ? translate('Reading') + ' ' + clock(d.date) : translate('No glucose reading'), 'glucose') +
        metric('Basal', Number.isFinite(rate) ? client.utils.toRoundedStr(rate, 2) + ' U/h' : '—',
          Number.isFinite(scheduled) ? translate('Scheduled') + ' ' + client.utils.toRoundedStr(scheduled, 2) + ' U/h' : translate(options.basal ? 'Unavailable' : 'Not displayed'), 'basal') + '</div>';
      if (options.openAps && d && d.openaps) {
        text += '<div class="daily-tooltip-detail">' + htmlUtils.textAsHtml(d.openaps.suggested.reason) +
          (d.openaps.suggested.mealAssist ? ' · ' + htmlUtils.textAsHtml(d.openaps.suggested.mealAssist) : '') + '</div>';
      }
      if (Number.isFinite(rate) && premium) hoverBasalDot.attr('cx', xScale2(at) + padding.left).attr('cy', yScaleBasals(rate) + padding.top).style('display', null);
      else hoverBasalDot.style('display', 'none');
      var nearby = hoverTreatments.slice(treatmentTimes.left(hoverTreatments, at - times.mins(5).msecs), treatmentTimes.right(hoverTreatments, at + times.mins(5).msecs));
      var selected = new Set(nearby);
      context.selectAll('.daily-treatment').classed('is-selected', function(t) { return selected.has(t); });
      text += '<div class="daily-tooltip-treatments"><div class="daily-tooltip-heading">' + htmlUtils.textAsHtml(translate('Treatments')) + '<small>±5 min</small></div>';
      if (nearby.length) {
        text += '<ul>' + nearby.map(function(t) {
          var values = [];
          [['insulin', '', 'U'], ['relative', 'Extended', 'U'], ['carbs', '', 'g'],
            ['absolute', '', 'U/h'], ['percent', '', '%'], ['duration', '', 'min']].forEach(function(field) {
            var amount = t[field[0]];
            if (amount === undefined || amount === null || !Number.isFinite(Number(amount))) return;
            if (Number(amount) === 0 && field[0] !== 'absolute' && field[0] !== 'percent' && !(field[0] === 'duration' && t.eventType === 'Temp Basal')) return;
            amount = field[0] === 'duration' && Math.abs(Number(amount)) >= 1 ? Math.round(Number(amount) * 10) / 10 : Number(amount);
            values.push((field[1] ? translate(field[1]) + ' ' : '') + client.utils.toRoundedStr(amount, 2) + ' ' + field[2]);
          });
          if (t.profile) values.push(String(t.profile));
          return '<li><div><b>' + htmlUtils.textAsHtml(translate(t.eventType || 'Treatment')) + '</b><span>' +
            htmlUtils.textAsHtml(values.join(' · ') || '—') + '</span><time>' + htmlUtils.textAsHtml(clock(t.mills)) + '</time></div>' +
            (t.notes && (options.notes || t.eventType === 'Note') ? '<small>' + htmlUtils.textAsHtml(String(t.notes)) + '</small>' : '') + '</li>';
        }).join('') + '</ul>';
      } else text += '<small>' + htmlUtils.textAsHtml(translate('No nearby treatments')) + '</small>';
      text += '</div>';
      tooltip.classed('daytoday-reading-tooltip', true).html(text).style('display', 'block');
      var bounds = tooltip.node().getBoundingClientRect();
      var host = chartHost.node().getBoundingClientRect();
      // Right of the pointer, or left of it near the edge of the container or the screen.
      var viewRight = Math.min(host.right, document.documentElement.clientWidth) - 8;
      var clientLeft = event.clientX + 12 + bounds.width > viewRight ? event.clientX - bounds.width - 12 : event.clientX + 12;
      // Anchor vertically to the plot, independent of the pointer and content height; keep it on screen
      // and inside the container, assuming a tooltip height of up to 360px.
      var plotTop = svgNode.node().getBoundingClientRect().top + padding.top + 12;
      var clientTop = Math.max(8, Math.min(plotTop, Math.max(8, window.innerHeight - 360)));
      var top = Math.min(clientTop - host.top, host.height - 360);
      tooltip.style('left', Math.round(Math.max(0, clientLeft - host.left)) + 'px').style('top', Math.round(Math.max(0, top)) + 'px');
    }

    function prepareContextCircles (sel) {
      var badData = [];
      sel.attr('cx', function(d) {
          return xScale2(d.date) + padding.left;
        })
        .attr('cy', function(d) {
          if (isNaN(d.sgv)) {
            badData.push(d);
            return yScale2(client.utils.scaleMgdl(450) + padding.top);
          } else {
            return yScale2(d.sgv) + padding.top;
          }
        })
        .attr('class', function(d) { return d.type === 'sgv' ? 'daytoday-sample daytoday-glucose-sample ' + glucoseTone(d.color) : 'daytoday-sample'; })
        .classed('is-raw', function(d) { return d.type === 'rawbg'; })
        .classed('is-mbg', function(d) { return d.type === 'mbg'; })
        .classed('is-prediction', function(d) { return d.type === 'prediction'; })
        // Hidden raw values and the day-boundary sentinels are not drawn.
        .classed('is-concealed', function(d) { return d.color === 'transparent' || (d.color === 'gray' && !options.raw); })
        .classed('is-inert', function(d) { return d.color === 'transparent' || !Number.isFinite(d.sgv) || (d.color === 'gray' && !options.raw); })
        // Connected samples are invisible hover targets, including with OpenAPS enabled.
        .classed('is-connected', function(d) { return connectedReadings.has(d); })
        .classed('has-openaps', function(d) { return !!(options.openAps && d.openaps); })
        .on('mouseover', function(event, d) {
          if (connectedReadings.has(d)) d3.select(this).classed('is-highlighted', true);
          showReadingTooltip(event, d);
        })
        .on('mousemove', showReadingTooltip)
        .on('mouseout', function(event, d) {
          if (connectedReadings.has(d)) d3.select(this).classed('is-highlighted', false);
          hideTooltip();
        });

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
        if (undefined !== treatment.insulin && null != treatment.insulin && treatment.insulin > 0) {
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
            var d = profile.applyTimezone(moment(entry.startDate));
            var end = profile.parseInTimezone(day).endOf('day');
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
                value.type = 'prediction';
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

    // Join only actual sensor readings. Shared cadence rules preserve gaps;
    // raw values, fingersticks, predictions and day-boundary sentinels stay separate.
    var glucoseRuns = glucoseTrace.segments(data.sgv.filter(function(d) { return d.type === 'sgv'; }).map(function(d) {
      return { mills: +d.date, mgdl: d.sgv, color: d.color, reading: d };
    }), client.utils.scaleMgdl(39));
    var glucoseLine = d3.line().digits(0).x(function(p) { return xScale2(p.mills) + padding.left; })
      .y(function(p) { return yScale2(p.mgdl) + padding.top; }).curve(d3.curveBasis);
    glucoseRuns.forEach(function(run) { run.points.forEach(function(p) { connectedReadings.add(p.reading); }); });
    if (premium) {
      var wash = d3.area().digits(0).x(function(p) { return xScale2(p.mills) + padding.left; })
        .y0(chartHeight + padding.top).y1(function(p) { return yScale2(p.mgdl) + padding.top; }).curve(d3.curveBasis);
      context.selectAll('path.daily-glucose-wash').data(glucoseRuns).enter().append('path')
        .attr('class', 'daily-glucose-wash')
        .attr('d', function(run) { return wash(run.points); });
    }
    context.selectAll('path.daytoday-glucose-line').data(glucoseRuns).enter().append('path')
      .attr('class', function(run) { return 'daytoday-glucose-line ' + glucoseTone(run.color); })
      .attr('d', function(run) { return glucoseLine(run.points); });
    // The curve is a visual trend; hover continues to use the untouched samples.
    if (glucoseRuns.length && !premium) {
      context.append('text').attr('class', 'daytoday-trace-label')
        .attr('x', options.width - padding.right).attr('y', 10)
        .text(translate('Smoothed trend'));
    }

    // bind up the context chart data to an array of circles
    var contextData = (options.predicted ? data.sgv.concat(preparePredictedData()) : data.sgv);
    var contextCircles = context.selectAll('circle').data(contextData);

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit()
      .remove();

    var from = profile.parseInTimezone(day);
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

    var basalTotals = basalReport.calculate(day);
    var bolusInsulin = 0;
    var baseBasalInsulin = basalTotals ? basalTotals.base : NaN;
    var positiveTemps = basalTotals ? basalTotals.positiveTotal : NaN;
    var negativeTemps = basalTotals ? basalTotals.negativeTotal : NaN;

    iobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
    cobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
    var timestart = new Date();
    var cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
    var iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);

    console.log("Device COB status available: ", cobStatusAvailable);
    console.log("Device IOB status available: ", iobStatusAvailable);

    for (var dt = moment(from); dt < to; dt.add(5, 'minutes')) {
      if (options.iob && !iobStatusAvailable) {
        var iob = client.plugins('iob').calcTotal(datastorage.treatments, datastorage.devicestatus, basalProfile, dt.toDate()).iob;
        // make the graph discontinuous when data is missing
        if (iob === undefined) {
          iobpolyline += ', ' + (xScale2(lastDt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
          iobpolyline += ', ' + (xScale2(dt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
        } else {
          if (lastIOB === undefined) {
            iobpolyline += ', ' + (xScale2(dt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
          }
          iobpolyline += ', ' + (xScale2(dt) + padding.left) + ',' + (yInsulinScale(iob) + padding.top);
        }
        lastDt = dt.clone();
        lastIOB = iob;
      }
      if (options.cob && !cobStatusAvailable) {
        var cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, basalProfile, dt.toDate()).cob;
        if (!dt.isSame(from)) {
          cobpolyline += ', ';
        }
        cobpolyline += (xScale2(dt.toDate()) + padding.left) + ',' + (yCarbsScale(cob) + padding.top) + ' ';
      }
    }

    if (options.basal) {
      var basalTimes = basalProfile.getBasalRenderTimes(from.valueOf(), to.valueOf(), times.mins(5).msecs);

      basalTimes.forEach(function renderBasal (date) {
        var basalvalue = basalProfile.getTempBasal(date);

        // Compare basal values using JSON.stringify for deep object comparison
        if (JSON.stringify(lastbasal) !== JSON.stringify(basalvalue)) {
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
      });
    }

    // Draw COB from devicestatuses if available
    if (cobStatusAvailable) {
      var lastdate = 0;
      var previousdate = 0;
      var cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      cobArray?.forEach(function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          cobpolyline += ', ';
          cobpolyline += (xScale2(previousdate) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
          cobpolyline += ', ';
          cobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
        }
        cobpolyline += ', ';
        cobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yCarbsScale(point.cob) + padding.top) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      cobpolyline += ', ' + (xScale2(lastdate) + padding.left) + ',' + (yCarbsScale(0) + padding.top);
    } else {
      cobpolyline += ', ' + (xScale2(to) + padding.left) + ',' + (yCarbsScale(0) + padding.top);
    }

    // Draw IOB from devicestatuses if available
    if (iobStatusAvailable) {
      lastdate = 0;
      previousdate = 0;
      var iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      iobArray?.forEach(function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          iobpolyline += ', ';
          iobpolyline += (xScale2(previousdate) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
          iobpolyline += ', ';
          iobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
        }
        iobpolyline += ', ';
        iobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yInsulinScale(point.iob) + padding.top) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      iobpolyline += ', ' + (xScale2(lastdate) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
    } else {
      iobpolyline += ', ' + (xScale2(to) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
    }

    if (options.iob) {
      context.append('polyline')
        .attr('class', 'daily-iob-line')
        .attr('points', iobpolyline);
    }
    if (options.cob) {
      context.append('polyline')
        .attr('class', 'daily-cob-line')
        .attr('points', cobpolyline);
    }

    if (options.basal) {
      var toTempBasal = basalProfile.getTempBasal(to.format('x'));

      linedata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      notemplinedata.push({ d: to.format('x'), b: toTempBasal.basal });
      basalareadata.push({ d: to.format('x'), b: toTempBasal.basal });
      tempbasalareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });
      comboareadata.push({ d: to.format('x'), b: toTempBasal.totalbasal });

      var basalMax = d3.max(linedata, function(d) { return d.b; });
      basalMax = Math.max(basalMax, d3.max(basalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(tempbasalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(comboareadata, function(d) { return d.b; }));

      yScaleBasals.domain([basalMax || 1, 0]);
      if (premium) {
        yScaleBasals.domain([Math.max(basalMax * 1.15, .1), 0]).nice(3);
        context.append('g').attr('class', 'daily-basal-axis axis')
          .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')')
          .call(d3.axisLeft(yScaleBasals).offset(0).ticks(3).tickSizeOuter(0)).call(plainAxis, 'left');
        context.append('text').attr('class', 'daily-axis-label').attr('x', padding.left).attr('y', basalTop + padding.top - 14)
          .text(translate('Basal') + ' (U/h)');
      }

      var valueline = d3.line().digits(0)
        .curve(d3.curveStepAfter)
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y(function(d) { return yScaleBasals(d.b) + padding.top; });

      var area = d3.area().digits(0)
        .curve(d3.curveStepAfter)
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y0(yScaleBasals(0) + padding.top)
        .y1(function(d) { return yScaleBasals(d.b) + padding.top; });

      var g = basals.append('g');

      g.append('path')
        .attr('class', 'basalline')
        .attr('d', valueline(linedata));

      g.append('path')
        .attr('class', 'notempline')
        .attr('d', valueline(notemplinedata));

      g.append('path')
        .attr('class', 'basalarea')
        .datum(basalareadata)
        .attr('d', area);

      g.append('path')
        .attr('class', 'tempbasalarea')
        .datum(tempbasalareadata)
        .attr('d', area);

      g.append('path')
        .attr('class', 'comboarea')
        .datum(comboareadata)
        .attr('d', area);

      datastorage.tempbasalTreatments.forEach(function(t) {
        // only if basal and focus interval overlap and there is a chance to fit
        if (t.mills < to.format('x') && t.mills + times.mins(t.duration).msecs > from.format('x')) {
          var text = g.append('text')
            .attr('class', 'tempbasaltext')
            .attr('dy', '.35em')
            .attr('x', xScale2((Math.max(t.mills, from.format('x')) + Math.min(t.mills + times.mins(t.duration).msecs, to.format('x'))) / 2) + padding.left)
            .attr('y', yScaleBasals(0) - 10 + padding.top)
          //            .text((t.percent ? (t.percent > 0 ? '+' : '') + t.percent + '%' : '') + (t.absolute ? Number(t.absolute).toFixed(2) + 'U' : ''));
          // better hide if not fit
          if (text.node().getBBox().width > xScale2(t.mills + times.mins(t.duration).msecs) - xScale2(t.mills)) {
            text.classed('is-hidden', true);
          }
        }
      });
    }

    var markerPositions = {carbs: -Infinity, bolus: -Infinity};
    var hoverReadings = data.sgv.filter(function(d) {
      return d.type === 'sgv' && Number.isFinite(+d.date) && Number.isFinite(d.sgv) &&
        d.sgv >= client.utils.scaleMgdl(39) && d.color !== 'transparent';
    }).sort(function(a, b) { return +a.date - +b.date; });
    var nearestReading = d3.bisector(function(d) { return +d.date; }).center;
    function appendTreatmentMarker (treatment, kind, label) {
      var x = xScale2(treatment.mills) + padding.left;
      var sample = hoverReadings[nearestReading(hoverReadings, treatment.mills)];
      var anchor = sample && Math.abs(+sample.date - treatment.mills) <= times.mins(7.5).msecs ? yScale2(sample.sgv) + padding.top : padding.top + Math.round(chartHeight / 2);
      var above = kind === 'carbs';
      var y = Math.max(padding.top + 26, Math.min(padding.top + chartHeight - 26, anchor + (above ? -28 : 28)));
      var dense = x - markerPositions[kind] < 55;
      if (!dense) markerPositions[kind] = x;
      var marker = context.append('g').datum(treatment).attr('class', 'daily-treatment daily-treatment-' + kind + (dense ? ' is-dense' : ''));
      marker.append('title').text(translate(above ? 'Carbs' : 'Bolus') + ': ' + label + ' · ' + dateFormat(client).time(profile.applyTimezone(moment(treatment.mills))));
      marker.append('line').attr('x1', x).attr('x2', x).attr('y1', anchor).attr('y2', y);
      marker.append('circle').attr('cx', x).attr('cy', y);
      marker.append('text').attr('x', x).attr('y', y + (above ? -13 : 21)).text(label);
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
              .attr('class', 'daily-note-text')
              .attr('y', foodtexts * 15 + padding.top)
              .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
              .text(htmlUtils.toTextContent(text));
            foodtexts = (foodtexts + 1) % 6;
            drawpointer = true;
          }
        }
        if (renderNotes && !treatment.duration && treatment.eventType !== 'Temp Basal') {
          context.append('text')
            .attr('class', 'daily-note-text')
            .attr('y', foodtexts * 15 + padding.top)
            .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
            .text(htmlUtils.toTextContent(treatment.notes));
          foodtexts = (foodtexts + 1) % 6;
          drawpointer = true;
        }
        if (drawpointer) {
          context.append('line')
            .attr('class', 'high-line daily-note-pointer')
            .attr('x1', xScale2(treatment.mills) + padding.left)
            .attr('y1', lastfoodtext * 15 + padding.top)
            .attr('x2', xScale2(treatment.mills) + padding.left)
            .attr('y2', padding.top + treatment.carbs ? yCarbsScale(treatment.carbs) : (treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight));
        }
      }

      if (treatment.carbs && options.carbs) {
        var label = ' ' + treatment.carbs + ' g';
        label += treatment.foodType ? ' ' + treatment.foodType : ''
        label += treatment.absorptionTime ? ' ' + (Math.round(treatment.absorptionTime / 60.0 * 10) / 10) + 'h' : ''
        if (treatment.protein) label += ' / ' + treatment.protein + ' g';
        if (treatment.fat) label += ' / ' + treatment.fat + ' g';

        if (premium) {
          appendTreatmentMarker(treatment, 'carbs', label.trim());
        } else {
        context.append('rect')
          .attr('class', 'daily-carbs-bar')
          .attr('y', yCarbsScale(treatment.carbs))
          .attr('height', chartHeight - yCarbsScale(treatment.carbs))
          .attr('width', 5)
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + +padding.top + ')');
        context.append('text')
          .attr('class', 'daily-treatment-label daily-carbs-label')
          .attr('transform', 'rotate(-45,' + (xScale2(treatment.mills) + padding.left) + ',' + (padding.top + yCarbsScale(treatment.carbs)) + ') ' +
            'translate(' + (xScale2(treatment.mills) + padding.left + 10) + ',' + (padding.top + yCarbsScale(treatment.carbs)) + ')')
          .text(htmlUtils.toTextContent(label));
        }
      }

      if (treatment.insulin && options.insulin) {
        var dataLabel = client.utils.toRoundedStr(treatment.insulin, 2)+ 'U';
        if (premium) {
          appendTreatmentMarker(treatment, 'bolus', client.utils.toRoundedStr(treatment.insulin, 2) + ' U');
        } else {
        context.append('rect')
          .attr('class', 'daily-insulin-bar')
          .attr('y', yInsulinScale(treatment.insulin))
          .attr('height', chartHeight - yInsulinScale(treatment.insulin))
          .attr('width', 5)
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left - 2) + ',' + +padding.top + ')');
        context.append('text')
          .attr('class', 'daily-treatment-label daily-insulin-label')
          //.attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'rotate(-45,' + (xScale2(treatment.mills) + padding.left - 2) + ',' + (padding.top + yInsulinScale(treatment.insulin)) + ')' +
            'translate(' + (xScale2(treatment.mills) + padding.left + 10) + ',' + (padding.top + yInsulinScale(treatment.insulin)) + ')')
          .text(dataLabel);
        }
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
            , profile: basalProfile.activeProfileToTime(times.mins(treatment.duration).msecs + treatment.mills + 1)
            , mills: times.mins(treatment.duration).msecs + treatment.mills
            , end: true
          });
        }
      } else if (treatment.duration) {
        appendDurationEvent(context, treatment);
      } else if (treatment.eventType === 'BG Check' && !treatment.duration && options.bgcheck) {
        context.append('circle')
           .attr('class', 'daily-bgcheck')
           .attr('cx', xScale2(treatment.mills) + padding.left)
           .attr('cy', yScale2(scaledTreatmentBG(treatment, data.sgv)) + padding.top);
      } else if (!treatment.duration && options.othertreatments) {
        // other treatments without duration
        context.append('circle')
          .attr('class', 'daily-other-treatment')
          .attr('cx', xScale2(treatment.mills) + padding.left)
          .attr('cy', yScale2(scaledTreatmentBG(treatment, data.sgv)) + padding.top);
        context.append('text')
          .attr('class', 'daily-treatment-label daily-other-treatment-label')
          .attr('y', yScale2(scaledTreatmentBG(treatment, data.sgv)) + padding.top - 10)
          .attr('x', xScale2(treatment.mills) + padding.left + 10)
          .text(htmlUtils.toTextContent(translate(client.careportal.resolveEventName(treatment.eventType))));
      } else {
        console.log("missed treatment", treatment);
      }
    });

    // Events with a duration that started on an earlier day and are still running
    // at this day's start. Treatments the loop above does not draw as a band are skipped.
    datastorage.treatments.forEach(function(treatment) {
      if (!treatment.duration || treatment.mills >= from.valueOf()) return;
      if (treatment.mills + times.mins(treatment.duration).msecs <= from.valueOf()) return;
      if (treatment.insulin || treatment.carbs || treatment.eventType === 'Temp Basal' || treatment.eventType === 'Combo Bolus' || treatment.eventType === 'Profile Switch') return;
      if (treatment.eventType === 'Note' && !options.notes) return;
      appendDurationEvent(context, treatment);
    });

    if (options.insulindistribution) {
      var totalBasalInsulin = baseBasalInsulin + positiveTemps + negativeTemps;
      var totalDailyInsulin = bolusInsulin + totalBasalInsulin;
      var summary = $('<div>').appendTo($('#daytodaystatchart-' + day));
      require('../report/daily-distribution')(summary, {
        basal: totalBasalInsulin, bolus: bolusInsulin, baseBasal: baseBasalInsulin,
        positiveTemps: positiveTemps, negativeTemps: negativeTemps,
        carbs: data.dailyCarbs, protein: data.dailyProtein, fat: data.dailyFat,
        maxCarbs: options.maxDailyCarbsValue
      }, translate, d3);
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
      profile: basalProfile.activeProfileToTime(from)
      , mills: from + times.mins(15).msecs
      , first: true
    });

    function appendDurationEvent (context, treatment) {
      if (treatment.eventType === 'Exercise') {
        appendDurationBand(context, treatment, 396, 'exercise', treatment.notes);
      } else if (treatment.eventType === 'Note') {
        appendDurationBand(context, treatment, 360, 'note', treatment.notes);
      } else if (treatment.eventType === 'OpenAPS Offline') {
        appendDurationBand(context, treatment, 324, 'offline', treatment.notes);
      } else if (treatment.eventType === 'Temporary Override') {
        // Loop Overrides with duration
        appendDurationBand(context, treatment, 432, 'override', treatment.reason);
      } else if (options.othertreatments) {
        // other treatments with duration
        appendDurationBand(context, treatment, 432, 'other', treatment.notes);
      } else {
        console.log("missed treatment", treatment);
      }
    }

    // Draws the part of the event that falls on this day, so an event that
    // crosses midnight shows on both days and stays inside each chart.
    function appendDurationBand (context, treatment, top, kind, label) {
      var start = Math.max(treatment.mills, from.valueOf());
      var end = Math.min(treatment.mills + times.mins(treatment.duration).msecs, to.valueOf());
      context.append('rect')
        .attr('class', 'daily-duration-band daily-duration-' + kind)
        .attr('x', xScale2(start) + padding.left)
        .attr('y', yScale2(client.utils.scaleMgdl(top)) + padding.top)
        .attr('width', xScale2(end) - xScale2(start))
        .attr('height', yScale2(client.utils.scaleMgdl(top - 36)) - yScale2(client.utils.scaleMgdl(top)));
      context.append('text')
        .attr('class', 'daily-treatment-label daily-duration-label daily-duration-' + kind)
        .attr('dy', '.35em')
        .attr('y', yScale2(client.utils.scaleMgdl(top - 18)) + padding.top)
        .attr('x', xScale2((start + end) / 2) + padding.left)
        .text(htmlUtils.toTextContent(label));
    }

    function appendProfileSwitch (context, treatment) {

      if (!treatment.cutting && !treatment.profile) { return; }

      var sign = treatment.first ? '▲▲▲' : '▬▬▬';
      var text;
      if (treatment.cutting) {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.cutting) + '    ' + '►►►' + '    ' + (treatment.profile ? client.profilefunctions.profileSwitchName(treatment.profile) : translate('Not available')) + '    ' + sign;
      } else {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      }
      if (premium) {
        context.append('text').attr('class', 'daily-profile-label')
          .attr('x', Math.max(padding.left + 110, Math.min(options.width - padding.right - 90, xScale2(treatment.mills) + padding.left + 6)))
          .attr('y', padding.top + (options.basal ? basalTop : 0) - 14)
          .text(htmlUtils.toTextContent(text.replace(/[▲►▬]/g, '').trim()));
        return;
      }
      context.append('text')
        .attr('class', 'daily-treatment-label daily-profile-switch')
        .attr('dy', '.35em')
        .attr('transform', 'rotate(-90 ' + (xScale2(treatment.mills) + padding.left) + ',' + (yScaleBasals(0) + padding.top - 10) + ') ' +
          'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + (yScaleBasals(0) + padding.top - 10) + ')')
        .text(htmlUtils.toTextContent(text));
    }

    if (premium) {
      var legend = chartHost.append('div').attr('class', 'daily-chart-legend');
      var legendItems = [[translate('Glucose'), 'glucose'], [translate('Target range') + ' (' + client.utils.roundBGForDisplay(options.targetLow) + '–' + client.utils.roundBGForDisplay(options.targetHigh) + ')', 'target']];
      if (options.basal) legendItems.push([translate('Basal') + ' (U/h)', 'basal']);
      if (options.insulin) legendItems.push([translate('Bolus') + ' (U)', 'bolus']);
      if (options.carbs) legendItems.push([translate('Carbs') + ' (g)', 'carbs']);
      legend.selectAll('span').data(legendItems).enter().append('span').attr('class', function(item) { return 'daily-legend-' + item[1]; }).text(function(item) { return item[0]; });
    }

    // Listen on the SVG so empty plot space and treatment overlays both track
    // the nearest real sensor reading, without adding an input-blocking overlay.
    var hoverLayer = svgNode.append('g').attr('class', 'daytoday-glucose-focus')
      .style('display', 'none');
    var hoverGuide = hoverLayer.append('line').attr('class', 'daily-hover-guide').attr('y1', padding.top).attr('y2', padding.top + plotBottom);
    var hoverDot = hoverLayer.append('circle').attr('class', 'daily-hover-dot');
    var hoverBasalDot = hoverLayer.append('circle').attr('class', 'daily-basal-focus')
      .style('display', 'none');
    var treatmentTimes = d3.bisector(function(t) { return Number(t.mills); });
    var hoverTreatments = (datastorage.treatments || data.treatments).filter(function(t) {
      return Number.isFinite(Number(t.mills)) && t.mills >= from.valueOf() - times.mins(5).msecs && t.mills < to.valueOf() + times.mins(5).msecs;
    }).slice().sort(function(a, b) { return a.mills - b.mills; });
    var basalTimeLookup = d3.bisector(function(p) { return Number(p.d); });
    function rateAt (points, at) {
      var index = basalTimeLookup.right(points, at) - 1;
      return index >= 0 ? points[index].b : undefined;
    }

    function clearChartHover () {
      hoverLayer.style('display', 'none');
      context.selectAll('.daily-treatment').classed('is-selected', false);
      hideTooltip();
    }

    svgNode.on('mousemove.daytoday', function(event) {
      const point = d3.pointer(event, svgNode.node());
      if (point[0] < padding.left - 4 || point[0] > padding.left + chartWidth + 4 ||
          point[1] < padding.top - 4 || point[1] > padding.top + plotBottom + 4) {
        clearChartHover();
        return;
      }
      // Retain the specific tooltip when hovering a raw, fingerstick or predicted point.
      const directReading = d3.select(event.target).datum();
      if (event.target.tagName.toLowerCase() === 'circle' && directReading &&
          contextData.indexOf(directReading) !== -1 && directReading.type !== 'sgv') {
        hoverLayer.style('display', 'none');
        return;
      }
      const plotX = Math.max(0, Math.min(chartWidth, point[0] - padding.left));
      const reading = hoverReadings.length ? hoverReadings[nearestReading(hoverReadings, +xScale2.invert(plotX))] : null;
      const at = Math.round(+xScale2.invert(plotX) / 1000) * 1000;
      const x = xScale2(at) + padding.left;
      hoverGuide.attr('x1', x).attr('x2', x);
      hoverDot.style('display', reading ? null : 'none');
      if (reading) hoverDot.attr('cx', xScale2(reading.date) + padding.left).attr('cy', yScale2(reading.sgv) + padding.top).attr('class', 'daily-hover-dot ' + glucoseTone(reading.color));
      hoverLayer.style('display', null);
      showReadingTooltip(event, reading, at);
    }).on('mouseleave.daytoday', clearChartHover);

    console.log("Rendering " + day, new Date().getTime() - timestart.getTime(), "msecs");
  }
};
