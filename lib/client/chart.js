'use strict';

var _ = require('lodash');
var times = require('../times');
var d3locales = require('./d3locales');
var scrolling = false
  , scrollNow = 0
  , scrollBrushExtent = null
  , scrollRange = null;

var PADDING_BOTTOM = 30
  , OPEN_TOP_HEIGHT = 8
  , CONTEXT_MAX = 420
  , CONTEXT_MIN = 36
  , FOCUS_MAX = 510
  , FOCUS_MIN = 30;

var loadTime = Date.now();

function init (client, d3, $) {
  var chart = {};

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
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 5)
    .attr('refY', 0)
    .attr('markerWidth', 8)
    .attr('markerHeight', 8)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('class', 'arrowHead');

  var localeFormatter = d3.timeFormatLocale(d3locales.locale(client.settings.language));

  function beforeBrushStarted () {
    // go ahead and move the brush because
    // a single click will not execute the brush event
    var now = new Date();
    var dx = chart.xScale2(now) - chart.xScale2(new Date(now.getTime() - client.focusRangeMS));

    var cx = d3.mouse(this)[0];
    var x0 = cx - dx / 2;
    var x1 = cx + dx / 2;

    var range = chart.xScale2.range();
    var X0 = range[0];
    var X1 = range[1];

    var brush = x0 < X0 ? [X0, X0 + dx] : x1 > X1 ? [X1 - dx, X1] : [x0, x1];

    chart.theBrush.call(chart.brush.move, brush);
  }

  function brushStarted () {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
      .data(client.entries)
      .style('opacity', 1);
  }

  function brushEnded () {
    // update the opacity of the context data points to brush extent
    chart.context.selectAll('circle')
      .data(client.entries)
      .style('opacity', function(d) { return renderer.highlightBrushPoints(d) });
  }

  var extent = client.dataExtent();

  var yScaleType;
  if (client.settings.scaleY === 'linear') {
    yScaleType = d3.scaleLinear;
  } else {
    yScaleType = d3.scaleLog;
  }

  var focusYDomain = [utils.scaleMgdl(FOCUS_MIN), utils.scaleMgdl(FOCUS_MAX)];
  var contextYDomain = [utils.scaleMgdl(CONTEXT_MIN), utils.scaleMgdl(CONTEXT_MAX)];

  function dynamicDomain () {
    // allow y-axis to extend all the way to the top of the basal area, but leave room to display highest value
    var mult = 1.15
      , targetTop = client.settings.thresholds.bgTargetTop
      // filter to only use actual SGV's (not rawbg's) to set the view window.
      // can switch to Logarithmic (non-dynamic) to see anything that doesn't fit in the dynamicDomain
      , mgdlMax = d3.max(client.entries, function(d) { if (d.type === 'sgv') { return d.mgdl; } });
    // use the 99th percentile instead of max to avoid rescaling for 1 flukey data point
    // need to sort client.entries by mgdl first
    //, mgdlMax = d3.quantile(client.entries, 0.99, function (d) { return d.mgdl; });

    return [
      utils.scaleMgdl(FOCUS_MIN)
      , Math.max(utils.scaleMgdl(mgdlMax * mult), utils.scaleMgdl(targetTop * mult))
    ];
  }

  function dynamicDomainOrElse (defaultDomain) {
    if (client.entries && (client.entries.length > 0) && (client.settings.scaleY === 'linear' || client.settings.scaleY === 'log-dynamic')) {
      return dynamicDomain();
    } else {
      return defaultDomain;
    }
  }

  // define the parts of the axis that aren't dependent on width or height
  var xScale = chart.xScale = d3.scaleTime().domain(extent);

  focusYDomain = dynamicDomainOrElse(focusYDomain);
  var yScale = chart.yScale = yScaleType()
    .domain(focusYDomain);

  var xScale2 = chart.xScale2 = d3.scaleTime().domain(extent);

  contextYDomain = dynamicDomainOrElse(contextYDomain);

  var yScale2 = chart.yScale2 = yScaleType()
    .domain(contextYDomain);

  chart.xScaleBasals = d3.scaleTime().domain(extent);

  chart.yScaleBasals = d3.scaleLinear()
    .domain([0, 5]);

  var formatMillisecond = localeFormatter.format('.%L')
    , formatSecond = localeFormatter.format(':%S')
    , formatMinute = client.settings.timeFormat === 24 ? localeFormatter.format('%H:%M') :
    localeFormatter.format('%-I:%M')
    , formatHour = client.settings.timeFormat === 24 ? localeFormatter.format('%H:%M') :
    localeFormatter.format('%-I %p')
    , formatDay = localeFormatter.format('%a %d')
    , formatWeek = localeFormatter.format('%b %d')
    , formatMonth = localeFormatter.format('%B')
    , formatYear = localeFormatter.format('%Y');

  var tickFormat = function(date) {
    return (d3.timeSecond(date) < date ? formatMillisecond :
      d3.timeMinute(date) < date ? formatSecond :
      d3.timeHour(date) < date ? formatMinute :
      d3.timeDay(date) < date ? formatHour :
      d3.timeMonth(date) < date ? (d3.timeWeek(date) < date ? formatDay : formatWeek) :
      d3.timeYear(date) < date ? formatMonth :
      formatYear)(date);
  };

  var tickValues = client.ticks(client);

  chart.xAxis = d3.axisBottom(xScale)

  chart.xAxis = d3.axisBottom(xScale)
    .tickFormat(tickFormat)
    .ticks(6);

  chart.yAxis = d3.axisLeft(yScale)
    .tickFormat(d3.format('d'))
    .tickValues(tickValues);

  chart.xAxis2 = d3.axisBottom(xScale2)
    .tickFormat(tickFormat)
    .ticks(6);

  chart.yAxis2 = d3.axisRight(yScale2)
    .tickFormat(d3.format('d'))
    .tickValues(tickValues);

  d3.select('tick')
    .style('z-index', '10000');

  // setup a brush
  chart.brush = d3.brushX()
    .on('start', brushStarted)
    .on('brush', function brush (time) {
      // layouting the graph causes a brushed event
      // ignore retro data load the first two seconds
      if (Date.now() - loadTime > 2000) client.loadRetroIfNeeded();
      client.brushed(time);
    })
    .on('end', brushEnded);

  chart.theBrush = null;

  chart.futureOpacity = (function() {
    var scale = d3.scaleLinear()
      .domain([times.mins(25).msecs, times.mins(60).msecs])
      .range([0.8, 0.1]);

    return function(delta) {
      if (delta < 0) {
        return null;
      } else {
        return scale(delta);
      }
    };
  })();

  // create svg and g to contain the chart contents
  chart.charts = d3.select('#chartContainer').append('svg')
    .append('g')
    .attr('class', 'chartContainer');

  chart.basals = chart.charts.append('g').attr('class', 'chart-basals');

  chart.focus = chart.charts.append('g').attr('class', 'chart-focus');
  chart.drag = chart.focus.append('g').attr('class', 'drag-area');

  // create the x axis container
  chart.focus.append('g')
    .attr('class', 'x axis')
    .style("font-size", "16px");

  // create the y axis container
  chart.focus.append('g')
    .attr('class', 'y axis')
    .style("font-size", "16px");

  chart.context = chart.charts.append('g')
    .attr('class', 'chart-context');

  // create the x axis container
  chart.context.append('g')
    .attr('class', 'x axis')
    .style("font-size", "16px");

  // create the y axis container
  chart.context.append('g')
    .attr('class', 'y axis')
    .style("font-size", "16px");

  chart.createBrushedRange = function() {
    var brushedRange = chart.theBrush && d3.brushSelection(chart.theBrush.node()) || null;
    var range = brushedRange && brushedRange.map(chart.xScale2.invert);
    var dataExtent = client.dataExtent();

    if (!brushedRange) {
      // console.log('No current brushed range. Setting range to last focusRangeMS amount of available data');
      range = dataExtent;
      range[0] = new Date(range[1].getTime() - client.focusRangeMS);
    }

    var end = range[1].getTime();
    if (!chart.inRetroMode()) {
      end = client.now > dataExtent[1].getTime() ? client.now : dataExtent[1].getTime();
    }
    range[1] = new Date(end);
    range[0] = new Date(end - client.focusRangeMS);

    return range;
  }

  chart.createAdjustedRange = function() {
    var adjustedRange = chart.createBrushedRange();

    adjustedRange[1] = new Date(Math.max(adjustedRange[1].getTime(), client.forecastTime));

    return adjustedRange;
  }

  chart.inRetroMode = function inRetroMode () {
    var brushedRange = chart.theBrush && d3.brushSelection(chart.theBrush.node()) || null;

    if (!brushedRange || !chart.xScale2) {
      return false;
    }

    var maxTime = chart.xScale2.domain()[1].getTime();
    var brushTime = chart.xScale2.invert(brushedRange[1]).getTime();

    return brushTime < maxTime;
  };

  // called for initial update and updates for resize
  chart.update = function update (init) {

    if (client.documentHidden && !init) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }

    chart.setForecastTime();

    var chartContainer = $('#chartContainer');

    if (chartContainer.length < 1) {
      console.warn('Unable to find element for #chartContainer');
      return;
    }

    // get current data range
    var dataRange = client.dataExtent();
    var chartContainerRect = chartContainer[0].getBoundingClientRect();
    var chartWidth = chartContainerRect.width;
    var chartHeight = chartContainerRect.height - PADDING_BOTTOM;

    // get the height of each chart based on its container size ratio
    var focusHeight = chart.focusHeight = chartHeight * .7;
    var contextHeight = chart.contextHeight = chartHeight * .3;
    chart.basalsHeight = focusHeight / 4;

    // get current brush extent
    var currentRange = chart.createAdjustedRange();
    var currentBrushExtent = chart.createBrushedRange();

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
        .attr('height', chartHeight + PADDING_BOTTOM);

      // ranges are based on the width and height available so reset
      chart.xScale.range([0, chartWidth]);
      chart.xScale2.range([0, chartWidth]);
      chart.xScaleBasals.range([0, chartWidth]);
      chart.yScale.range([focusHeight, 0]);
      chart.yScale2.range([contextHeight, 0]);
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
        chart.context
          .attr('transform', 'translate(0,' + focusHeight + ')')

        chart.context.select('.x')
          .attr('transform', 'translate(0,' + contextHeight + ')')
          .call(chart.xAxis2);

        chart.theBrush = chart.context.append('g')
          .attr('class', 'x brush')
          .call(chart.brush)
          .call(g => g.select(".overlay")
            .datum({ type: 'selection' })
            .on('mousedown touchstart', beforeBrushStarted));

        chart.theBrush.selectAll('rect')
          .attr('y', 0)
          .attr('height', contextHeight);

        // disable resizing of brush
        chart.context.select('.x.brush').select('.overlay').style('cursor', 'move');
        chart.context.select('.x.brush').selectAll('.handle')
          .style('cursor', 'move');

        chart.context.select('.x.brush').select('.selection')
          .style('visibility', 'hidden');

        // add a line that marks the current time
        chart.focus.append('line')
          .attr('class', 'now-line')
          .attr('x1', chart.xScale(new Date(client.now)))
          .attr('y1', chart.yScale(focusYDomain[0]))
          .attr('x2', chart.xScale(new Date(client.now)))
          .attr('y2', chart.yScale(focusYDomain[1]))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        chart.focus.append('line')
          .attr('class', 'high-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that shows the high bg threshold
        chart.focus.append('line')
          .attr('class', 'target-top-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        chart.focus.append('line')
          .attr('class', 'target-bottom-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        chart.focus.append('line')
          .attr('class', 'low-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that opens up the brush extent from the context to the focus
        chart.context.append('line')
          .attr('class', 'open-top')
          .attr('stroke', '#111')
          .attr('stroke-width', OPEN_TOP_HEIGHT);

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
          .attr('y1', chart.yScale2(contextYDomain[0]))
          .attr('x2', chart.xScale(new Date(client.now)))
          .attr('y2', chart.yScale2(contextYDomain[1]))
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

        chart.focus.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(chart.xAxis);

        chart.focus.select('.y')
          .attr('transform', 'translate(' + chartWidth + ', 0)')
          .call(chart.yAxis);

        chart.context
          .attr('transform', 'translate(0,' + focusHeight + ')')

        chart.context.select('.x')
          .attr('transform', 'translate(0,' + contextHeight + ')')
          .call(chart.xAxis2);

        chart.basals;

        // reset brush location
        chart.theBrush.selectAll('rect')
          .attr('y', 0)
          .attr('height', contextHeight);

        // console.log('Redrawing old brush with new dimensions: ', currentBrushExtent);

        // redraw old brush with new dimensions
        chart.theBrush.call(chart.brush.move, currentBrushExtent.map(chart.xScale2));

        // transition lines to correct location
        chart.focus.select('.high-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgHigh)));

        chart.focus.select('.target-top-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        chart.focus.select('.target-bottom-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));

        chart.focus.select('.low-line')
          .attr('x1', chart.xScale.range()[0])
          .attr('y1', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)))
          .attr('x2', chart.xScale.range()[1])
          .attr('y2', chart.yScale(utils.scaleMgdl(client.settings.thresholds.bgLow)));

        // transition open-top line to correct location
        chart.context.select('.open-top')
          .attr('x1', chart.xScale2(currentRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(CONTEXT_MAX)) + Math.floor(OPEN_TOP_HEIGHT/2.0)-1)
          .attr('x2', chart.xScale2(currentRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(CONTEXT_MAX)) + Math.floor(OPEN_TOP_HEIGHT/2.0)-1);

        // transition open-left line to correct location
        chart.context.select('.open-left')
          .attr('x1', chart.xScale2(currentRange[0]))
          .attr('y1', chart.yScale2(contextYDomain[0]))
          .attr('x2', chart.xScale2(currentRange[0]))
          .attr('y2', chart.yScale2(contextYDomain[1]));

        // transition open-right line to correct location
        chart.context.select('.open-right')
          .attr('x1', chart.xScale2(currentRange[1]))
          .attr('y1', chart.yScale2(contextYDomain[0]))
          .attr('x2', chart.xScale2(currentRange[1]))
          .attr('y2', chart.yScale2(contextYDomain[1]));

        // transition high line to correct location
        chart.context.select('.high-line')
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetTop)));

        // transition low line to correct location
        chart.context.select('.low-line')
          .attr('x1', chart.xScale2(dataRange[0]))
          .attr('y1', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', chart.xScale2(dataRange[1]))
          .attr('y2', chart.yScale2(utils.scaleMgdl(client.settings.thresholds.bgTargetBottom)));
      }
    }

    chart.updateContext(dataRange);

    chart.xScaleBasals.domain(dataRange);

    // console.log('Redrawing brush due to update: ', currentBrushExtent);

    chart.theBrush.call(chart.brush.move, currentBrushExtent.map(chart.xScale2));
  };

  chart.updateContext = function(dataRange_) {
    if (client.documentHidden) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }

    // get current data range
    var dataRange = dataRange_ || client.dataExtent();

    // update domain
    chart.xScale2.domain(dataRange);

    renderer.addContextCircles();

    // update x axis domain
    chart.context.select('.x').call(chart.xAxis2);
  };

  function scrollUpdate () {
    scrolling = false;

    var nowDate = scrollNow;

    var currentBrushExtent = scrollBrushExtent;
    var currentRange = scrollRange;

    chart.setForecastTime();

    chart.xScale.domain(currentRange);

    focusYDomain = dynamicDomainOrElse(focusYDomain);

    chart.yScale.domain(focusYDomain);
    chart.xScaleBasals.domain(currentRange);

    // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
    d3.selectAll('.path').remove();

    // transition open-top line to correct location
    chart.context.select('.open-top')
      .attr('x1', chart.xScale2(currentRange[0]))
      .attr('y1', chart.yScale2(contextYDomain[1]) + Math.floor(OPEN_TOP_HEIGHT / 2.0)-1)
      .attr('x2', chart.xScale2(currentRange[1]))
      .attr('y2', chart.yScale2(contextYDomain[1]) + Math.floor(OPEN_TOP_HEIGHT / 2.0)-1);

    // transition open-left line to correct location
    chart.context.select('.open-left')
      .attr('x1', chart.xScale2(currentRange[0]))
      .attr('y1', chart.yScale2(contextYDomain[0]))
      .attr('x2', chart.xScale2(currentRange[0]))
      .attr('y2', chart.yScale2(contextYDomain[1]));

    // transition open-right line to correct location
    chart.context.select('.open-right')
      .attr('x1', chart.xScale2(currentRange[1]))
      .attr('y1', chart.yScale2(contextYDomain[0]))
      .attr('x2', chart.xScale2(currentRange[1]))
      .attr('y2', chart.yScale2(contextYDomain[1]));

    chart.focus.select('.now-line')
      .attr('x1', chart.xScale(nowDate))
      .attr('y1', chart.yScale(focusYDomain[0]))
      .attr('x2', chart.xScale(nowDate))
      .attr('y2', chart.yScale(focusYDomain[1]));

    chart.context.select('.now-line')
      .attr('x1', chart.xScale2(currentBrushExtent[1]))
      .attr('y1', chart.yScale2(contextYDomain[0]))
      .attr('x2', chart.xScale2(currentBrushExtent[1]))
      .attr('y2', chart.yScale2(contextYDomain[1]));

    // update x,y axis
    chart.focus.select('.x.axis').call(chart.xAxis);
    chart.focus.select('.y.axis').call(chart.yAxis);

    renderer.addBasals(client);

    renderer.addFocusCircles();
    renderer.addTreatmentCircles(nowDate);
    renderer.addTreatmentProfiles(client);
    renderer.drawTreatments(client);


    // console.log('Redrawing brush due to update: ', currentBrushExtent);

    chart.theBrush.call(chart.brush.move, currentBrushExtent.map(chart.xScale2));
  }

  chart.scroll = function scroll (nowDate) {
    scrollNow = nowDate;
    scrollBrushExtent = chart.createBrushedRange();
    scrollRange = chart.createAdjustedRange();

    if (!scrolling) {
      requestAnimationFrame(scrollUpdate);
    }

    scrolling = true;
  };

  chart.getMaxForecastMills = function getMaxForecastMills () {
    // limit lookahead to the same as lookback
    var selectedRange = chart.createBrushedRange();
    var to = selectedRange[1].getTime();
    return to + client.focusRangeMS;
  };

  chart.getForecastData = function getForecastData () {

    var maxForecastAge = chart.getMaxForecastMills();
    var pointTypes = client.settings.showForecast.split(' ');

    var points = pointTypes.reduce( function (points, type) {
      return points.concat(client.sbx.pluginBase.forecastPoints[type] || []);
    }, [] );

    return _.filter(points, function isShown (point) {
      return point.mills < maxForecastAge;
    });

  };

  chart.setForecastTime = function setForecastTime () {

    if (client.sbx.pluginBase.forecastPoints) {
      var shownForecastPoints = chart.getForecastData();

      // Get maximum time we will allow projected forward in time
      // based on the number of hours the user has selected to show.
      var maxForecastMills = chart.getMaxForecastMills();

      var selectedRange = chart.createBrushedRange();
      var to = selectedRange[1].getTime();

      // Default min forecast projection times to the default amount of time to forecast
      var minForecastMills = to + client.defaultForecastTime;
      var availForecastMills = 0;

      // Determine what the maximum forecast time is that is available in the forecast data
      if (shownForecastPoints.length > 0) {
        availForecastMills = _.max(_.map(shownForecastPoints, function(point) { return point.mills }));
      }

      // Limit the amount shown to the maximum time allowed to be projected forward based
      // on the number of hours the user has selected to show
      var forecastMills = Math.min(availForecastMills, maxForecastMills);

      var lastSGVMills = client.sbx.lastSGVMills();

      // Don't allow the forecast time to go below the minimum forecast time
      client.forecastTime = Math.max(forecastMills, minForecastMills);
    }
  };

  return chart;
}

module.exports = init;
