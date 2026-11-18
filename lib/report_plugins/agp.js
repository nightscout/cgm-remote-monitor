'use strict';

const consts = require('../constants');

const agp = {
  name: 'agp'
  , label: 'Statistics Summary'
  , pluginType: 'report'
};

function init () {
  return agp;
}

module.exports = init;

agp.html = function html (client) {
  const translate = client.translate;
  const ret =
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
      '  <div class="agp-card">' +
      '    <div class="agp-card-title">' + translate('Ambulatory Glucose Profile (AGP)') + '</div>' +
      '    <div class="agp-agp-note">' + translate('AGP is a summary of glucose values from the report period, with median (50%) and other percentiles shown as if they occurred in a single day.') + '</div>' +
      '    <div id="agp-chart"></div>' +
      '  </div>' +
      '  <div class="agp-card">' +
      '    <div class="agp-card-title">' + translate('Daily Glucose Profiles') + '</div>' +
      '    <div class="agp-daily-caption" id="agp-daily-caption"></div>' +
      '    <div id="agp-daily" class="agp-daily-grid"></div>' +
      '  </div>' +
      '</div>';
  return ret;
};

agp.report = function report_agp (datastorage, sorteddaystoshow, options) {
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const reportPlugins = Nightscout.report_plugins;
  const ss = require('../report/statistics');
  const d3 = (global && global.d3) || require('../d3.mjs');
  const plainAxis = require('../report/plain-axis');
  const dateFormat = require('../report/date-format');
  const $ = window.$;
  const profile = client.sbx.data.profile;
  const model = require('../report/agp-data');
  const prepared = model.prepare(datastorage.allstatsrecords || [], sorteddaystoshow, profile, window.moment);
  const data = prepared.data;
  const days = prepared.days;

  const displayUnits = options.units || client.settings.units;
  const isMmol = displayUnits === 'mmol';

  function toDisplay (mgdl) {
    return isMmol ? mgdl / consts.MMOL_TO_MGDL : mgdl;
  }
  function fmtDisplay (mgdl) {
    const v = toDisplay(mgdl);
    return isMmol ? v.toFixed(1) : String(Math.round(v));
  }
  function fmtDisplayVal (displayVal) {
    return isMmol ? displayVal.toFixed(1) : String(Math.round(displayVal));
  }

  const countDays = days.length;
  const firstDay = countDays ? reportPlugins.utils.localeDate(days[0]) : '';
  const lastDay = countDays ? reportPlugins.utils.localeDate(days[countDays - 1]) : '';

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
  const pctActive = prepared.pctActive;
  $('#agp-cgmactive').text(translate('% Time CGM Active') + ': ' + pctActive.toFixed(1) + '%');

  // ---- core statistics (mg/dL based, unit-independent) ----
  const bgValues = data.map(function (r) {
    return r.bgValue;
  });
  const meanMgdl = ss.mean(bgValues);
  const sdMgdl = bgValues.length > 1 ? ss.standard_deviation(bgValues) : 0;
  const gmiPct = 3.31 + 0.02392 * meanMgdl;
  const gmiMmolMol = (gmiPct - 2.152) * 10.929;
  const cv = meanMgdl > 0 ? (sdMgdl / meanMgdl) * 100 : 0;

  // ---- SECTION 2: stats cards ----
  const stats = [
    {value: fmtDisplay(meanMgdl), unit: isMmol ? 'mmol/L' : 'mg/dL', label: translate('Average Glucose')}
    , {
      value: gmiPct.toFixed(1),
      unit: '%',
      label: translate('Glucose Management Indicator (GMI)'),
      hint: gmiMmolMol.toFixed(1) + ' mmol/mol'
    }
    , {
      value: cv.toFixed(1),
      unit: '%',
      label: translate('Glucose Variability (CV)'),
      hint: translate('Target') + ': ≤ 36%'
    }
    , {value: fmtDisplay(sdMgdl), unit: isMmol ? 'mmol/L' : 'mg/dL', label: translate('Standard Deviation')}
    , {value: String(countDays), unit: translate('days'), label: translate('Days of data')}
    , {
      value: String(data.length),
      unit: '',
      label: translate('Number of readings'),
      hint: pctActive.toFixed(1) + '% ' + translate('CGM active')
    }
  ];
  stats.forEach(function (s) {
    const cell = $('<div class="agp-stat">');
    let v = '<div class="agp-stat-value">' + s.value + (s.unit ? '<span class="agp-stat-unit">' + s.unit + '</span>' : '') + '</div>';
    v += '<div class="agp-stat-label">' + s.label + '</div>';
    if (s.hint) { v += '<div class="agp-stat-hint">' + s.hint + '</div>'; }
    cell.html(v);
    $('#agp-stats').append(cell);
  });

  // ---- SECTION 3: Time in Ranges (mg/dL classification on bgValue) ----
  const bands = [
    {
      key: 'vhigh', name: translate('Very High'), range: '> ' + fmtDisplay(250), test: function (b) {
        return b > 250;
      }
    }
    , {
      key: 'high', name: translate('High'), range: fmtDisplay(181) + '–' + fmtDisplay(250), test: function (b) {
        return b > 180 && b <= 250;
      }
    }
    , {
      key: 'target',
      name: translate('Target Range'),
      range: fmtDisplay(70) + '–' + fmtDisplay(180),
      target: true,
      test: function (b) {
        return b >= 70 && b <= 180;
      }
    }
    , {
      key: 'low', name: translate('Low'), range: fmtDisplay(54) + '–' + fmtDisplay(69), test: function (b) {
        return b >= 54 && b < 70;
      }
    }
    , {
      key: 'vlow', name: translate('Very Low'), range: '< ' + fmtDisplay(54), test: function (b) {
        return b < 54;
      }
    }
  ];
  bands.forEach(function (band) {
    band.count = 0;
    bgValues.forEach(function (b) { if (band.test(b)) { band.count += 1; } });
    band.pct = (band.count / bgValues.length) * 100;
    // avg minutes per day in this band
    const minutesPerDay = Math.round((band.pct / 100) * 24 * 60);
    band.hh = Math.floor(minutesPerDay / 60);
    band.mm = minutesPerDay % 60;
  });

  let tirHtml = '<div class="agp-tir-bar">';
  bands.forEach(function (band) {
    const h = Math.max(band.pct, 0);
    tirHtml += '<div class="agp-tir-seg agp-band-' + band.key + '" title="' + band.name + ' ' + band.pct.toFixed(1) + '%" style="flex-grow:' + h + '"></div>';
  });
  tirHtml += '</div>';
  tirHtml += '<div class="agp-tir-legend">';
  bands.forEach(function (band) {
    tirHtml += '<div class="agp-tir-row' + (band.target ? ' agp-target' : '') + '">' +
      '<span class="agp-tir-swatch agp-band-' + band.key + '"></span>' +
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

  function drawAGP () {
    const binMinutes = 30;
    const nBins = (24 * 60) / binMinutes; // 96
    const binData = [];
    let b;
    for (b = 0; b < nBins; b++) { binData.push([]); }

    data.forEach(function (r) {
      const idx = Math.floor(r.minute / binMinutes);
      if (idx >= 0 && idx < nBins) { binData[idx].push(r.bgValue); }
    });

    // Keep all bins; undefined values split the percentile lines and areas.
    const series = {p10: [], p25: [], p50: [], p75: [], p90: []};
    for (b = 0; b < nBins; b++) {
      const quantiles = ss.quantile(binData[b], [0.10, 0.25, 0.5, 0.75, 0.90]);
      ['p10', 'p25', 'p50', 'p75', 'p90'].forEach(function(key, index) {
        series[key].push({t: b * binMinutes + binMinutes / 2, v: quantiles ? toDisplay(quantiles[index]) : null});
      });
    }

    const container = document.getElementById('agp-chart');
    let totalWidth = (container && container.clientWidth) ? container.clientWidth : 1000;
    totalWidth = Math.max(240, totalWidth);
    const margin = {top: 12, right: 24, bottom: 28, left: 44};
    const width = totalWidth - margin.left - margin.right;
    const height = 320 - margin.top - margin.bottom;

    // Match this summary's consensus TIR classification, independently of the
    // configurable targets used by the other reports. Convert before plotting.
    const targetLow = toDisplay(70);
    const targetHigh = toDisplay(180);

    // y max: max of p95, targetHigh, ~350 mg/dl equiv
    const p95max = d3.max(series.p90, function (d) {
      return d.v;
    }) || 0;
    let yMaxDisplay = Math.max(p95max, targetHigh, toDisplay(350));
    yMaxDisplay = yMaxDisplay * 1.05;
    const yMinDisplay = 0;

    const x = d3.scaleLinear().domain([0, 1440]).rangeRound([0, width]);
    const y = d3.scaleLinear().domain([yMinDisplay, yMaxDisplay]).rangeRound([height, 0]);

    const svg = d3.select('#agp-chart').append('svg')
        .attr('width', totalWidth)
        .attr('height', 320)
        .attr('viewBox', '0 0 ' + totalWidth + ' 320');
    const g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    // target range green band
    g.append('rect')
      .attr('class', 'percentile-target-band')
      .attr('x', 0)
      .attr('y', y(targetHigh))
      .attr('width', width)
      .attr('height', Math.max(0, y(targetLow) - y(targetHigh)));

    // x axis (every 3h)
    const xTicks = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440];
    const xAxis = d3.axisBottom(x).offset(0)
        .tickValues(xTicks)
        .tickFormat(function (m) {
          const hh = Math.floor(m / 60);
          return (hh < 10 ? '0' + hh : '' + hh) + ':00';
        });
    g.append('g')
      .attr('class', 'agp-axis')
      .attr('transform', 'translate(0,' + height + ')')
      .call(xAxis).call(plainAxis, 'bottom');

    const yAxis = d3.axisLeft(y).offset(0).ticks(6).tickFormat(function (v) {
      return fmtDisplayVal(v);
    });
    g.append('g')
      .attr('class', 'agp-axis')
      .call(yAxis).call(plainAxis, 'left');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -Math.round(height / 2))
      .attr('y', -34)
      .attr('class', 'agp-axis-label')
      .text(isMmol ? 'mmol/L' : 'mg/dL');

    const areaGen = function (lo, hi) {
      return d3.area().digits(0)
          .defined(function (d, i) {
            return lo[i].v !== null && hi[i].v !== null;
          })
          .curve(d3.curveMonotoneX)
          .x(function (d) {
            return x(d.t);
          })
          .y0(function (d, i) {
            return y(lo[i].v);
          })
          .y1(function (d, i) {
            return y(hi[i].v);
          });
    };

    // outer band p10-p90
    g.append('path')
      .attr('class', 'percentile-band-outer')
      .datum(series.p90)
      .attr('d', areaGen(series.p10, series.p90));

    // inner band p25-p75
    g.append('path')
      .attr('class', 'percentile-band-inner')
      .datum(series.p75)
      .attr('d', areaGen(series.p25, series.p75));

    // median line
    const lineGen = d3.line().digits(0)
        .defined(function (d) {
          return d.v !== null;
        })
        .curve(d3.curveMonotoneX)
        .x(function (d) {
          return x(d.t);
        })
        .y(function (d) {
          return y(d.v);
        });
    g.append('path')
      .attr('class', 'agp-median')
      .datum(series.p50)
      .attr('d', lineGen);

    // target reference dashed lines
    g.append('line')
      .attr('class', 'agp-target-line agp-target-low')
      .attr('x1', 0).attr('x2', width)
      .attr('y1', y(targetLow)).attr('y2', y(targetLow));
    g.append('line')
      .attr('class', 'agp-target-line agp-target-high')
      .attr('x1', 0).attr('x2', width)
      .attr('y1', y(targetHigh)).attr('y2', y(targetHigh));
  }

  function drawDailyGrid () {
    const maxDays = 28;
    const totalDays = days.length;
    const daysToShow = days.slice(-maxDays); // most recent days in calendar order
    const byDay = {};
    data.forEach(function(r) {
      if (!byDay[r.day]) byDay[r.day] = [];
      byDay[r.day].push(r);
    });

    if (totalDays > daysToShow.length) {
      $('#agp-daily-caption').text('(' + translate('showing last') + ' ' + daysToShow.length + ' ' + translate('of') + ' ' + totalDays + ' ' + translate('days') + ')');
    }

    const cw = 130;
    const ch = 70;
    const pad = 4;
    const iw = cw - 2 * pad;
    const ih = ch - 2 * pad;

    const targetLow = toDisplay(70);
    const targetHigh = toDisplay(180);
    const yMaxDisplay = Math.max(targetHigh, toDisplay(300), d3.max(data, function (r) {
      return toDisplay(r.bgValue);
    }));
    const yMinDisplay = 0;

    const xs = d3.scaleLinear().domain([0, 1440]).rangeRound([0, iw]);
    const ys = d3.scaleLinear().domain([yMinDisplay, yMaxDisplay]).rangeRound([ih, 0]);

    // Show oldest -> newest, independent of the report sort option.
    daysToShow.forEach(function (dayKey) {
      const cell = $('<div class="agp-daily-cell">');
      const label = dateFormat(client).shortDate(profile.parseInTimezone(dayKey));
      cell.append($('<div class="agp-daily-label">').text(label));
      const holder = $('<div class="agp-daily-svg">');
      cell.append(holder);
      $('#agp-daily').append(cell);

      const pts = model.dailyPoints(byDay[dayKey] || [], toDisplay);

      const svg = d3.select(holder.get(0)).append('svg')
          .attr('width', '100%').attr('viewBox', '0 0 ' + cw + ' ' + ch);
      const gg = svg.append('g').attr('transform', 'translate(' + pad + ',' + pad + ')');

      // target band
      gg.append('rect')
        .attr('class', 'percentile-target-band')
        .attr('x', 0).attr('y', ys(targetHigh))
        .attr('width', iw)
        .attr('height', Math.max(0, ys(targetLow) - ys(targetHigh)));

      if (pts.length > 0) {
        const lg = d3.line().digits(0)
            .defined(function (d) {
              return d.v !== null;
            })
            .x(function (d) {
              return xs(d.t);
            })
            .y(function (d) {
              return ys(d.v);
            });
        gg.append('path')
          .attr('class', 'agp-daily-line')
          .datum(pts)
          .attr('d', lg);
        gg.selectAll('circle').data(pts.filter(function(point) { return point.v !== null; }))
          .enter().append('circle').attr('class', 'agp-daily-point').attr('cx', function(d) { return xs(d.t); })
          .attr('cy', function(d) { return ys(d.v); });
      }
    });
  }
};
