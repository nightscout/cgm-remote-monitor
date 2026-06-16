'use strict';

var consts = require('../constants');

var agp = {
  name: 'agp'
  , label: 'Statistics Summary'
  , pluginType: 'report'
};

function init () {
  return agp;
}

module.exports = init;

agp.html = function html (client) {
  var translate = client.translate;
  var ret =
    '<div class="agp-wrap">' +
    '  <div class="agp-header">' +
    '    <h2 class="agp-h2">' + translate('Statistics Summary') + '</h2>' +
    '    <div class="agp-subhead" id="agp-days"></div>' +
    '    <div class="agp-cgmactive" id="agp-cgmactive"></div>' +
    '  </div>' +
    '  <div class="agp-top">' +
    '    <div class="agp-card agp-stats-card">' +
    '      <div class="agp-card-title">' + translate('Glucose Statistics') + '</div>' +
    '      <div class="agp-stats-grid" id="agp-stats"></div>' +
    '    </div>' +
    '    <div class="agp-card agp-tir-card">' +
    '      <div class="agp-card-title">' + translate('Time in Ranges') + '</div>' +
    '      <div class="agp-tir" id="agp-tir"></div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="agp-card agp-agp-card">' +
    '    <div class="agp-card-title">' + translate('Ambulatory Glucose Profile (AGP)') + '</div>' +
    '    <div class="agp-agp-note">' + translate('AGP is a summary of glucose values from the report period, with median (50%) and other percentiles shown as if they occurred in a single day.') + '</div>' +
    '    <div id="agp-chart"></div>' +
    '  </div>' +
    '  <div class="agp-card agp-daily-card">' +
    '    <div class="agp-card-title">' + translate('Daily Glucose Profiles') + '</div>' +
    '    <div class="agp-daily-caption" id="agp-daily-caption"></div>' +
    '    <div id="agp-daily" class="agp-daily-grid"></div>' +
    '  </div>' +
    '</div>';
  return ret;
};

agp.css =
    '.agp-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#222;max-width:1100px;}' +
  '.agp-wrap *{box-sizing:border-box;}' +
  '.agp-h2{margin:0 0 4px 0;font-size:22px;font-weight:700;}' +
  '.agp-subhead{font-size:14px;color:#444;font-weight:600;}' +
  '.agp-cgmactive{font-size:13px;color:#666;margin-bottom:10px;}' +
  '.agp-card{background:#fff;border:1px solid #e2e2e2;border-radius:12px;padding:16px;margin-bottom:16px;}' +
  '.agp-card-title{font-size:15px;font-weight:700;margin-bottom:12px;color:#333;}' +
  '.agp-top{display:flex;flex-wrap:wrap;gap:16px;align-items:stretch;}' +
  '.agp-stats-card{flex:1 1 340px;margin-bottom:0;}' +
  '.agp-tir-card{flex:1 1 320px;margin-bottom:0;}' +
  '.agp-top{margin-bottom:16px;}' +
  '.agp-stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}' +
  '.agp-stat{padding:8px 4px;}' +
  '.agp-stat-value{font-size:24px;font-weight:700;line-height:1.1;color:#111;}' +
  '.agp-stat-unit{font-size:13px;font-weight:600;color:#666;margin-left:3px;}' +
  '.agp-stat-label{font-size:12px;color:#666;margin-top:2px;}' +
  '.agp-stat-hint{font-size:11px;color:#888;margin-top:1px;}' +
  '.agp-tir{display:flex;gap:14px;align-items:stretch;}' +
  '.agp-tir-bar{width:46px;min-width:46px;display:flex;flex-direction:column;border-radius:6px;overflow:hidden;height:300px;border:1px solid #ddd;}' +
  '.agp-tir-seg{width:100%;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
  '.agp-tir-legend{display:flex;flex-direction:column;justify-content:space-between;flex:1;}' +
  '.agp-tir-row{display:flex;align-items:baseline;gap:6px;padding:2px 0;}' +
  '.agp-tir-swatch{width:12px;height:12px;border-radius:3px;display:inline-block;flex:0 0 auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
  '.agp-tir-name{font-weight:700;font-size:13px;}' +
  '.agp-tir-range{font-size:12px;color:#666;}' +
  '.agp-tir-pct{font-weight:700;font-size:14px;margin-left:auto;}' +
  '.agp-tir-time{font-size:11px;color:#888;width:100%;margin-left:18px;}' +
  '.agp-tir-row.agp-target .agp-tir-name{color:#2e7d32;}' +
  '#agp-chart svg, #agp-daily svg{display:block;}' +
  '.agp-agp-note,.agp-daily-caption{font-size:12px;color:#777;margin-bottom:10px;}' +
  '.agp-daily-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;}' +
  '@media (max-width:900px){.agp-daily-grid{grid-template-columns:repeat(4,1fr);}}' +
  '.agp-daily-cell{border:1px solid #eee;border-radius:8px;padding:4px;text-align:center;}' +
  '.agp-daily-label{font-size:11px;color:#555;margin-bottom:2px;font-weight:600;}' +
  '.agp-empty{color:#999;font-style:italic;}'
  ;

agp.report = function report_agp (datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var reportPlugins = Nightscout.report_plugins;
  var ss = require('simple-statistics');
  var d3 = (global && global.d3) || require('d3');
  var $ = window.$;

  var displayUnits = options.units || client.settings.units;
  var isMmol = displayUnits === 'mmol';

  function toDisplay (mgdl) {
    return isMmol ? mgdl / consts.MMOL_TO_MGDL : mgdl;
  }
  function fmtDisplay (mgdl) {
    var v = toDisplay(mgdl);
    return isMmol ? v.toFixed(1) : String(Math.round(v));
  }
  function fmtDisplayVal (displayVal) {
    return isMmol ? displayVal.toFixed(1) : String(Math.round(displayVal));
  }

  // ---- gather + clean data (dedupe by displayTime, valid glucose only) ----
  var raw = datastorage.allstatsrecords || [];
  var seen = {};
  var data = raw.filter(function (item) {
    if (!item || !item.displayTime || typeof item.bgValue !== 'number') { return false; }
    if (item.bgValue < 39 || item.bgValue > 600) { return false; }
    var key = item.displayTime instanceof Date ? item.displayTime.getTime() : new Date(item.displayTime).getTime();
    if (seen[key]) { return false; }
    seen[key] = true;
    return true;
  });

  var countDays = sorteddaystoshow.length;
  var firstDay = countDays ? reportPlugins.utils.localeDate(sorteddaystoshow[sorteddaystoshow.length - 1]) : '';
  var lastDay = countDays ? reportPlugins.utils.localeDate(sorteddaystoshow[0]) : '';

  $('#agp-stats').empty();
  $('#agp-tir').empty();
  $('#agp-chart').empty();
  $('#agp-daily').empty();
  $('#agp-daily-caption').empty();
  $('#agp-cgmactive').empty();

  if (data.length === 0) {
    $('#agp-days').text(translate('Result is empty'));
    return;
  }

  $('#agp-days').text(countDays + ' ' + translate('days') + ', ' + firstDay + ' – ' + lastDay);

  // ---- % time CGM active ----
  var expectedReadings = countDays * 288;
  var pctActive = expectedReadings > 0 ? Math.min(100, (data.length / expectedReadings) * 100) : 0;
  $('#agp-cgmactive').text(translate('% Time CGM Active') + ': ' + pctActive.toFixed(1) + '%');

  // ---- core statistics (mg/dL based, unit-independent) ----
  var bgValues = data.map(function (r) { return r.bgValue; });
  var meanMgdl = ss.mean(bgValues);
  var sdMgdl = bgValues.length > 1 ? ss.standard_deviation(bgValues) : 0;
  var gmiPct = 3.31 + 0.02392 * meanMgdl;
  var gmiMmolMol = (gmiPct - 2.152) * 10.929;
  var cv = meanMgdl > 0 ? (sdMgdl / meanMgdl) * 100 : 0;

  // ---- SECTION 2: stats cards ----
  var stats = [
    { value: fmtDisplay(meanMgdl), unit: isMmol ? 'mmol/L' : 'mg/dL', label: translate('Average Glucose') }
    , { value: gmiPct.toFixed(1), unit: '%', label: translate('Glucose Management Indicator (GMI)'), hint: gmiMmolMol.toFixed(1) + ' mmol/mol' }
    , { value: cv.toFixed(1), unit: '%', label: translate('Glucose Variability (CV)'), hint: translate('Target') + ': ≤ 36%' }
    , { value: fmtDisplay(sdMgdl), unit: isMmol ? 'mmol/L' : 'mg/dL', label: translate('Standard Deviation') }
    , { value: String(countDays), unit: translate('days'), label: translate('Days of data') }
    , { value: String(data.length), unit: '', label: translate('Number of readings'), hint: pctActive.toFixed(1) + '% ' + translate('CGM active') }
  ];
  stats.forEach(function (s) {
    var cell = $('<div class="agp-stat">');
    var v = '<div class="agp-stat-value">' + s.value + (s.unit ? '<span class="agp-stat-unit">' + s.unit + '</span>' : '') + '</div>';
    v += '<div class="agp-stat-label">' + s.label + '</div>';
    if (s.hint) { v += '<div class="agp-stat-hint">' + s.hint + '</div>'; }
    cell.html(v);
    $('#agp-stats').append(cell);
  });

  // ---- SECTION 3: Time in Ranges (mg/dL classification on bgValue) ----
  var bands = [
    { key: 'vhigh', name: translate('Very High'), range: '> ' + fmtDisplay(250), color: '#ffb74d', test: function (b) { return b > 250; } }
    , { key: 'high', name: translate('High'), range: fmtDisplay(181) + '–' + fmtDisplay(250), color: '#ffe358', test: function (b) { return b > 180 && b <= 250; } }
    , { key: 'target', name: translate('Target Range'), range: fmtDisplay(70) + '–' + fmtDisplay(180), color: '#4caf50', target: true, test: function (b) { return b >= 70 && b <= 180; } }
    , { key: 'low', name: translate('Low'), range: fmtDisplay(54) + '–' + fmtDisplay(69), color: '#ff5959', test: function (b) { return b >= 54 && b < 70; } }
    , { key: 'vlow', name: translate('Very Low'), range: '< ' + fmtDisplay(54), color: '#b71c1c', test: function (b) { return b < 54; } }
  ];
  bands.forEach(function (band) {
    band.count = 0;
    bgValues.forEach(function (b) { if (band.test(b)) { band.count += 1; } });
    band.pct = (band.count / bgValues.length) * 100;
    // avg minutes per day in this band
    var minutesPerDay = (band.pct / 100) * 24 * 60;
    band.hh = Math.floor(minutesPerDay / 60);
    band.mm = Math.round(minutesPerDay % 60);
  });

  var tirHtml = '<div class="agp-tir-bar">';
  bands.forEach(function (band) {
    var h = Math.max(band.pct, 0);
    var emphasis = band.target ? 'box-shadow:inset 0 0 0 2px #2e7d32;' : '';
    tirHtml += '<div class="agp-tir-seg" title="' + band.name + ' ' + band.pct.toFixed(1) + '%" style="flex:' + h + ' 1 0;background:' + band.color + ';' + emphasis + '"></div>';
  });
  tirHtml += '</div>';
  tirHtml += '<div class="agp-tir-legend">';
  bands.forEach(function (band) {
    tirHtml += '<div class="agp-tir-row' + (band.target ? ' agp-target' : '') + '">' +
      '<span class="agp-tir-swatch" style="background:' + band.color + '"></span>' +
      '<span class="agp-tir-name">' + band.name + '</span>' +
      '<span class="agp-tir-range">' + band.range + '</span>' +
      '<span class="agp-tir-pct">' + band.pct.toFixed(1) + '%</span>' +
      '<span class="agp-tir-time">' + band.hh + translate('h') + ' ' + band.mm + translate('min') + '/' + translate('day') + ' ' + translate('avg') + '</span>' +
      '</div>';
  });
  tirHtml += '</div>';
  $('#agp-tir').html(tirHtml);

  // ---- SECTION 4: Ambulatory Glucose Profile ----
  drawAGP();

  // ---- SECTION 5: Daily profiles grid ----
  drawDailyGrid();

  function quantileSafe (arr, p) {
    if (!arr || arr.length === 0) { return null; }
    return ss.quantile(arr, p);
  }

  function drawAGP () {
    var binMinutes = 15;
    var nBins = (24 * 60) / binMinutes; // 96
    var binData = [];
    var b;
    for (b = 0; b < nBins; b++) { binData.push([]); }

    data.forEach(function (r) {
      var d = r.displayTime instanceof Date ? r.displayTime : new Date(r.displayTime);
      var minuteOfDay = d.getHours() * 60 + d.getMinutes();
      var idx = Math.floor(minuteOfDay / binMinutes);
      if (idx >= 0 && idx < nBins) { binData[idx].push(r.bgValue); }
    });

    // build percentile series; drop bins with no readings so lines don't break to 0
    var series = { p5: [], p25: [], p50: [], p75: [], p95: [] };
    for (b = 0; b < nBins; b++) {
      var vals = binData[b];
      if (vals.length < 1) { continue; }
      vals = vals.slice().sort(function (x, y) { return x - y; });
      var center = b * binMinutes + binMinutes / 2;
      series.p5.push({ t: center, v: toDisplay(quantileSafe(vals, 0.05)) });
      series.p25.push({ t: center, v: toDisplay(quantileSafe(vals, 0.25)) });
      series.p50.push({ t: center, v: toDisplay(quantileSafe(vals, 0.50)) });
      series.p75.push({ t: center, v: toDisplay(quantileSafe(vals, 0.75)) });
      series.p95.push({ t: center, v: toDisplay(quantileSafe(vals, 0.95)) });
    }

    if (series.p50.length === 0) {
      $('#agp-chart').html('<div class="agp-empty">' + translate('Result is empty') + '</div>');
      return;
    }

    var container = document.getElementById('agp-chart');
    var totalWidth = (container && container.clientWidth) ? container.clientWidth : 1000;
    if (totalWidth < 400) { totalWidth = 1000; }
    var margin = { top: 12, right: 24, bottom: 28, left: 44 };
    var width = totalWidth - margin.left - margin.right;
    var height = 320 - margin.top - margin.bottom;

    // Defensive defaults: if the report is ever invoked without targets set,
    // fall back to the consensus 70/180 so the y-domain and target band can't
    // become NaN and blank the chart.
    var targetLow = options.targetLow || toDisplay(70);   // display units
    var targetHigh = options.targetHigh || toDisplay(180);  // display units

    // y max: max of p95, targetHigh, ~350 mg/dl equiv
    var p95max = d3.max(series.p95, function (d) { return d.v; }) || 0;
    var yMaxDisplay = Math.max(p95max, targetHigh, toDisplay(350));
    yMaxDisplay = yMaxDisplay * 1.05;
    var yMinDisplay = toDisplay(40);

    var x = d3.scaleLinear().domain([0, 1440]).range([0, width]);
    var y = d3.scaleLinear().domain([yMinDisplay, yMaxDisplay]).range([height, 0]);

    var svg = d3.select('#agp-chart').append('svg')
      .attr('width', totalWidth)
      .attr('height', 320);
    var g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    // target range green band
    g.append('rect')
      .attr('x', 0)
      .attr('y', y(targetHigh))
      .attr('width', width)
      .attr('height', Math.max(0, y(targetLow) - y(targetHigh)))
      .attr('fill', '#4caf50')
      .attr('fill-opacity', 0.12)
      .style('print-color-adjust', 'exact');

    // x axis (every 3h)
    var xTicks = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440];
    var xAxis = d3.axisBottom(x)
      .tickValues(xTicks)
      .tickFormat(function (m) {
        var hh = Math.floor(m / 60);
        return (hh < 10 ? '0' + hh : '' + hh) + ':00';
      });
    g.append('g')
      .attr('transform', 'translate(0,' + height + ')')
      .call(xAxis)
      .selectAll('text').style('font-size', '11px').style('fill', '#555');

    var yAxis = d3.axisLeft(y).ticks(6).tickFormat(function (v) { return fmtDisplayVal(v); });
    g.append('g')
      .call(yAxis)
      .selectAll('text').style('font-size', '11px').style('fill', '#555');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -34)
      .attr('text-anchor', 'middle')
      .style('font-size', '11px').style('fill', '#777')
      .text(isMmol ? 'mmol/L' : 'mg/dL');

    var areaGen = function (lo, hi) {
      return d3.area()
        .curve(d3.curveMonotoneX)
        .x(function (d) { return x(d.t); })
        .y0(function (d, i) { return y(lo[i].v); })
        .y1(function (d, i) { return y(hi[i].v); });
    };

    // outer band p5-p95
    g.append('path')
      .datum(series.p95)
      .attr('fill', 'rgba(86,170,236,0.25)')
      .attr('d', areaGen(series.p5, series.p95))
      .style('print-color-adjust', 'exact');

    // inner band p25-p75
    g.append('path')
      .datum(series.p75)
      .attr('fill', 'rgba(86,170,236,0.45)')
      .attr('d', areaGen(series.p25, series.p75))
      .style('print-color-adjust', 'exact');

    // median line
    var lineGen = d3.line()
      .curve(d3.curveCatmullRom)
      .x(function (d) { return x(d.t); })
      .y(function (d) { return y(d.v); });
    g.append('path')
      .datum(series.p50)
      .attr('fill', 'none')
      .attr('stroke', '#1f6fc4')
      .attr('stroke-width', 2.5)
      .attr('d', lineGen);

    // target reference dashed lines
    g.append('line')
      .attr('x1', 0).attr('x2', width)
      .attr('y1', y(targetLow)).attr('y2', y(targetLow))
      .attr('stroke', '#ff5959').attr('stroke-width', 1).attr('stroke-dasharray', '4,3');
    g.append('line')
      .attr('x1', 0).attr('x2', width)
      .attr('y1', y(targetHigh)).attr('y2', y(targetHigh))
      .attr('stroke', '#ffa000').attr('stroke-width', 1).attr('stroke-dasharray', '4,3');
  }

  function drawDailyGrid () {
    var maxDays = 28;
    var totalDays = sorteddaystoshow.length;
    var daysToShow = sorteddaystoshow.slice(0, maxDays); // newest first
    // group readings by day key (local date string YYYY-MM-DD)
    var byDay = {};
    data.forEach(function (r) {
      var d = r.displayTime instanceof Date ? r.displayTime : new Date(r.displayTime);
      var key = d.getFullYear() + '-' +
        ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
        ('0' + d.getDate()).slice(-2);
      if (!byDay[key]) { byDay[key] = []; }
      byDay[key].push({ t: d.getHours() * 60 + d.getMinutes(), v: toDisplay(r.bgValue) });
    });

    if (totalDays > daysToShow.length) {
      $('#agp-daily-caption').text('(' + translate('showing last') + ' ' + daysToShow.length + ' ' + translate('of') + ' ' + totalDays + ' ' + translate('days') + ')');
    }

    var cw = 130;
    var ch = 70;
    var pad = 4;
    var iw = cw - 2 * pad;
    var ih = ch - 2 * pad;

    var targetLow = options.targetLow || toDisplay(70);
    var targetHigh = options.targetHigh || toDisplay(180);
    var yMaxDisplay = Math.max(targetHigh, toDisplay(300));
    var yMinDisplay = toDisplay(40);

    var xs = d3.scaleLinear().domain([0, 1440]).range([0, iw]);
    var ys = d3.scaleLinear().domain([yMinDisplay, yMaxDisplay]).range([ih, 0]);

    // show oldest -> newest left to right for readability
    daysToShow.slice().reverse().forEach(function (dayKey) {
      var cell = $('<div class="agp-daily-cell">');
      var label = reportPlugins.utils.localeDate(dayKey);
      cell.append('<div class="agp-daily-label">' + label + '</div>');
      var holder = $('<div class="agp-daily-svg">');
      cell.append(holder);
      $('#agp-daily').append(cell);

      var pts = (byDay[dayKey] || []).slice().sort(function (a, b) { return a.t - b.t; });

      var svg = d3.select(holder.get(0)).append('svg')
        .attr('width', cw).attr('height', ch);
      var gg = svg.append('g').attr('transform', 'translate(' + pad + ',' + pad + ')');

      // target band
      gg.append('rect')
        .attr('x', 0).attr('y', ys(targetHigh))
        .attr('width', iw)
        .attr('height', Math.max(0, ys(targetLow) - ys(targetHigh)))
        .attr('fill', '#4caf50').attr('fill-opacity', 0.15)
        .style('print-color-adjust', 'exact');

      if (pts.length > 0) {
        var lg = d3.line()
          .x(function (d) { return xs(d.t); })
          .y(function (d) { return ys(Math.min(Math.max(d.v, yMinDisplay), yMaxDisplay)); });
        gg.append('path')
          .datum(pts)
          .attr('fill', 'none')
          .attr('stroke', '#1f6fc4')
          .attr('stroke-width', 1)
          .attr('d', lg);
      }
    });
  }
};
