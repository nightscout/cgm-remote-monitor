'use strict';

// var _ = require('lodash');
var times = require('../times');
var d3locales = require('./d3locales');
var padding = { bottom: 30 };

function init (client, d3, $) {
  var chart = { };

  var utils = client.utils;
  var renderer = client.renderer;

  var defs = d3.select('body').append('svg').append('defs');

  // add defs for combo boluses
  var dashWidth = 5;
  defs.append('pattern')
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
 
  // arrow head
  defs.append('marker')
    .attr({
      'id': 'arrow',
      'viewBox': '0 -5 10 10',
      'refX': 5,
      'refY': 0,
      'markerWidth': 8,
      'markerHeight': 8,
      'orient': 'auto'
    })
    .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('class', 'arrowHead');

  var localeFormatter = d3.locale(d3locales.locale(client.settings.language));
  
  function brushStarted ( ) {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
      .data(client.entries)
      .style('opacity', 1);
  }

  function brushEnded ( ) {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
      .data(client.entries)
      .style('opacity', function (d) { return renderer.highlightBrushPoints(d) });
  }

  var extent = client.dataExtent();

  var yScaleType;
  if (client.settings.scaleY === 'linear') {
    yScaleType = d3.scale.linear;
  } else {
    yScaleType = d3.scale.log;
  }

  var focusYDomain = [utils.scaleMgdl(30), utils.scaleMgdl(510)];
  var contextYDomain = [utils.scaleMgdl(36), utils.scaleMgdl(420)];

  function dynamicDomain() {
    var mult = 1.3
      , targetTop = client.settings.thresholds.bgTargetTop
      , mgdlMax = d3.max(client.entries, function (d) { return d.mgdl; });

    return [
      utils.scaleMgdl(30)
      , Math.max(utils.scaleMgdl(mgdlMax * mult), utils.scaleMgdl(targetTop * mult))
    ];
  }

  function dynamicDomainOrElse(defaultDomain) {
    if (client.settings.scaleY === 'linear' || client.settings.scaleY === 'log-dynamic') {
      return dynamicDomain();
    } else {
      return defaultDomain;
    }
  }
  
  // define the parts of the axis that aren't dependent on width or height
  var xScale = chart.xScale = d3.time.scale().domain(extent);

  var yScale = chart.yScale = yScaleType()
    .domain(dynamicDomainOrElse(focusYDomain));

  var xScale2 = chart.xScale2 = d3.time.scale().domain(extent);

  var yScale2 = chart.yScale2 = yScaleType()
    .domain(dynamicDomainOrElse(contextYDomain));

  chart.xScaleBasals = d3.time.scale().domain(extent);

  chart.yScaleBasals = d3.scale.linear()
    .domain([0, 5]);

  var tickFormat = localeFormatter.timeFormat.multi(  [
    ['.%L', function(d) { return d.getMilliseconds(); }],
    [':%S', function(d) { return d.getSeconds(); }],
    [client.settings.timeFormat === 24 ? '%H:%M' : '%I:%M', function(d) { return d.getMinutes(); }],
    [client.settings.timeFormat === 24 ? '%H:%M' : '%-I %p', function(d) { return d.getHours(); }],
    ['%a %d', function(d) { return d.getDay() && d.getDate() !== 1; }],
    ['%b %d', function(d) { return d.getDate() !== 1; }],
    ['%B', function(d) { return d.getMonth(); }],
    ['%Y', function() { return true; }]
  ]);

  var tickValues = client.ticks(client);

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
    .on('brush', function brush (time) {
      client.loadRetroIfNeeded();
      client.brushed(time);
    })
    .on('brushend', brushEnded);

  chart.futureOpacity = d3.scale.linear( )
    .domain([times.mins(25).msecs, times.mins(60).msecs])
    .range([0.8, 0.1]);

  // create svg and g to contain the chart contents
  chart.charts = d3.select('#chartContainer').append('svg')
    .append('g')
    .attr('class', 'chartContainer');

  chart.basals = chart.charts.append('g').attr('class', 'chart-basals');

  chart.focus = chart.charts.append('g').attr('class', 'chart-focus');
  chart.drag = chart.focus.append('g').attr('class', 'drag-area');

  // create the x axis container
  chart.focus.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  chart.focus.append('g')
    .attr('class', 'y axis');

  chart.context = chart.charts.append('g').attr('class', 'chart-context');

  // create the x axis container
  chart.context.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  chart.context.append('g')
    .attr('class', 'y axis');

  function createAdjustedRange() {
    var range = chart.brush.extent().slice();

    var end = range[1].getTime() + client.forecastTime;
    if (!chart.inRetroMode()) {
      var lastSGVMills = client.latestSGV ? client.latestSGV.mills : client.now;
      end += (client.now - lastSGVMills);
    }
    range[1] = new Date(end);

    return range;
  }

  chart.inRetroMode = function inRetroMode() {
    if (!chart.brush || !chart.xScale2) {
      return false;
    }

    var brushTime = chart.brush.extent()[1].getTime();
    var maxTime = chart.xScale2.domain()[1].getTime();

    return brushTime < maxTime;
  };

  // called for initial update and updates for resize
  chart.update = function update(init) {

    if (client.documentHidden && !init) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }

    var chartContainer = $('#chartContainer');

    if (chartContainer.length < 1) {
      console.warn('Unable to find element for #chartContainer');
      return;
    }

    // get current data range
    var dataRange = client.dataExtent();
    var chartContainerRect = chartContainer[0].getBoundingClientRect();
    var chartWidth = chartContainerRect.width;
    var chartHeight = chartContainerRect.height - padding.bottom;

    // get the height of each chart based on its container size ratio
    var focusHeight = chart.focusHeight = chartHeight * .7;
    var contextHeight = chart.contextHeight = chartHeight * .2;
    chart.basalsHeight = focusHeight / 4;

    // get current brush extent
    var currentBrushExtent = createAdjustedRange();

    // only redraw chart if chart size has changed
    var widthChanged = (chart.prevChartWidth !== chartWidth);
    if (widthChanged || (chart.prevChartHeight !== chartHeight)) {

      //if rotated
      if (widthChanged) {
        client.browserUtils.closeLastOpenedDrawer();
      }

      chart.prevChartWidth = chartWidth;
      chart.prevChartHeight = chartHeight;

      //set the width and height of the SVG element
      chart.charts.attr('width', chartWidth)
        .attr('height', chartHeight + padding.bottom);

      // ranges are based on the width and height available so reset
      chart.xScale.range([0, chartWidth]);
      chart.xScale2.range([0, chartWidth]);
      chart.xScaleBasals.range([0, chartWidth]);
      chart.yScale.range([focusHeight, 0]);
      chart.yScale2.range([chartHeight, chartHeight - contextHeight]);
      chart.yScaleBasals.range([0, focusHeight / 4]);

      if (init) {

        // if first run then just display axis with no transition
        chart.focus.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(chart.xAxis);

        chart.focus.select('.y')
          .attr('transform', 'translate(' + chartWidth + ',0)')
          .call(chart.yAxis);

        // if first run then just display axis with no transition
        chart.context.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(chart.xAxis2);

//        chart.basals.select('.y')
//          .attr('transform', 'translate(0,' + 0 + ')')
//          .call(chart.yAxisBasals);

        chart.context.append('g')
          .attr('class', 'x brush')
          .call(d3.svg.brush().x(chart.xScale2).on('brush', client.brushed))
          .selectAll('rect')
          .attr('y', focusHeight)
          .attr('height', chartHeight - focusHeight);

        // disable resizing of brush
        d3.select('.x.brush').select('.background').style('cursor', 'move');
        d3.select('.x.brush').select('.resize.e').style('cursor', 'move');
        d3.select('.x.brush').select('.resize.w').style('cursor', 'move');

        // create a clipPath for when brushing
        chart.clip = chart.charts.append('defs')
          .append('clipPath')
          .attr('id', 'clip')
          .append('rect')
          .attr('height', chartHeight)
          .attr('width', chartWidth);

        // add a line that marks the current time
        chart.focus.append('line')
          .attr('class', 'now-line')
          .attr('x1', chart.xScale(new Date(client.now)))
          .attr('y1', chart.yScale(utils.scaleMgdl(30)))
          .attr('x2', chart.xScale(new Date(client.now)))
          .attr('y2', chart.yScale(utils.scaleMgdl(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        chart.focus.append('line')
          .attr('class', 'high-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that shows the high bg threshold
        chart.focus.append('line')
          .attr('class', 'target-top-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        chart.focus.append('line')
          .attr('class', 'target-bottom-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        chart.focus.append('line')
          .attr('class', 'low-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that opens up the brush extent from the context to the focus
        chart.context.append('line')
          .attr('class', 'open-top')
          .attr('stroke', '#111')
          .attr('stroke-width', 12);

        // add a x-axis line that closes the the brush container on left side
        chart.context.append('line')
          .attr('class', 'open-left')
          .attr('stroke', 'white');

        // add a x-axis line that closes the the brush container on right side
        chart.context.append('line')
          .attr('class', 'open-right')
          .attr('stroke', 'white');

        // add a line that marks the current time
        chart.context.append('line')
          .attr('class', 'now-line')
          .attr('x1', chart.xScale(new Date(client.now)))
          .attr('y1', chart.yScale2(utils.scaleMgdl(36)))
          .attr('x2', chart.xScale(new Date(client.now)))
          .attr('y2', chart.yScale2(utils.scaleMgdl(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        chart.context.append('line')
          .attr('class', 'high-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        chart.context.append('line')
          .attr('class', 'low-line')
          .attr('x1', chart.xScale(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

      } else {

        // for subsequent updates use a transition to animate the axis to the new position
        var focusTransition = chart.focus.transition();

        focusTransition.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(chart.xAxis);

        focusTransition.select('.y')
          .attr('transform', 'translate(' + chartWidth + ', 0)')
          .call(chart.yAxis);

        var contextTransition = chart.context.transition();

        contextTransition.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(chart.xAxis2);

        chart.basals.transition();

//        basalsTransition.select('.y')
//          .attr('transform', 'translate(0,' + 0 + ')')
//          .call(chart.yAxisBasals);

        if (chart.clip) {
          // reset clip to new dimensions
          chart.clip.transition()
            .attr('width', chartWidth)
            .attr('height', chartHeight);
        }

        // reset brush location
        chart.context.select('.x.brush')
          .selectAll('rect')
          .attr('y', focusHeight)
          .attr('height', chartHeight - focusHeight);

        // clear current brushs
        d3.select('.brush').call(chart.brush.clear());

        // redraw old brush with new dimensions
        d3.select('.brush').transition().call(chart.brush.extent(currentBrushExtent));

        // transition lines to correct location
        chart.focus.select('.high-line')
          .transition()
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)));

        chart.focus.select('.target-top-line')
          .transition()
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        chart.focus.select('.target-bottom-line')
          .transition()
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));

        chart.focus.select('.low-line')
          .transition()
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)));

        // transition open-top line to correct location
        chart.context.select('.open-top')
          .transition()
          .attr('x1', chart.xScale2(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(30)))
          .attr('x2', chart.xScale2(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(30)));

        // transition open-left line to correct location
        chart.context.select('.open-left')
          .transition()
          .attr('x1', chart.xScale2(currentBrushExtent[0]))
          .attr('y1', focusHeight)
          .attr('x2', chart.xScale2(currentBrushExtent[0]))
          .attr('y2', chartHeight);

        // transition open-right line to correct location
        chart.context.select('.open-right')
          .transition()
          .attr('x1', chart.xScale2(currentBrushExtent[1]))
          .attr('y1', focusHeight)
          .attr('x2', chart.xScale2(currentBrushExtent[1]))
          .attr('y2', chartHeight);

        // transition high line to correct location
        chart.context.select('.high-line')
          .transition()
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        // transition low line to correct location
        chart.context.select('.low-line')
          .transition()
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));
      }
    }

    // update domain
    chart.xScale2.domain(dataRange);
    chart.xScaleBasals.domain(dataRange);

    var updateBrush = d3.select('.brush').transition();
    updateBrush
      .call(chart.brush.extent([new Date(dataRange[1].getTime() - client.foucusRangeMS), dataRange[1]]));
    client.brushed(true);

    renderer.addContextCircles();

    // update x axis domain
    chart.context.select('.x').call(chart.xAxis2);

  };

  chart.scroll = function scroll (nowDate) {
    chart.xScale.domain(createAdjustedRange());
    chart.yScale.domain(dynamicDomainOrElse(focusYDomain));
    chart.xScaleBasals.domain(createAdjustedRange());

    // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
    d3.selectAll('.path').remove();

    // transition open-top line to correct location
    chart.context.select('.open-top')
      .attr('x1', chart.xScale2(chart.brush.extent()[0]))
      .attr('y1', chart.yScale(utils.scaleMgdl(30)))
      .attr('x2', chart.xScale2(new Date(chart.brush.extent()[1].getTime() + client.forecastTime)))
      .attr('y2', chart.yScale(utils.scaleMgdl(30)));

    // transition open-left line to correct location
    chart.context.select('.open-left')
      .attr('x1', chart.xScale2(chart.brush.extent()[0]))
      .attr('y1', chart.focusHeight)
      .attr('x2', chart.xScale2(chart.brush.extent()[0]))
      .attr('y2', chart.prevChartHeight);

    // transition open-right line to correct location
    chart.context.select('.open-right')
      .attr('x1', chart.xScale2(new Date(chart.brush.extent()[1].getTime() + client.forecastTime)))
      .attr('y1', chart.focusHeight)
      .attr('x2', chart.xScale2(new Date(chart.brush.extent()[1].getTime() + client.forecastTime)))
      .attr('y2', chart.prevChartHeight);

    chart.focus.select('.now-line')
      .transition()
      .attr('x1', chart.xScale(nowDate))
      .attr('y1', chart.yScale(utils.scaleMgdl(36)))
      .attr('x2', chart.xScale(nowDate))
      .attr('y2', chart.yScale(utils.scaleMgdl(420)));

    chart.context.select('.now-line')
      .transition()
      .attr('x1', chart.xScale2(chart.brush.extent()[1]))
      .attr('y1', chart.yScale2(utils.scaleMgdl(36)))
      .attr('x2', chart.xScale2(chart.brush.extent()[1]))
      .attr('y2', chart.yScale2(utils.scaleMgdl(420)));

    // update x,y axis
    chart.focus.select('.x.axis').call(chart.xAxis);
    chart.focus.select('.y.axis').call(chart.yAxis);

    renderer.addBasals(client);

    renderer.addFocusCircles();
    renderer.addTreatmentCircles();
    renderer.addTreatmentProfiles(client);
    renderer.drawTreatments(client);

  };

  return chart;
}

module.exports = init;
