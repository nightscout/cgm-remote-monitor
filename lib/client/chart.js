'use strict';

function init (client) {
  var chart = { };

  var utils = client.utils;
  var renderer = client.renderer;

  function brushStarted() {
    // update the opacity of the context data points to brush extent
    client.context.selectAll('circle')
      .data(client.data)
      .style('opacity', 1);
  }

  function brushEnded() {
    // update the opacity of the context data points to brush extent
    client.context.selectAll('circle')
      .data(client.data)
      .style('opacity', function (d) { return renderer.highlightBrushPoints(d) });
  }

  // define the parts of the axis that aren't dependent on width or height
  var xScale = chart.xScale = d3.time.scale()
    .domain(d3.extent(client.data, client.dateFn));

  var yScale = chart.yScale = d3.scale.log()
    .domain([utils.scaleMgdl(30), utils.scaleMgdl(510)]);

  var xScale2 = chart.xScale2 = d3.time.scale()
    .domain(d3.extent(client.data, client.dateFn));

  var yScale2 = chart.yScale2 = d3.scale.log()
    .domain([utils.scaleMgdl(36), utils.scaleMgdl(420)]);

  var tickFormat = d3.time.format.multi(  [
    ['.%L', function(d) { return d.getMilliseconds(); }],
    [':%S', function(d) { return d.getSeconds(); }],
    ['%I:%M', function(d) { return d.getMinutes(); }],
    [client.settings.timeFormat === 24 ? '%H:%M' : '%-I %p', function(d) { return d.getHours(); }],
    ['%a %d', function(d) { return d.getDay() && d.getDate() !== 1; }],
    ['%b %d', function(d) { return d.getDate() !== 1; }],
    ['%B', function(d) { return d.getMonth(); }],
    ['%Y', function() { return true; }]
  ]);

  // Tick Values
  var tickValues;
  if (client.settings.units === 'mmol') {
    tickValues = [
      2.0
      , Math.round(utils.scaleMgdl(client.settings.thresholds.bgLow))
      , Math.round(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom))
      , 6.0
      , Math.round(utils.scaleMgdl(client.settings.thresholds.bgTargetTop))
      , Math.round(utils.scaleMgdl(client.settings.thresholds.bgHigh))
      , 22.0
    ];
  } else {
    tickValues = [
      40
      , client.settings.thresholds.bgLow
      , client.settings.thresholds.bgTargetBottom
      , 120
      , client.settings.thresholds.bgTargetTop
      , client.settings.thresholds.bgHigh
      , 400
    ];
  }


  chart.xAxis = d3.svg.axis()
    .scale(xScale)
    .tickFormat(tickFormat)
    .ticks(4)
    .orient('bottom');

  chart.yAxis = d3.svg.axis()
    .scale(yScale)
    .tickFormat(d3.format('d'))
    .tickValues(tickValues)
    .orient('left');

  chart.xAxis2 = d3.svg.axis()
    .scale(xScale2)
    .tickFormat(tickFormat)
    .ticks(6)
    .orient('bottom');

  chart.yAxis2 = d3.svg.axis()
    .scale(yScale2)
    .tickFormat(d3.format('d'))
    .tickValues(tickValues)
    .orient('right');

  // setup a brush
  chart.brush = d3.svg.brush()
    .x(xScale2)
    .on('brushstart', brushStarted)
    .on('brush', client.brushed)
    .on('brushend', brushEnded);


  return chart;
}

module.exports = init;