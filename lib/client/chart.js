'use strict';

var _ = require('lodash');
var times = require('../times');

var DEBOUNCE_MS = 10
  , UPDATE_TRANS_MS = 750 // milliseconds
  , padding = { top: 0, right: 10, bottom: 30, left: 10 }
  ;

function init (client, d3, $) {
  var chart = { };

  var utils = client.utils;
  var renderer = client.renderer;

  function brushStarted() {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
      .data(client.data)
      .style('opacity', 1);
  }

  function brushEnded() {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
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

  chart.futureOpacity = d3.scale.linear( )
    .domain([times.mins(25).msecs, times.mins(60).msecs])
    .range([0.8, 0.1]);

  // create svg and g to contain the chart contents
  chart.charts = d3.select('#chartContainer').append('svg')
    .append('g')
    .attr('class', 'chartContainer')
    .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')');

  chart.focus = chart.charts.append('g');

  // create the x axis container
  chart.focus.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  chart.focus.append('g')
    .attr('class', 'y axis');

  chart.context = chart.charts.append('g');

  // create the x axis container
  chart.context.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  chart.context.append('g')
    .attr('class', 'y axis');

  // called for initial update and updates for resize
  chart.update = _.debounce(function debouncedUpdateChart(init) {

    if (client.documentHidden && !init) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }
    // get current data range
    var dataRange = d3.extent(client.data, client.dateFn);

    // get the entire container height and width subtracting the padding
    var chartContainerRect = $('#chartContainer')[0].getBoundingClientRect();
    var chartWidth = chartContainerRect.width - padding.left - padding.right;
    var chartHeight = chartContainerRect.height - padding.top - padding.bottom;

    // get the height of each chart based on its container size ratio
    var focusHeight = chart.focusHeight = chartHeight * .7;
    var contextHeight = chart.contextHeight = chartHeight * .2;

    // get current brush extent
    var currentBrushExtent = chart.brush.extent();

    // only redraw chart if chart size has changed
    if ((client.prevChartWidth !== chartWidth) || (client.prevChartHeight !== chartHeight)) {

      client.prevChartWidth = chartWidth;
      client.prevChartHeight = chartHeight;

      //set the width and height of the SVG element
      chart.charts.attr('width', chartWidth + padding.left + padding.right)
        .attr('height', chartHeight + padding.top + padding.bottom);

      // ranges are based on the width and height available so reset
      chart.xScale.range([0, chartWidth]);
      chart.xScale2.range([0, chartWidth]);
      chart.yScale.range([focusHeight, 0]);
      chart.yScale2.range([chartHeight, chartHeight - contextHeight]);

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
        chart.focus.append('line')
          .attr('class', 'open-top')
          .attr('stroke', 'black')
          .attr('stroke-width', 2);

        // add a x-axis line that closes the the brush container on left side
        chart.focus.append('line')
          .attr('class', 'open-left')
          .attr('stroke', 'white');

        // add a x-axis line that closes the the brush container on right side
        chart.focus.append('line')
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
        var focusTransition = chart.focus.transition().duration(UPDATE_TRANS_MS);

        focusTransition.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(chart.xAxis);

        focusTransition.select('.y')
          .attr('transform', 'translate(' + chartWidth + ', 0)')
          .call(chart.yAxis);

        var contextTransition = chart.context.transition().duration(UPDATE_TRANS_MS);

        contextTransition.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(chart.xAxis2);

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
        d3.select('.brush').transition().duration(UPDATE_TRANS_MS).call(chart.brush.extent(currentBrushExtent));

        // transition lines to correct location
        chart.focus.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)));

        chart.focus.select('.target-top-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        chart.focus.select('.target-bottom-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));

        chart.focus.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .attr('x2', chart.xScale(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)));

        // transition open-top line to correct location
        chart.focus.select('.open-top')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale2(currentBrushExtent[0]))
          .attr('y1', chart.yScale(utils.scaleMgdl(30)))
          .attr('x2', chart.xScale2(currentBrushExtent[1]))
          .attr('y2', chart.yScale(utils.scaleMgdl(30)));

        // transition open-left line to correct location
        chart.focus.select('.open-left')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale2(currentBrushExtent[0]))
          .attr('y1', focusHeight)
          .attr('x2', chart.xScale2(currentBrushExtent[0]))
          .attr('y2', chartHeight);

        // transition open-right line to correct location
        chart.focus.select('.open-right')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale2(currentBrushExtent[1]))
          .attr('y1', focusHeight)
          .attr('x2', chart.xScale2(currentBrushExtent[1]))
          .attr('y2', chartHeight);

        // transition high line to correct location
        chart.context.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        // transition low line to correct location
        chart.context.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));
      }
    }

    // update domain
    chart.xScale2.domain(dataRange);

    // only if a user brush is not active, update brush and focus chart with recent data
    // else, just transition brush
    var updateBrush = d3.select('.brush').transition().duration(UPDATE_TRANS_MS);
    if (!client.brushInProgress) {
      updateBrush
        .call(chart.brush.extent([new Date(dataRange[1].getTime() - client.foucusRangeMS), dataRange[1]]));
      client.brushed(true);
    } else {
      updateBrush
        .call(chart.brush.extent([new Date(currentBrushExtent[1].getTime() - client.foucusRangeMS), currentBrushExtent[1]]));
      client.brushed(true);
    }

    renderer.addContextCircles();

    // update x axis domain
    chart.context.select('.x').call(chart.xAxis2);

  }, DEBOUNCE_MS);

  chart.scroll = function scroll (nowDate) {
    chart.xScale.domain(chart.brush.extent());

    // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
    d3.selectAll('.path').remove();

    // transition open-top line to correct location
    chart.focus.select('.open-top')
      .attr('x1', chart.xScale2(chart.brush.extent()[0]))
      .attr('y1', chart.yScale(utils.scaleMgdl(30)))
      .attr('x2', chart.xScale2(chart.brush.extent()[1]))
      .attr('y2', chart.yScale(utils.scaleMgdl(30)));

    // transition open-left line to correct location
    chart.focus.select('.open-left')
      .attr('x1', chart.xScale2(chart.brush.extent()[0]))
      .attr('y1', chart.focusHeight)
      .attr('x2', chart.xScale2(chart.brush.extent()[0]))
      .attr('y2', client.prevChartHeight);

    // transition open-right line to correct location
    chart.focus.select('.open-right')
      .attr('x1', chart.xScale2(chart.brush.extent()[1]))
      .attr('y1', chart.focusHeight)
      .attr('x2', chart.xScale2(chart.brush.extent()[1]))
      .attr('y2', client.prevChartHeight);

    chart.focus.select('.now-line')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .attr('x1', chart.xScale(nowDate))
      .attr('y1', chart.yScale(utils.scaleMgdl(36)))
      .attr('x2', chart.xScale(nowDate))
      .attr('y2', chart.yScale(utils.scaleMgdl(420)));

    chart.context.select('.now-line')
      .transition()
      .attr('x1', chart.xScale2(chart.brush.extent()[1]- times.mins(30).msecs))
      .attr('y1', chart.yScale2(utils.scaleMgdl(36)))
      .attr('x2', chart.xScale2(chart.brush.extent()[1]- times.mins(30).msecs))
      .attr('y2', chart.yScale2(utils.scaleMgdl(420)));

    // update x axis
    chart.focus.select('.x.axis').call(chart.xAxis);

    renderer.addFocusCircles();
    renderer.addTreatmentCircles();

    // add treatment bubbles
    chart.focus.selectAll('circle')
      .data(client.treatments)
      .each(function (d) {
        renderer.drawTreatment(d, {
          scale: renderer.bubbleScale()
          , showLabels: true
        });
      });

  };

  return chart;
}

module.exports = init;