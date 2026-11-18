'use strict';

const percentile = {
  name: 'percentile'
  , label: 'Percentile Chart'
  , pluginType: 'report'
};

// Catmull-Rom spline based smoothing used to render the percentile
// curves without sharp angles between the half-hourly data points.
// The original data points are kept exactly, extra points are
// interpolated in between to produce a smooth curve.
function smoothData (points) {
  const SEGMENTS = 4;
  const out = [];

  function get (index) {
    index = Math.max(0, Math.min(points.length - 1, index));
    return points[index][1];
  }

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const t0 = points[i][0].getTime();
    const t1 = points[i + 1][0].getTime();

    out.push([points[i][0], p1]);

    for (let s = 1; s < SEGMENTS; s++) {
      const t = s / SEGMENTS;
      const t2 = t * t;
      const t3 = t2 * t;
      const value = 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
      out.push([new Date(t0 + (t1 - t0) * t), value]);
    }
  }

  out.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return out;
}

function init () {
  return percentile;
}

module.exports = init;

percentile.html = function html (client) {
  const translate = client.translate;

  return `<h2>${translate('Glucose Percentile report')} (<span id="percentile-days"></span>)</h2>
<div class="percentile-chart-container">
  <div class="chart" id="percentile-chart"></div>
</div>`;
};

percentile.css =
  '#percentile-chart {' +
  '  box-sizing: border-box;' +
  '  width: 100%;' +
  '  height: 100%;' +
  '}' +
  '#percentile-chart svg {' +
  '  width: 100%;' +
  '  height: 100%;' +
  '}';

percentile.report = function report_percentile (datastorage, sorteddaystoshow, options) {
  $('#percentile-chart').empty();

  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const moment = window.moment;
  const profile = client.sbx.data.profile;
  const ss = require('simple-statistics');

  const minutewindow = 30; //minute-window should be a divisor of 60

  const data = datastorage.allstatsrecords || [];
  if (data.length === 0) {
    return;
  }

  const bins = [];

  const reportPlugins = Nightscout.report_plugins;
  const firstDay = reportPlugins.utils.localeDate(sorteddaystoshow[sorteddaystoshow.length - 1]);
  const lastDay = reportPlugins.utils.localeDate(sorteddaystoshow[0]);
  const countDays = sorteddaystoshow.length;

  $('#percentile-days').text(countDays + ' ' + translate('days total') + ', ' + firstDay + ' - ' + lastDay);

  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute = minute + minutewindow) {
      const date = new Date();
      date.setHours(hour);
      date.setMinutes(minute);
      let readings = data.filter(function withinWindow (record) {
        const recdate = profile.applyTimezone(moment(record.displayTime));
        return recdate.hour() === hour && recdate.minute() >= minute && recdate.minute() < minute + minutewindow;
      });
      readings = readings.map(function(record) {
        return record.sgv;
      });
      bins.push([date, readings]);
      //console.log(date +  " - " + readings.length);
      //readings.forEach(function(x){console.log(x)});
    }
  }
  let dat10 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.1)];
  });
  let dat25 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.25)];
  });
  let dat50 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.5)];
  });
  let dat75 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.75)];
  });
  let dat90 = bins.map(function(bin) {
    return [bin[0], ss.quantile(bin[1], 0.9)];
  });
  const high = options.targetHigh;
  const low = options.targetLow;

  dat10 = smoothData(dat10);
  dat25 = smoothData(dat25);
  dat50 = smoothData(dat50);
  dat75 = smoothData(dat75);
  dat90 = smoothData(dat90);

  const d3 = window.d3;

  const container = document.getElementById('percentile-chart');
  const width = container ? container.clientWidth : 800;
  const height = container ? container.clientHeight : 500;

  const margin = { top: 36, right: 20, bottom: 40, left: 60 };
  const innerWidth = Math.max(100, width - margin.left - margin.right);
  const innerHeight = Math.max(100, height - margin.top - margin.bottom);

  const xScale = d3.scaleTime()
    .domain([dat50[0][0], dat50[dat50.length - 1][0]])
    .range([0, innerWidth]);
  const yScale = d3.scaleLinear()
    .domain([0, options.units === 'mmol' ? 22 : 400])
    .range([innerHeight, 0]);

  const xAxis = d3.axisBottom(xScale)
    .ticks(d3.timeHour.every(2))
    .tickFormat(d3.timeFormat('%H:%M'));
  const yAxis = d3.axisLeft(yScale).ticks(8);

  const lineGen = d3.line()
    .x(function(d) {
      return xScale(d[0]);
    })
    .y(function(d) {
      return yScale(d[1]);
    })
    .curve(d3.curveCatmullRom);

  const band20 = d3.area()
    .x(function(d) {
      return xScale(d.x);
    })
    .y0(function(d) {
      return yScale(d.y0);
    })
    .y1(function(d) {
      return yScale(d.y1);
    })
    .curve(d3.curveCatmullRom);

  const band50Data = dat25.map(function(d, i) {
    return { x: d[0], y0: d[1], y1: dat75[i] ? dat75[i][1] : d[1] };
  });
  const band80Data = dat10.map(function(d, i) {
    return { x: d[0], y0: d[1], y1: dat90[i] ? dat90[i][1] : d[1] };
  });

  const svg = d3.select('#percentile-chart')
    .append('svg')
    .attr('viewBox', '0 0 ' + width + ' ' + height)
    .attr('preserveAspectRatio', 'xMidYMid meet');

  const defs = svg.append('defs');
  defs.append('clipPath')
    .attr('id', 'percentile-in-range-clip')
    .attr('clipPathUnits', 'userSpaceOnUse')
    .append('rect')
    .attr('x', 0)
    .attr('y', yScale(high))
    .attr('width', innerWidth)
    .attr('height', yScale(low) - yScale(high));

  defs.append('clipPath')
    .attr('id', 'percentile-above-range-clip')
    .attr('clipPathUnits', 'userSpaceOnUse');
  defs.select('#percentile-above-range-clip').append('rect')
    .attr('x', 0)
    .attr('y', 0)
    .attr('width', innerWidth)
    .attr('height', yScale(high));

  defs.append('clipPath')
    .attr('id', 'percentile-below-range-clip')
    .attr('clipPathUnits', 'userSpaceOnUse')
    .append('rect')
    .attr('x', 0)
    .attr('y', yScale(low))
    .attr('width', innerWidth)
    .attr('height', innerHeight - yScale(low));

  const chart = svg.append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // gridlines (drawn first, behind everything else)
  const grid = chart.append('g')
    .attr('class', 'p-grid');

  grid.selectAll('line.grid-y')
    .data(yScale.ticks(8))
    .enter()
    .append('line')
    .attr('class', 'grid-y')
    .attr('x1', 0)
    .attr('x2', innerWidth)
    .attr('y1', function(d) { return yScale(d); })
    .attr('y2', function(d) { return yScale(d); });

  grid.selectAll('line.grid-x')
    .data(xScale.ticks(d3.timeHour.every(2)))
    .enter()
    .append('line')
    .attr('class', 'grid-x')
    .attr('x1', function(d) { return xScale(d); })
    .attr('x2', function(d) { return xScale(d); })
    .attr('y1', 0)
    .attr('y2', innerHeight);

  // Each percentile band is clipped once to the target range and once to
  // each side of it, allowing all three regions to be themed independently.
  [
    { data: band80Data, cls: 'p-band p-band-80 p-band-below', clip: 'percentile-below-range-clip' }
    , { data: band80Data, cls: 'p-band p-band-80 p-band-in-range', clip: 'percentile-in-range-clip' }
    , { data: band80Data, cls: 'p-band p-band-80 p-band-above', clip: 'percentile-above-range-clip' }
    , { data: band50Data, cls: 'p-band p-band-50 p-band-below', clip: 'percentile-below-range-clip' }
    , { data: band50Data, cls: 'p-band p-band-50 p-band-in-range', clip: 'percentile-in-range-clip' }
    , { data: band50Data, cls: 'p-band p-band-50 p-band-above', clip: 'percentile-above-range-clip' }
  ].forEach(function drawBand (band) {
    chart.append('path')
      .datum(band.data)
      .attr('class', band.cls)
      .attr('clip-path', 'url(#' + band.clip + ')')
      .attr('d', band20);
  });

  // median line on top
  chart.append('path')
    .datum(dat50)
    .attr('class', 'p-line p-median')
    .attr('d', lineGen);

  // threshold lines (low/high)
  const thresholdData = [low, high].map(function(value) {
    return {
      value: value
      , y: yScale(value)
    };
  });
  chart.selectAll('line.p-threshold')
    .data(thresholdData)
    .enter()
    .append('line')
    .attr('class', 'p-threshold')
    .attr('x1', 0)
    .attr('x2', innerWidth)
    .attr('y1', function(d) { return d.y; })
    .attr('y2', function(d) { return d.y; });

  // axes
  chart.append('g')
    .attr('class', 'x axis')
    .attr('transform', 'translate(0,' + innerHeight + ')')
    .call(xAxis);
  chart.append('g')
    .attr('class', 'y axis')
    .call(yAxis);

  // legend
  const legend = svg.append('g')
    .attr('class', 'legend')
    .attr('transform', 'translate(' + (margin.left) + ',' + 14 + ')');
  const legendItems = [
    { cls: 'p-median swatch', label: translate('Median') }
    , { band: 'p-band-50', label: '25%/75% ' + translate('percentile') }
    , { band: 'p-band-80', label: '10%/90% ' + translate('percentile') }
  ];
  legendItems.forEach(function(item, i) {
    const g = legend.append('g')
      .attr('transform', 'translate(' + (i * 170) + ',0)');
    if (item.band) {
      ['p-band-below', 'p-band-in-range', 'p-band-above'].forEach(function(region, regionIndex) {
        g.append('rect')
          .attr('class', item.band + ' ' + region + ' swatch')
          .attr('x', regionIndex * 4)
          .attr('y', 0)
          .attr('width', 4)
          .attr('height', 6);
      });
    } else {
      g.append('rect')
        .attr('class', item.cls)
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', 12)
        .attr('height', 3);
    }
    g.append('text')
      .attr('x', 18)
      .attr('y', 4)
      .attr('class', 'legendLabel')
      .text(item.label);
  });
};
