'use strict';
var d3 = (global && global.d3) || require('../d3.mjs');
var plainAxis = require('../report/plain-axis');
var textAsHtml = require('../utils/html').textAsHtml;

var calibrations = {
  name: 'calibrations'
  , label: 'Calibrations'
  , pluginType: 'report'
};

function init () {
  return calibrations;
}

module.exports = init;

calibrations.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Calibrations') + '</h2>' +
    '<p class="calibrations-help">' + textAsHtml(translate('Compare meter glucose with uploaded raw sensor signals and calibration curves. Colours link rows to the chart.')) + '</p>' +
    '<p class="calibrations-help">' + textAsHtml(translate('The latest three meter readings are selected automatically. Use Show in chart to compare other readings. Selections only change this display.')) + '</p>' +
    '<div class="calibrations-layout"><div id="calibrations-list"></div>' +
    '<div id="calibrations-chart-panel"><div id="calibrations-chart"></div><p id="calibrations-status" role="status"></p></div></div>';
  return ret;
};

calibrations.report = function report_calibrations (datastorage, sorteddaystoshow) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var report_plugins = Nightscout.report_plugins;
  var units = client.settings.units === 'mmol' ? 'mmol/L' : 'mg/dL';

  var padding = { top: 20, right: 20, bottom: 50, left: 90 };
  var treatments = [];
  var cals = [];
  var sgvs = [];
  var mbgs = [];
  sorteddaystoshow.forEach(function(day) {
    treatments = treatments.concat(datastorage[day].treatments.filter(function(t) {
      return t.eventType === 'Sensor Start' || t.eventType === 'Sensor Change';
    }).map(function(e) { return Object.assign({}, e, {kind: 'event'}); }));
    cals = cals.concat(datastorage[day].cal.map(function(e) { return Object.assign({}, e, {kind: 'cal'}); }));
    sgvs = sgvs.concat(datastorage[day].sgv);
    mbgs = mbgs.concat(datastorage[day].mbg.map(function(e) { return Object.assign({}, e, {kind: 'mbg'}); }));
  });

  // The report pipeline mixes sensor, derived, meter and boundary entries and
  // may load days newest first. Match only timestamped sensor raw signals.
  sgvs = sgvs.filter(function(e) { return !e.type || e.type === 'sgv'; }).map(function(e) {
    var filtered = Number(e.filtered), unfiltered = Number(e.unfiltered);
    return {mills: e.mills, raw: Number.isFinite(filtered) && filtered > 0 ? filtered : unfiltered};
  }).filter(function(e) { return Number.isFinite(e.mills) && Number.isFinite(e.raw) && e.raw > 0; })
    .sort(function(a, b) { return a.mills - b.mills; });
  mbgs.forEach(function(mbg) { calcmbg(mbg); });

  var events = treatments.concat(cals).concat(mbgs).sort(function(a, b) { return a.mills - b.mills; });

  // The colour palette itself lives in report.css (.calibrations-color-N).
  var colorCount = 12;
  var colorindex = 0;
  var meterLabel = translate('Meter glucose') + ' (' + units + ')';
  var html = '<table class="calibrations-table"><thead><tr>' +
    [translate('Show in chart'), translate('Date / time'), meterLabel, translate('Raw signal')].map(function(label) {
      return '<th scope="col">' + textAsHtml(label) + '</th>';
    }).join('') + '</tr></thead><tbody>';
  var lastmbg = null;
  for (var i = 0; i < events.length; i++) {
    var e = events[i];
    if (e.kind === 'mbg') colorindex = (colorindex + 1) % colorCount;
    e.colorClass = 'calibrations-color-' + colorindex;
    var date = textAsHtml(report_plugins.utils.localeDateTime(new Date(e.mills)));
    html += '<tr class="calibrations-' + e.kind + '"><td class="calibrations-select">';
    if (e.kind !== 'event') html += '<span class="calibrations-swatch ' + e.colorClass + '" aria-hidden="true"></span>';
    if (e.kind === 'mbg') {
      html += '<input type="checkbox" data-index="' + i + '" class="calibrations-checkbox" id="calibrations-' + i +
        '" aria-label="' + textAsHtml(translate('Show in chart')) + ': ' + date + '">';
    }
    html += '</td><td class="calibrations-date">' + date + '</td>';
    if (e.kind === 'event') {
      html += '<td class="calibrations-details" colspan="2">' + textAsHtml(translate(e.eventType)) + '</td>';
    } else if (e.kind === 'mbg') {
      html += '<td data-label="' + textAsHtml(meterLabel) + '">' + textAsHtml(client.utils.roundBGForDisplay(client.utils.scaleMgdl(e.y))) + '</td>' +
        '<td data-label="' + textAsHtml(translate('Raw signal')) + '">' + textAsHtml(e.raw === undefined ? translate('Not available') : e.raw) + '</td>';
      lastmbg = e;
      e.cals = [];
      e.checked = false;
    } else if (e.kind === 'cal') {
      html += '<td class="calibrations-details" colspan="2">' + textAsHtml(translate('Calibration')) + ': Scale: ' +
        e.scale.toFixed(2) + ' Intercept: ' + e.intercept.toFixed(0) + ' Slope: ' + e.slope.toFixed(2) + '</td>';
      if (lastmbg) {
        lastmbg.cals.push(e);
      }
    }
    html += '</tr>';
  }

  if (!events.length) html += '<tr><td colspan="4">' + textAsHtml(translate('No data available')) + '</td></tr>';
  html += '</tbody></table>';

  $('#calibrations-list').html(html);

  var calibration_context, xScale2, yScale2;

  // Select the latest three meter readings, including the first/only entry.
  checkLastCheckboxes(3);
  drawelements();

  $('.calibrations-checkbox').change(checkboxevent);

  function checkLastCheckboxes (maxcals) {
    for (i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'mbg') {
        events[i].checked = true;
        $('#calibrations-' + i).prop('checked', true);
        if (--maxcals < 1) {
          break;
        }
      }
    }
  }

  function checkboxevent () {
    var index = $(this).attr('data-index');
    events[index].checked = $(this).is(':checked');
    drawelements();
  }

  function drawelements () {
    drawChart();
    var selected = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.checked) {
        selected++;
        drawmbg(e);
        e.cals.forEach(drawcal);
      }
    }
    $('#calibrations-status').text(!mbgs.length ? translate('No meter readings are available in the selected period.') :
      !selected ? translate('Select a meter reading to show it in the chart.') :
      calibration_context.selectAll('.calibrations-point, .calibrations-curve').empty() ?
        translate('No matching raw sensor data or calibration curves are available for the selected readings.') : '');
  }

  function drawChart () {
    var maxBG = client.utils.scaleMgdl(500);

    $('#calibrations-chart').empty();
    var charts = d3.select('#calibrations-chart').append('svg').attr('role', 'img')
      .attr('aria-label', translate('Meter glucose compared with raw sensor signal'));

    charts.append('rect')
      .attr('class', 'daily-chart-background')
      .attr('width', '100%')
      .attr('height', '100%');

    calibration_context = charts.append('g');

    // define the parts of the axis that aren't dependent on width or height
    xScale2 = d3.scaleLinear()
      .domain([0, maxBG]);

    yScale2 = d3.scaleLinear()
      .domain([0, 400000]);

    var xAxis2 = d3.axisBottom(xScale2).offset(0)
      .ticks(5);

    var yAxis2 = d3.axisLeft(yScale2).offset(0).ticks(8).tickFormat(d3.format('~s'));

    // get current data range
    var dataRange = [0, maxBG];
    var width = 600;
    var height = 440;

    // get the entire container height and width subtracting the padding
    var chartWidth = width - padding.left - padding.right;
    var chartHeight = height - padding.top - padding.bottom;

    //set the width and height of the SVG element
    charts.attr('width', width)
      .attr('height', height).attr('viewBox', '0 0 ' + width + ' ' + height);

    charts.append('text').attr('class', 'calibrations-axis-label')
      .attr('x', Math.round(padding.left + chartWidth / 2)).attr('y', height - 10).text(meterLabel);
    charts.append('text').attr('class', 'calibrations-axis-label').attr('transform', 'rotate(-90)')
      .attr('x', -Math.round(padding.top + chartHeight / 2)).attr('y', 20).text(translate('Raw signal'));

    // ranges are based on the width and height available so reset
    xScale2.rangeRound([0, chartWidth]);
    yScale2.rangeRound([chartHeight, 0]);

    // create the x axis container
    calibration_context.append('g')
      .attr('class', 'x axis');

    // create the y axis container
    calibration_context.append('g')
      .attr('class', 'y axis');

    calibration_context.select('.y')
      .attr('transform', 'translate(' + ( /*chartWidth + */ padding.left) + ',' + padding.top + ')')
      .call(yAxis2).call(plainAxis, 'left');

    // if first run then just display axis with no transition
    calibration_context.select('.x')
      .attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
      .call(xAxis2).call(plainAxis, 'bottom');

    [50000, 100000, 150000, 200000, 250000, 300000, 350000, 400000].forEach(function(li) {
      calibration_context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(dataRange[0]) + padding.left)
        .attr('y1', yScale2(li) + padding.top)
        .attr('x2', xScale2(dataRange[1]) + padding.left)
        .attr('y2', yScale2(li) + padding.top);
    });
    [50, 100, 150, 200, 250, 300, 350, 400, 450, 500].forEach(function(li) {
      calibration_context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(client.utils.scaleMgdl(li)) + padding.left)
        .attr('y1', padding.top)
        .attr('x2', xScale2(client.utils.scaleMgdl(li)) + padding.left)
        .attr('y2', chartHeight + padding.top);
    });
  }

  function drawcal (cal) {
    if (![cal.scale, cal.intercept, cal.slope].every(Number.isFinite) || cal.slope === 0) return;
    var y1 = 50000;
    var x1 = cal.scale * (y1 - cal.intercept) / cal.slope;
    var y2 = 400000;
    var x2 = cal.scale * (y2 - cal.intercept) / cal.slope;
    calibration_context.append('line').datum(cal).attr('class', 'calibrations-curve ' + cal.colorClass)
      .attr('x1', xScale2(client.utils.scaleMgdl(x1)) + padding.left)
      .attr('y1', yScale2(y1) + padding.top)
      .attr('x2', xScale2(client.utils.scaleMgdl(x2)) + padding.left)
      .attr('y2', yScale2(y2) + padding.top);
  }

  function calcmbg (mbg) {
    var lastsgv = findlatest(new Date(mbg.mills), sgvs);
    mbg.raw = lastsgv && mbg.mills - lastsgv.mills <= 5 * 60 * 1000 ? lastsgv.raw : undefined;
  }

  function drawmbg (mbg) {
    if (mbg.raw) {
      calibration_context.append('circle').datum(mbg).attr('class', 'calibrations-point ' + mbg.colorClass)
        .attr('cx', xScale2(client.utils.scaleMgdl(mbg.y)) + padding.left)
        .attr('cy', yScale2(mbg.raw) + padding.top);
    }
  }

  function findlatest (date, storage) {
    var last = null;
    var time = date.getTime();
    for (var i = 0; i < storage.length; i++) {
      if (storage[i].mills > time) {
        return last;
      }
      last = storage[i];
    }
    return last;
  }
};
