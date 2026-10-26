'use strict';

var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('../d3.mjs');
var htmlUtils = require('../utils/html');
var glucoseTrace = require('../client/glucose-trace');

var daytoday = {
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
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Day to day') + '</h2>' +
    '<b class="daily-report-hint">' + translate('To see this report, press SHOW while in this view') + '</b><br>' +
    '<div class="daily-display-controls">' + translate('Display') + ': ' +
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
    '  <option x="1000" y="300" selected>1000x300px</option>' +
    '  <option x="1200" y="400">1200x400px</option>' +
    '  <option x="1550" y="600">1550x600px</option>' +
    '  <option x="2400" y="800">2400x800px</option>' +
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
    '<br>' +
    '</div><div id="daytodaycharts">' +
    '</div>';
  return ret;
};

daytoday.prepareHtml = function daytodayPrepareHtml (sorteddaystoshow) {
  $('#daytodaycharts').html('');
  sorteddaystoshow.forEach(function eachDay (d) {
    $('#daytodaycharts').append($('<table class="daily-report-card"><tr><td class="daily-chart-main"><div id="daytodaychart-' + d + '"></div></td><td class="daily-chart-aside"><div id="daytodaystatchart-' + d + '"></div></td></tr></table>'));
  });
};

daytoday.report = function report_daytoday (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  var premium = client.settings.theme === 'modern';
  var padding = premium ? { top: 30, right: 24, bottom: 28, left: 48 } : { top: 15, right: 22, bottom: 30, left: 35 };

  // Canonical 2026 palette (style-only refresh).
  var palette = {
    targetBand: 'rgba(76,175,80,0.12)'
    , targetBandStroke: '#cfd8dc'
    , basal: '#1f6fc4'
    , tempBasal: 'rgba(31,111,196,0.5)'
    , iob: '#2f80ed'
    , cob: '#f2994a'
    , prediction: '#8E5FD0'
    , gridline: '#eceff1'
    , axisText: '#607d8b'
  };

  var tddSum = 0;
  var basalSum = 0;
  var baseBasalSum = 0;
  var bolusSum = 0;
  var carbsSum = 0;
  var proteinSum = 0;
  var fatSum = 0;

  hideTooltip();
  daytoday.prepareHtml(sorteddaystoshow);
  console.log('DAY2DAY', 'sorteddaystoshow', sorteddaystoshow);
  sorteddaystoshow.forEach(function eachDay (day) {

    drawChart(day, datastorage[day], options);
  });

  var tddAverage = tddSum / datastorage.alldays;
  var basalAveragePercent = Math.round( (basalSum / datastorage.alldays) / tddAverage * 100);
  var baseBasalAveragePercent = Math.round( (baseBasalSum / datastorage.alldays) / tddAverage * 100);
  var bolusAveragePercent = Math.round( (bolusSum / datastorage.alldays) / tddAverage * 100);
  var carbsAverage = carbsSum / datastorage.alldays;
  var proteinAverage = proteinSum / datastorage.alldays;
  var fatAverage = fatSum / datastorage.alldays;

  if (options.insulindistribution) {
    var html = '<br><br><b>' + translate('TDD average') + ':</b> ' + tddAverage.toFixed(1) + 'U&nbsp; ';
    html += '<b>' + translate('Bolus average') + ':</b> ' + bolusAveragePercent + '%&nbsp; ';
    html += '<b>' + translate('Basal average') + ':</b> ' + basalAveragePercent + '%&nbsp; ';
    html += '<b>(' + translate('Base basal average:') + '</b> ' + baseBasalAveragePercent + '%<b>)</b>&nbsp; ';
    html += '<b>' + translate('Carbs average') + ':</b> ' + carbsAverage.toFixed(0) + 'g&nbsp; ';
    html += '<b>' + translate('Protein average') + ':</b> ' + proteinAverage.toFixed(0) + 'g&nbsp; ';
    html += '<b>' + translate('Fat average') + ':</b> ' + fatAverage.toFixed(0) + 'g';
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
    var tickValues
      , charts
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

    // add defs for combo boluses
    var dashWidth = 5;
    d3.select('body').append('svg')
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
      .style('stroke', palette.basal)
      .style('stroke-width', 2)
      .append('path').attr('d', 'M0,0 l' + dashWidth + ',' + dashWidth)
      .append('path').attr('d', 'M' + dashWidth + ',0 l-' + dashWidth + ',' + dashWidth);

    var chartHost = d3.select('#daytodaychart-' + day).html('');
    if (premium) {
      var header = chartHost.append('div').attr('class', 'daily-chart-header');
      header.append('div').append('h3').text(profile.parseInTimezone(day).format('dddd, D MMMM YYYY'));
      header.append('span').attr('class', 'daily-trend-pill').text(translate('Smoothed trend'));
    } else {
      chartHost.append('b').text(report_plugins.utils.localeDate(day));
      chartHost.append('br');
    }
    charts = chartHost.append('svg').attr('class', 'daily-chart-svg');

    charts.append('rect')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('fill', '#ffffff');

    context = charts.append('g');

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

    xAxis2 = d3.axisBottom(xScale2)
      .tickFormat(timeTicks)
      .ticks(24);

    yAxis2 = d3.axisLeft(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues);

    // get current data range
    var dataRange = d3.extent(data.sgv, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = options.width - padding.left - padding.right;
    var chartHeight = options.height - padding.top - padding.bottom;
    if (premium) chartHeight = Math.max(240, chartHeight);
    var basalTop = chartHeight + (premium ? 32 : 46);
    var plotBottom = premium && options.basal ? basalTop + 64 : chartHeight;
    if (premium) {
      xAxis2.tickFormat(function(date) { return profile.applyTimezone(moment(date)).format(client.settings.timeFormat === 24 ? 'HH:mm' : 'ha'); })
        .ticks(d3.timeHour.every(2)).tickSizeOuter(0);
    }

    //set the width and height of the SVG element
    charts.attr('width', options.width)
      .attr('height', premium ? plotBottom + padding.top + padding.bottom : options.height);
    if (premium) charts.attr('viewBox', '0 0 ' + options.width + ' ' + (plotBottom + padding.top + padding.bottom));

    // ranges are based on the width and height available so reset
    xScale2.range([0, chartWidth]);
    yScale2.range([chartHeight, 0]);
    yInsulinScale.range([chartHeight * 2, 0]);
    yCarbsScale.range([chartHeight, 0]);
    yScaleBasals.range(premium ? [basalTop, plotBottom] : [yScale2(client.utils.scaleMgdl(72)), chartHeight]);

    // add target BG rect
    context.append('rect')
      .attr('x', xScale2(dataRange[0]) + padding.left)
      .attr('y', yScale2(options.targetHigh) + padding.top)
      .attr('width', xScale2(dataRange[1]) - xScale2(dataRange[0]))
      .attr('height', yScale2(options.targetLow) - yScale2(options.targetHigh))
      .style('fill', premium ? '#e8f7ef' : palette.targetBand)
      .attr('stroke', premium ? 'none' : palette.targetBandStroke);

    // create the x axis container
    context.append('g')
      .attr('class', 'x axis');

    // create the y axis container
    context.append('g')
      .attr('class', 'y axis');

    context.select('.y')
      .attr('transform', 'translate(' + (padding.left) + ',' + padding.top + ')')
      .style('stroke', '#cfd8dc')
      .style('shape-rendering', 'crispEdges')
      .style('fill', 'none')
      .call(yAxis2);

    // if first run then just display axis with no transition
    context.select('.x')
      .attr('transform', 'translate(' + padding.left + ',' + (plotBottom + padding.top) + ')')
      .style('stroke', '#cfd8dc')
      .style('shape-rendering', 'crispEdges')
      .style('fill', 'none')
      .call(xAxis2);
    if (premium) {
      context.select('.x').selectAll('.tick line').attr('y2', -plotBottom).attr('stroke', '#e3ebf3').attr('stroke-dasharray', '2 5');
      context.append('text').attr('class', 'daily-axis-label').attr('x', padding.left).attr('y', 16)
        .text(translate('Glucose') + ' (' + (client.settings.units === 'mmol' ? 'mmol/L' : 'mg/dL') + ')');
    }
    tickValues?.forEach(function(n, li) {
      context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(dataRange[0]) + padding.left)
        .attr('y1', yScale2(tickValues[li]) + padding.top)
        .attr('x2', xScale2(dataRange[1]) + padding.left)
        .attr('y2', yScale2(tickValues[li]) + padding.top)
        .style('stroke-dasharray', ('1, 5'))
        .attr('stroke', palette.gridline);
    });

    var connectedReadings = new Set();

    function glucoseStroke (color) {
      return color === 'green' || color === 'darkgreen' ? (premium ? '#009b73' : '#348165') : color === 'red' ? (premium ? '#e65f6b' : '#df5260') : color;
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
        htmlUtils.textAsHtml(profile.applyTimezone(moment(at)).format('ddd D MMM')) + '</span></div><div class="daily-tooltip-metrics">' +
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
      client.tooltip.classed('daytoday-reading-tooltip', true).html(text).style('display', 'block');
      var bounds = client.tooltip.node().getBoundingClientRect();
      var left = Math.max(window.scrollX + 8, Math.min(event.pageX + 12, window.scrollX + document.documentElement.clientWidth - bounds.width - 8));
      // Anchor vertically to the plot, independent of the pointer and content height.
      var plotTop = charts.node().getBoundingClientRect().top + window.scrollY + padding.top + 12;
      var top = Math.max(window.scrollY + 8, Math.min(plotTop, window.scrollY + Math.max(8, window.innerHeight - 360)));
      client.tooltip.style('left', left + 'px').style('top', top + 'px');
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
        .attr('fill', function(d) {
          if (connectedReadings.has(d) || (d.color === 'gray' && !options.raw)) {
            return 'transparent';
          }
          return d.color;
        })
        .attr('class', function(d) { return d.type === 'sgv' ? 'daytoday-glucose-sample' : null; })
        .style('pointer-events', function(d) { return d.color === 'transparent' || !Number.isFinite(d.sgv) || (d.color === 'gray' && !options.raw) ? 'none' : 'all'; })
        .style('cursor', 'crosshair')
        .style('opacity', function(d) { return connectedReadings.has(d) ? 1 : 0.5; })
        .attr('stroke-width', function(d) { if (d.type === 'mbg') { return 2; } else if (options.openAps && d.openaps) { return 1; } else { return 0; } })
        .attr('stroke', function() { return 'black'; })
        .attr('r', function(d) {
          if (connectedReadings.has(d)) {
            return 6;
          } else if (d.type === 'mbg') {
            return 4;
          } else {
            return 2 + (options.width - 800) / 400;
          }
        })
        .on('mouseover', function(event, d) {
          if (connectedReadings.has(d)) d3.select(this).attr('r', 4).attr('fill', '#fff').attr('stroke', glucoseStroke(d.color)).attr('stroke-width', 1.75);
          showReadingTooltip(event, d);
        })
        .on('mousemove', showReadingTooltip)
        .on('mouseout', function(event, d) {
          if (connectedReadings.has(d)) d3.select(this).attr('r', 6).attr('fill', 'transparent').attr('stroke-width', 0);
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
        if (undefined != treatment.carbs && null != treatment.carbs && treatment.carbs > 0) {
          if (treatment.timestamp)
            treatmentsTimestamps.push(treatment.timestamp);
          else if (treatment.created_at)
            treatmentsTimestamps.push(treatment.created_at);
        }
        if (undefined != treatment.insulin && null != treatment.insulin && treatment.insulin > 0) {
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
                value.color = palette.prediction;
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
    var glucoseLine = d3.line().x(function(p) { return xScale2(p.mills) + padding.left; })
      .y(function(p) { return yScale2(p.mgdl) + padding.top; }).curve(d3.curveBasis);
    glucoseRuns.forEach(function(run) { run.points.forEach(function(p) { connectedReadings.add(p.reading); }); });
    if (premium) {
      var gradientId = 'daily-glucose-fade-' + day;
      var gradient = charts.append('defs').append('linearGradient').attr('id', gradientId).attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 1);
      gradient.append('stop').attr('offset', '0%').attr('stop-color', '#009b73').attr('stop-opacity', .12);
      gradient.append('stop').attr('offset', '100%').attr('stop-color', '#009b73').attr('stop-opacity', 0);
      var wash = d3.area().x(function(p) { return xScale2(p.mills) + padding.left; })
        .y0(chartHeight + padding.top).y1(function(p) { return yScale2(p.mgdl) + padding.top; }).curve(d3.curveBasis);
      context.selectAll('path.daily-glucose-wash').data(glucoseRuns).enter().append('path')
        .attr('class', 'daily-glucose-wash').attr('fill', 'url(#' + gradientId + ')').style('pointer-events', 'none')
        .attr('d', function(run) { return wash(run.points); });
    }
    context.selectAll('path.daytoday-glucose-line').data(glucoseRuns).enter().append('path')
      .attr('class', 'daytoday-glucose-line').attr('fill', 'none')
      .attr('stroke', function(run) { return glucoseStroke(run.color); }).attr('stroke-width', premium ? 2 : 1.75)
      .attr('vector-effect', 'non-scaling-stroke')
      .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
      .style('pointer-events', 'none').attr('d', function(run) { return glucoseLine(run.points); });
    // The curve is a visual trend; hover continues to use the untouched samples.
    if (glucoseRuns.length && !premium) {
      context.append('text').attr('class', 'daytoday-trace-label')
        .attr('x', options.width - padding.right).attr('y', 10).attr('text-anchor', 'end')
        .attr('fill', '#66778c').style('font-size', '10px').style('pointer-events', 'none')
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

    iobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
    cobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
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
        var cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).cob;
        if (!dt.isSame(from)) {
          cobpolyline += ', ';
        }
        cobpolyline += (xScale2(dt.toDate()) + padding.left) + ',' + (yCarbsScale(cob) + padding.top) + ' ';
      }
    }

    if (options.basal) {
      var basalTimes = profile.getBasalRenderTimes(from.valueOf(), to.valueOf(), times.mins(5).msecs);

      basalTimes.forEach(function renderBasal (date, index) {
        var nextDate = index + 1 < basalTimes.length ? basalTimes[index + 1] : to.valueOf();
        var durationHours = Math.max(0, Math.min(nextDate, to.valueOf()) - date) / times.hour().msecs;
        var hournow = profile.applyTimezone(moment(date)).hour();
        var basalvalue = profile.getTempBasal(date);

        // Calculate basal stats over the interval until the next sample/boundary.
        baseBasalInsulin += basalvalue.basal * durationHours;
        var tempPart = (basalvalue.tempbasal - basalvalue.basal) * durationHours;
        if (tempPart > 0) {
          positiveTemps += tempPart;
          data.netBasalPositive[hournow] += tempPart;
        }
        if (tempPart < 0) {
          negativeTemps += tempPart;
          data.netBasalNegative[hournow] += tempPart;
        }

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
        .attr('stroke', palette.iob)
        .attr('fill', 'none')
        .attr('opacity', '0.7')
        .attr('fill-opacity', '0.1')
        .attr('points', iobpolyline);
    }
    if (options.cob) {
      context.append('polyline')
        .attr('stroke', palette.cob)
        .attr('fill', 'none')
        .attr('opacity', '0.7')
        .attr('fill-opacity', '0.1')
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

      yScaleBasals.domain([basalMax || 1, 0]);
      if (premium) {
        yScaleBasals.domain([Math.max(basalMax * 1.15, .1), 0]).nice(3);
        context.append('g').attr('class', 'daily-basal-axis axis')
          .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')')
          .call(d3.axisLeft(yScaleBasals).ticks(3).tickSizeOuter(0));
        context.append('text').attr('class', 'daily-axis-label').attr('x', padding.left).attr('y', basalTop + padding.top - 14)
          .text(translate('Basal') + ' (U/h)');
      }

      var valueline = d3.line()
        .curve(d3.curveStepAfter)
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y(function(d) { return yScaleBasals(d.b) + padding.top; });

      var area = d3.area()
        .curve(d3.curveStepAfter)
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y0(yScaleBasals(0) + padding.top)
        .y1(function(d) { return yScaleBasals(d.b) + padding.top; });

      var g = basals.append('g');

      g.append('path')
        .attr('class', 'line basalline')
        .attr('stroke', palette.basal)
        .attr('stroke-width', 1)
        .attr('fill', 'none')
        .attr('d', valueline(linedata))
        .attr('clip-path', premium ? null : 'url(#clip)');

      g.append('path')
        .attr('class', 'line notempline')
        .attr('stroke', palette.basal)
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', ('3, 3'))
        .attr('fill', 'none')
        .attr('d', valueline(notemplinedata))
        .attr('clip-path', premium ? null : 'url(#clip)');

      g.append('path')
        .attr('class', 'area basalarea')
        .datum(basalareadata)
        .attr('fill', palette.basal)
        .attr('fill-opacity', .1)
        .attr('stroke-width', 0)
        .attr('d', area);

      g.append('path')
        .attr('class', 'area tempbasalarea')
        .datum(tempbasalareadata)
        .attr('fill', palette.tempBasal)
        .attr('fill-opacity', .3)
        .attr('stroke-width', 1)
        .attr('d', area);

      g.append('path')
        .attr('class', 'area comboarea')
        .datum(comboareadata)
        .attr('fill', 'url(#hash)')
        .attr('fill-opacity', .3)
        .attr('stroke-width', 1)
        .attr('d', area);

      datastorage.tempbasalTreatments.forEach(function(t) {
        // only if basal and focus interval overlap and there is a chance to fit
        if (t.mills < to.format('x') && t.mills + times.mins(t.duration).msecs > from.format('x')) {
          var text = g.append('text')
            .attr('class', 'tempbasaltext')
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('fill', palette.basal)
            .attr('text-anchor', 'middle')
            .attr('dy', '.35em')
            .attr('x', xScale2((Math.max(t.mills, from.format('x')) + Math.min(t.mills + times.mins(t.duration).msecs, to.format('x'))) / 2) + padding.left)
            .attr('y', yScaleBasals(0) - 10 + padding.top)
          //            .text((t.percent ? (t.percent > 0 ? '+' : '') + t.percent + '%' : '') + (t.absolute ? Number(t.absolute).toFixed(2) + 'U' : ''));
          // better hide if not fit
          if (text.node().getBBox().width > xScale2(t.mills + times.mins(t.duration).msecs) - xScale2(t.mills)) {
            text.attr('display', 'none');
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
      var anchor = sample && Math.abs(+sample.date - treatment.mills) <= times.mins(7.5).msecs ? yScale2(sample.sgv) + padding.top : padding.top + chartHeight / 2;
      var above = kind === 'carbs';
      var y = Math.max(padding.top + 26, Math.min(padding.top + chartHeight - 26, anchor + (above ? -28 : 28)));
      var dense = x - markerPositions[kind] < 55;
      if (!dense) markerPositions[kind] = x;
      var color = above ? '#dc820d' : '#347de1';
      var marker = context.append('g').datum(treatment).attr('class', 'daily-treatment daily-treatment-' + kind + (dense ? ' is-dense' : ''));
      marker.append('title').text(translate(above ? 'Carbs' : 'Bolus') + ': ' + label + ' · ' + profile.applyTimezone(moment(treatment.mills)).format('LT'));
      marker.append('line').attr('x1', x).attr('x2', x).attr('y1', anchor).attr('y2', y).attr('stroke', color).attr('stroke-opacity', .4);
      marker.append('circle').attr('cx', x).attr('cy', y).attr('r', 3.5).attr('fill', color).attr('stroke', '#fff').attr('stroke-width', 1.5);
      marker.append('text').attr('x', x).attr('y', y + (above ? -13 : 21)).attr('text-anchor', 'middle').attr('fill', color).text(label);
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
              .attr('y', foodtexts * 15 + padding.top)
              .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
              .text(htmlUtils.toTextContent(text));
            foodtexts = (foodtexts + 1) % 6;
            drawpointer = true;
          }
        }
        if (renderNotes && !treatment.duration && treatment.eventType !== 'Temp Basal') {
          context.append('text')
            .style('font-size', '10px')
            .style('font-weight', 'normal')
            .attr('fill', 'black')
            .attr('y', foodtexts * 15 + padding.top)
            .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
            .text(htmlUtils.toTextContent(treatment.notes));
          foodtexts = (foodtexts + 1) % 6;
          drawpointer = true;
        }
        if (drawpointer) {
          context.append('line')
            .attr('class', 'high-line')
            .attr('x1', xScale2(treatment.mills) + padding.left)
            .attr('y1', lastfoodtext * 15 + padding.top)
            .attr('x2', xScale2(treatment.mills) + padding.left)
            .attr('y2', padding.top + treatment.carbs ? yCarbsScale(treatment.carbs) : (treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight))
            .style('stroke-dasharray', ('1, 7'))
            .attr('stroke', palette.axisText);
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
          .attr('y', yCarbsScale(treatment.carbs))
          .attr('height', chartHeight - yCarbsScale(treatment.carbs))
          .attr('width', 5)
          .attr('stroke', 'red')
          .attr('opacity', '0.5')
          .attr('fill', 'red')
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + +padding.top + ')');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'red')
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
          .attr('y', yInsulinScale(treatment.insulin))
          .attr('height', chartHeight - yInsulinScale(treatment.insulin))
          .attr('width', 5)
          .attr('stroke', 'blue')
          .attr('opacity', '0.5')
          .attr('fill', 'blue')
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left - 2) + ',' + +padding.top + ')');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'blue')
          //.attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'rotate(-45,' + (xScale2(treatment.mills) + padding.left - 2) + ',' + (padding.top + yInsulinScale(treatment.insulin)) + ')' +
            'translate(' + (xScale2(treatment.mills) + padding.left + 10) + ',' + (padding.top + yInsulinScale(treatment.insulin)) + ')')
          .text(dataLabel);
        }
      }

      // process the rest
      if (treatment.insulin || treatment.carbs || treatment.eventType == 'Temp Basal' || treatment.eventType == 'Combo Bolus') {
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
        appendDurationEvent(context, treatment);
      } else if (treatment.eventType === 'BG Check' && !treatment.duration && options.bgcheck) {
        context.append('circle')
           .attr('cx', xScale2(treatment.mills) + padding.left)
           .attr('cy', yScale2(scaledTreatmentBG(treatment, data.sgv)) + padding.top)
           .attr('fill', 'red')
           .style('opacity', 1)
           .attr('stroke-width', 1)
           .attr('stroke', 'darkred')
           .attr('r', 4);
      } else if (!treatment.duration && options.othertreatments) {
        // other treatments without duration
        context.append('circle')
          .attr('cx', xScale2(treatment.mills) + padding.left)
          .attr('cy', yScale2(scaledTreatmentBG(treatment, data.sgv)) + padding.top)
          .attr('fill', 'purple')
          .style('opacity', 1)
          .attr('stroke-width', 1)
          .attr('stroke', 'black')
          .attr('r', 4);
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'purple')
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
      profile: client.profilefunctions.activeProfileToTime(from)
      , mills: from + times.mins(15).msecs
      , first: true
    });

    function appendDurationEvent (context, treatment) {
      if (treatment.eventType === 'Exercise') {
        appendDurationBand(context, treatment, 396, 'Violet', treatment.notes);
      } else if (treatment.eventType === 'Note') {
        appendDurationBand(context, treatment, 360, 'Salmon', treatment.notes);
      } else if (treatment.eventType === 'OpenAPS Offline') {
        appendDurationBand(context, treatment, 324, 'Brown', treatment.notes);
      } else if (treatment.eventType === 'Temporary Override') {
        // Loop Overrides with duration
        appendDurationBand(context, treatment, 432, 'black', treatment.reason);
      } else if (options.othertreatments) {
        // other treatments with duration
        appendDurationBand(context, treatment, 432, 'black', treatment.notes);
      } else {
        console.log("missed treatment", treatment);
      }
    }

    // Draws the part of the event that falls on this day, so an event that
    // crosses midnight shows on both days and stays inside each chart.
    function appendDurationBand (context, treatment, top, fill, label) {
      var start = Math.max(treatment.mills, from.valueOf());
      var end = Math.min(treatment.mills + times.mins(treatment.duration).msecs, to.valueOf());
      context.append('rect')
        .attr('x', xScale2(start) + padding.left)
        .attr('y', yScale2(client.utils.scaleMgdl(top)) + padding.top)
        .attr('width', xScale2(end) - xScale2(start))
        .attr('height', yScale2(client.utils.scaleMgdl(top - 36)) - yScale2(client.utils.scaleMgdl(top)))
        .attr('stroke-width', 1)
        .attr('opacity', .2)
        .attr('stroke', 'white')
        .attr('fill', fill);
      context.append('text')
        .style('font-size', '12px')
        .style('font-weight', 'bold')
        .attr('fill', fill)
        .attr('text-anchor', 'middle')
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
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.cutting) + '    ' + '►►►' + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      } else {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      }
      if (premium) {
        context.append('text').attr('class', 'daily-profile-label')
          .attr('x', Math.max(padding.left + 110, Math.min(options.width - padding.right - 90, xScale2(treatment.mills) + padding.left + 6)))
          .attr('y', padding.top + (options.basal ? basalTop : 0) - 14)
          .attr('fill', '#70849c').style('font-size', '10px').text(htmlUtils.toTextContent(text.replace(/[▲►▬▬]/g, '').trim()));
        return;
      }
      context.append('text')
        .style('font-size', 12)
        .style('font-weight', 'bold')
        .attr('fill', palette.basal)
        .attr('text-anchor', 'start')
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
    var hoverLayer = charts.append('g').attr('class', 'daytoday-glucose-focus')
      .style('pointer-events', 'none').style('display', 'none');
    var hoverGuide = hoverLayer.append('line').attr('y1', padding.top).attr('y2', padding.top + plotBottom)
      .attr('stroke', '#8094aa').attr('stroke-opacity', .45).attr('stroke-width', 1).attr('stroke-dasharray', '3 4');
    var hoverDot = hoverLayer.append('circle').attr('r', 4).attr('fill', '#fff').attr('stroke-width', 1.75);
    var hoverBasalDot = hoverLayer.append('circle').attr('class', 'daily-basal-focus').attr('r', 3.5)
      .attr('fill', '#fff').attr('stroke', palette.basal).attr('stroke-width', 1.75).style('display', 'none');
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

    charts.on('mousemove.daytoday', function(event) {
      var point = d3.pointer(event, charts.node());
      if (point[0] < padding.left - 4 || point[0] > padding.left + chartWidth + 4 ||
          point[1] < padding.top - 4 || point[1] > padding.top + plotBottom + 4) {
        clearChartHover();
        return;
      }
      // Retain the specific tooltip when hovering a raw, fingerstick or predicted point.
      var directReading = d3.select(event.target).datum();
      if (event.target.tagName.toLowerCase() === 'circle' && directReading &&
          contextData.indexOf(directReading) !== -1 && directReading.type !== 'sgv') {
        hoverLayer.style('display', 'none');
        return;
      }
      var plotX = Math.max(0, Math.min(chartWidth, point[0] - padding.left));
      var reading = hoverReadings.length ? hoverReadings[nearestReading(hoverReadings, +xScale2.invert(plotX))] : null;
      var at = Math.round(+xScale2.invert(plotX) / 1000) * 1000;
      var x = xScale2(at) + padding.left;
      hoverGuide.attr('x1', x).attr('x2', x);
      hoverDot.style('display', reading ? null : 'none');
      if (reading) hoverDot.attr('cx', xScale2(reading.date) + padding.left).attr('cy', yScale2(reading.sgv) + padding.top).attr('stroke', glucoseStroke(reading.color));
      hoverLayer.style('display', null);
      showReadingTooltip(event, reading, at);
    }).on('mouseleave.daytoday', clearChartHover);

    console.log("Rendering " + day, new Date().getTime() - timestart.getTime(), "msecs");
  }

  function hideTooltip () {
    client.tooltip.style('display', 'none').classed('daytoday-reading-tooltip', false);
  }
};
