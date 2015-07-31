'use strict';

var _ = require('lodash');
var $ = (global && global.$) || require('jquery');
var d3 = (global && global.d3) || require('d3');

var language = require('../language')();
var sandbox = require('../sandbox')();
var units = require('../units')();
var times = require('../times');

var client = { };

client.init = function init(serverSettings, plugins) {

  var BRUSH_TIMEOUT = times.mins(5).msecs
    , DEBOUNCE_MS = 10
    , UPDATE_TRANS_MS = 750 // milliseconds
    , FORMAT_TIME_12 = '%-I:%M %p'
    , FORMAT_TIME_12_COMAPCT = '%-I:%M'
    , FORMAT_TIME_24 = '%H:%M%'
    , FORMAT_TIME_12_SCALE = '%-I %p'
    , FORMAT_TIME_24_SCALE = '%H'
    ;

  var socket
    , isInitialData = false
    , SGVdata = []
    , MBGdata = []
    , latestUpdateTime
    , prevSGV
    , treatments
    , cal
    , devicestatusData
    , padding = { top: 0, right: 10, bottom: 30, left: 10 }
    , opacity = {current: 1, DAY: 1, NIGHT: 0.5}
    , now = Date.now()
    , clientAlarms = {}
    , alarmInProgress = false
    , alarmMessage
    , currentAlarmType = null
    , currentAnnouncement
    , alarmSound = 'alarm.mp3'
    , urgentAlarmSound = 'alarm2.mp3';

  var tickValues
    , charts
    , prevChartWidth = 0
    , prevChartHeight = 0
    , focusHeight
    , contextHeight
    , dateFn = function (d) { return new Date(d.mills) }
    , documentHidden = false
    , brushTimer
    , brushInProgress = false
    , clip;

  client.data = [];
  client.dateFn = dateFn;
  client.settings = require('./browser-settings')(serverSettings, plugins);
  client.utils = require('../utils')(client.settings);

  client.sbx = sandbox.clientInit(client.settings, Date.now());
  client.rawbg = plugins('rawbg');
  client.delta = plugins('delta');
  client.direction = plugins('direction');
  client.errorcodes = plugins('errorcodes');

  language.set(client.settings.language).DOMtranslate();
  var translate = client.translate = language.translate;

  client.tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('opacity', 0);

  client.foucusRangeMS = times.hours(3).msecs;

  var renderer = require('./renderer')(client);
  var timeAgo = client.utils.timeAgo;

  var container = $('.container')
    , bgStatus = $('.bgStatus')
    , currentBG = $('.bgStatus .currentBG')
    , majorPills = $('.bgStatus .majorPills')
    , minorPills = $('.bgStatus .minorPills')
    , statusPills = $('.status .statusPills')
    ;

  function formatTime(time, compact) {
    var timeFormat = getTimeFormat(false, compact);
    time = d3.time.format(timeFormat)(time);
    if (!isTimeFormat24()) {
      time = time.toLowerCase();
    }
    return time;
  }

  function isTimeFormat24() {
    return client.settings.timeFormat === 24;
  }

  function getTimeFormat(isForScale, compact) {
    var timeFormat = FORMAT_TIME_12;
    if (isTimeFormat24()) {
      timeFormat = isForScale ? FORMAT_TIME_24_SCALE : FORMAT_TIME_24;
    } else {
      timeFormat = isForScale ? FORMAT_TIME_12_SCALE : (compact ? FORMAT_TIME_12_COMAPCT : FORMAT_TIME_12);
    }

    return timeFormat;
  }

// lixgbg: Convert mg/dL BG value to metric mmol
  function scaleBg(bg) {
    if (client.settings.units === 'mmol') {
      return units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  }

  function generateTitle ( ) {
    function s(value, sep) { return value ? value + ' ' : sep || ''; }

    var title = '';

    var time = client.latestSGV ? client.latestSGV.mills : (prevSGV ? prevSGV.mills : -1)
      , ago = timeAgo(time);

    if (ago && ago.status !== 'current') {
      title =  s(ago.value) + s(ago.label, ' - ') + title;
    } else if (client.latestSGV) {
      var currentMgdl = client.latestSGV.mgdl;

      if (currentMgdl < 39) {
        title = s(client.errorcodes.toDisplay(currentMgdl), ' - ') + title;
      } else {
        var deltaDisplay = client.delta.calc(prevSGV, client.latestSGV, client.sbx).display;
        title = s(scaleBg(currentMgdl)) + s(deltaDisplay) + s(client.direction.info(client.latestSGV).label) + title;
      }
    }
    return title;
  }

  function resetCustomTitle ( ) {
    var customTitle = client.settings.customTitle || 'Nightscout';
    $('.customTitle').text(customTitle);
  }

  function checkAnnouncement() {
    var result = {
      inProgress: currentAnnouncement ? Date.now() - currentAnnouncement.received < times.mins(5).msecs : false
    };

    if (result.inProgress) {
      var message = currentAnnouncement.message.length > 1 ? currentAnnouncement.message : currentAnnouncement.title;
      result.message = message;
      $('.customTitle').text(message);
    } else if (currentAnnouncement) {
      currentAnnouncement = null;
      console.info('cleared announcement');
    }

    return result;
  }

  function updateTitle ( ) {

    var windowTitle;
    var announcementStatus = checkAnnouncement();

    if (alarmMessage && alarmInProgress) {
      $('.customTitle').text(alarmMessage);
      if (!isTimeAgoAlarmType(currentAlarmType)) {
        windowTitle = alarmMessage + ': ' + generateTitle();
      }
    } else if (announcementStatus.inProgress && announcementStatus.message) {
      windowTitle = announcementStatus.message + ': ' + generateTitle();
    } else  {
      resetCustomTitle();
    }

    container.toggleClass('announcing', announcementStatus.inProgress);

    $(document).attr('title', windowTitle || generateTitle());
  }

// initial setup of chart when data is first made available
  function initializeCharts() {

    // define the parts of the axis that aren't dependent on width or height
    var xScale = client.xScale = d3.time.scale()
      .domain(d3.extent(client.data, dateFn));

    var yScale = client.yScale = d3.scale.log()
      .domain([scaleBg(30), scaleBg(510)]);

    var xScale2 = client.xScale2 = d3.time.scale()
      .domain(d3.extent(client.data, dateFn));

    var yScale2 = client.yScale2 = d3.scale.log()
      .domain([scaleBg(36), scaleBg(420)]);

    var tickFormat = d3.time.format.multi(  [
      ['.%L', function(d) { return d.getMilliseconds(); }],
      [':%S', function(d) { return d.getSeconds(); }],
      ['%I:%M', function(d) { return d.getMinutes(); }],
      [isTimeFormat24() ? '%H:%M' : '%-I %p', function(d) { return d.getHours(); }],
      ['%a %d', function(d) { return d.getDay() && d.getDate() !== 1; }],
      ['%b %d', function(d) { return d.getDate() !== 1; }],
      ['%B', function(d) { return d.getMonth(); }],
      ['%Y', function() { return true; }]
    ]);

    client.xAxis = d3.svg.axis()
      .scale(xScale)
      .tickFormat(tickFormat)
      .ticks(4)
      .orient('bottom');

    client.yAxis = d3.svg.axis()
      .scale(yScale)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues)
      .orient('left');

    client.xAxis2 = d3.svg.axis()
      .scale(xScale2)
      .tickFormat(tickFormat)
      .ticks(6)
      .orient('bottom');

    client.yAxis2 = d3.svg.axis()
      .scale(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues)
      .orient('right');

    // setup a brush
    client.brush = d3.svg.brush()
      .x(xScale2)
      .on('brushstart', brushStarted)
      .on('brush', brushed)
      .on('brushend', brushEnded);

    updateChart(true);
  }

  function addPlaceholderPoints () {
    // TODO: This is a kludge to advance the time as data becomes stale by making old predictor clear (using color = 'none')
    // This shouldn't need to be generated and can be fixed by using xScale.domain([x0,x1]) function with
    // 2 days before now as x0 and 30 minutes from now for x1 for context plot, but this will be
    // required to happen when 'now' event is sent from websocket.js every minute.  When fixed,
    // remove this code and all references to `type: 'server-forecast'`
    var last = _.findLast(client.data, {type: 'sgv'});
    var lastTime = last && last.mills;
    if (!lastTime) {
      console.error('Bad Data, last point has no mills', last);
      lastTime = Date.now();
    }

    var n = Math.ceil(12 * (1 / 2 + (now - lastTime) / times.mins(60).msecs)) + 1;
    for (var i = 1; i <= n; i++) {
      client.data.push({
        mills: lastTime + (i * times.mins(5).msecs), mgdl: 100, color: 'none', type: 'server-forecast'
      });
    }
  }

// clears the current user brush and resets to the current real time data
  function updateBrushToNow(skipBrushing) {

    // get current time range
    var dataRange = d3.extent(client.data, dateFn);

    // update brush and focus chart with recent data
    d3.select('.brush')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .call(client.brush.extent([new Date(dataRange[1].getTime() - client.foucusRangeMS), dataRange[1]]));

    addPlaceholderPoints();

    if (!skipBrushing) {
      brushed(true);

      // clear user brush tracking
      brushInProgress = false;
    }
  }

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

  function alarmingNow() {
    return container.hasClass('alarming');
  }

  function inRetroMode() {
    if (!client.brush) {
      return false;
    }

    var time = client.brush.extent()[1].getTime();

    return !alarmingNow() && time - times.mins(25).msecs < now;
  }

  function brushed(skipTimer) {

    if (!skipTimer) {
      // set a timer to reset focus chart to real-time data
      clearTimeout(brushTimer);
      brushTimer = setTimeout(updateBrushToNow, BRUSH_TIMEOUT);
      brushInProgress = true;
    }

    var brushExtent = client.brush.extent();

    // ensure that brush extent is fixed at 3.5 hours
    if (brushExtent[1].getTime() - brushExtent[0].getTime() !== client.foucusRangeMS) {
      // ensure that brush updating is with the time range
      if (brushExtent[0].getTime() + client.foucusRangeMS > d3.extent(client.data, dateFn)[1].getTime()) {
        brushExtent[0] = new Date(brushExtent[1].getTime() - client.foucusRangeMS);
        d3.select('.brush')
          .call(client.brush.extent([brushExtent[0], brushExtent[1]]));
      } else {
        brushExtent[1] = new Date(brushExtent[0].getTime() + client.foucusRangeMS);
        d3.select('.brush')
          .call(client.brush.extent([brushExtent[0], brushExtent[1]]));
      }
    }

    var nowDate = new Date(brushExtent[1] - times.mins(30).msecs);

    function updateCurrentSGV(entry) {
      var value = entry.mgdl
        , ago = timeAgo(entry.mills)
        , isCurrent = ago.status === 'current';

      if (value === 9) {
        currentBG.text('');
      } else if (value < 39) {
        currentBG.html(client.errorcodes.toDisplay(value));
      } else if (value < 40) {
        currentBG.text('LOW');
      } else if (value > 400) {
        currentBG.text('HIGH');
      } else {
        currentBG.text(scaleBg(value));
      }

      bgStatus.toggleClass('current', alarmingNow() || (isCurrent && !inRetroMode()));
      if (!alarmingNow()) {
        container.removeClass('urgent warning inrange');
        if (isCurrent && !inRetroMode()) {
          container.addClass(sgvToColoredRange(value));
        }
      }

      currentBG.toggleClass('icon-hourglass', value === 9);
      currentBG.toggleClass('error-code', value < 39);
      currentBG.toggleClass('bg-limit', value === 39 || value > 400);

      container.removeClass('loading');
    }

    function updatePlugins (sgvs, time) {
      var pluginBase = plugins.base(majorPills, minorPills, statusPills, bgStatus, client.tooltip);

      client.sbx = sandbox.clientInit(
        client.settings
        , new Date(time).getTime() //make sure we send a timestamp
        , pluginBase, {
        sgvs: sgvs
        , cals: [cal]
        , treatments: treatments
        , profile: Nightscout.profile
        , uploaderBattery: devicestatusData && devicestatusData.uploaderBattery
      });

      //all enabled plugins get a chance to set properties, even if they aren't shown
      plugins.setProperties(client.sbx);

      //only shown plugins get a chance to update visualisations
      plugins.updateVisualisations(client.sbx);
    }

    var nowData = client.data.filter(function(d) {
      return d.type === 'sgv';
    });

    if (inRetroMode()) {
      var retroTime = brushExtent[1].getTime() - times.mins(30).msecs;

      nowData = nowData.filter(function(d) {
        return d.mills >= brushExtent[1].getTime() - (2 * times.mins(30).msecs) &&
          d.mills <= brushExtent[1].getTime() - times.mins(25).msecs;
      });

      // sometimes nowData contains duplicates.  uniq it.
      var lastDate = 0;
      nowData = nowData.filter(function(d) {
        var ok = lastDate + times.min().msecs < d.mills;
        lastDate = d.mills;
        return ok;
      });

      var focusPoint = nowData.length > 0 ? nowData[nowData.length - 1] : null;
      if (focusPoint) {
        updateCurrentSGV(focusPoint);
      } else {
        currentBG.text('---');
        container.removeClass('urgent warning inrange');
      }

      updatePlugins(nowData, retroTime);

      $('#currentTime')
        .text(formatTime(new Date(retroTime), true))
        .css('text-decoration','line-through');

      updateTimeAgo();
    } else {
      // if the brush comes back into the current time range then it should reset to the current time and sg
      nowData = nowData.slice(nowData.length - 2, nowData.length);
      nowDate = now;

      updateCurrentSGV(client.latestSGV);
      updateClockDisplay();
      updateTimeAgo();
      updatePlugins(nowData, nowDate);

    }

    client.xScale.domain(client.brush.extent());

    renderer.addFocusCircles();

    // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
    d3.selectAll('.path').remove();

    // add treatment bubbles
    client.focus.selectAll('circle')
      .data(treatments)
      .each(function (d) { renderer.drawTreatment(d, renderer.bubbleScale(), true) });

    // transition open-top line to correct location
    client.focus.select('.open-top')
      .attr('x1', client.xScale2(client.brush.extent()[0]))
      .attr('y1', client.yScale(scaleBg(30)))
      .attr('x2', client.xScale2(client.brush.extent()[1]))
      .attr('y2', client.yScale(scaleBg(30)));

    // transition open-left line to correct location
    client.focus.select('.open-left')
      .attr('x1', client.xScale2(client.brush.extent()[0]))
      .attr('y1', focusHeight)
      .attr('x2', client.xScale2(client.brush.extent()[0]))
      .attr('y2', prevChartHeight);

    // transition open-right line to correct location
    client.focus.select('.open-right')
      .attr('x1', client.xScale2(client.brush.extent()[1]))
      .attr('y1', focusHeight)
      .attr('x2', client.xScale2(client.brush.extent()[1]))
      .attr('y2', prevChartHeight);

    client.focus.select('.now-line')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .attr('x1', client.xScale(nowDate))
      .attr('y1', client.yScale(scaleBg(36)))
      .attr('x2', client.xScale(nowDate))
      .attr('y2', client.yScale(scaleBg(420)));

    client.context.select('.now-line')
      .transition()
      .attr('x1', client.xScale2(client.brush.extent()[1]- times.mins(30).msecs))
      .attr('y1', client.yScale2(scaleBg(36)))
      .attr('x2', client.xScale2(client.brush.extent()[1]- times.mins(30).msecs))
      .attr('y2', client.yScale2(scaleBg(420)));

    // update x axis
    client.focus.select('.x.axis').call(client.xAxis);

    renderer.addTreatmentCircles();

  }

// called for initial update and updates for resize
  var updateChart = _.debounce(function debouncedUpdateChart(init) {

    if (documentHidden && !init) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }
    // get current data range
    var dataRange = d3.extent(client.data, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = (document.getElementById('chartContainer')
      .getBoundingClientRect().width) - padding.left - padding.right;

    var chartHeight = (document.getElementById('chartContainer')
      .getBoundingClientRect().height) - padding.top - padding.bottom;

    // get the height of each chart based on its container size ratio
    focusHeight = chartHeight * .7;
    contextHeight = chartHeight * .2;

    // get current brush extent
    var currentBrushExtent = client.brush.extent();

    // only redraw chart if chart size has changed
    if ((prevChartWidth !== chartWidth) || (prevChartHeight !== chartHeight)) {

      prevChartWidth = chartWidth;
      prevChartHeight = chartHeight;

      //set the width and height of the SVG element
      charts.attr('width', chartWidth + padding.left + padding.right)
        .attr('height', chartHeight + padding.top + padding.bottom);

      // ranges are based on the width and height available so reset
      client.xScale.range([0, chartWidth]);
      client.xScale2.range([0, chartWidth]);
      client.yScale.range([focusHeight, 0]);
      client.yScale2.range([chartHeight, chartHeight - contextHeight]);

      if (init) {

        // if first run then just display axis with no transition
        client.focus.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(client.xAxis);

        client.focus.select('.y')
          .attr('transform', 'translate(' + chartWidth + ',0)')
          .call(client.yAxis);

        // if first run then just display axis with no transition
        client.context.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(client.xAxis2);

        client.context.append('g')
          .attr('class', 'x brush')
          .call(d3.svg.brush().x(client.xScale2).on('brush', brushed))
          .selectAll('rect')
          .attr('y', focusHeight)
          .attr('height', chartHeight - focusHeight);

        // disable resizing of brush
        d3.select('.x.brush').select('.background').style('cursor', 'move');
        d3.select('.x.brush').select('.resize.e').style('cursor', 'move');
        d3.select('.x.brush').select('.resize.w').style('cursor', 'move');

        // create a clipPath for when brushing
        clip = charts.append('defs')
          .append('clipPath')
          .attr('id', 'clip')
          .append('rect')
          .attr('height', chartHeight)
          .attr('width', chartWidth);

        // add a line that marks the current time
        client.focus.append('line')
          .attr('class', 'now-line')
          .attr('x1', client.xScale(new Date(now)))
          .attr('y1', client.yScale(scaleBg(30)))
          .attr('x2', client.xScale(new Date(now)))
          .attr('y2', client.yScale(scaleBg(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        client.focus.append('line')
          .attr('class', 'high-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that shows the high bg threshold
        client.focus.append('line')
          .attr('class', 'target-top-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        client.focus.append('line')
          .attr('class', 'target-bottom-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        client.focus.append('line')
          .attr('class', 'low-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgLow)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgLow)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that opens up the brush extent from the context to the focus
        client.focus.append('line')
          .attr('class', 'open-top')
          .attr('stroke', 'black')
          .attr('stroke-width', 2);

        // add a x-axis line that closes the the brush container on left side
        client.focus.append('line')
          .attr('class', 'open-left')
          .attr('stroke', 'white');

        // add a x-axis line that closes the the brush container on right side
        client.focus.append('line')
          .attr('class', 'open-right')
          .attr('stroke', 'white');

        // add a line that marks the current time
        client.context.append('line')
          .attr('class', 'now-line')
          .attr('x1', client.xScale(new Date(now)))
          .attr('y1', client.yScale2(scaleBg(36)))
          .attr('x2', client.xScale(new Date(now)))
          .attr('y2', client.yScale2(scaleBg(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        client.context.append('line')
          .attr('class', 'high-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        client.context.append('line')
          .attr('class', 'low-line')
          .attr('x1', client.xScale(dataRange[0]))
          .attr('y1', client.yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', client.xScale(dataRange[1]))
          .attr('y2', client.yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

      } else {

        // for subsequent updates use a transition to animate the axis to the new position
        var focusTransition = client.focus.transition().duration(UPDATE_TRANS_MS);

        focusTransition.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(client.xAxis);

        focusTransition.select('.y')
          .attr('transform', 'translate(' + chartWidth + ', 0)')
          .call(client.yAxis);

        var contextTransition = client.context.transition().duration(UPDATE_TRANS_MS);

        contextTransition.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(client.xAxis2);

        if (clip) {
          // reset clip to new dimensions
          clip.transition()
            .attr('width', chartWidth)
            .attr('height', chartHeight);
        }

        // reset brush location
        client.context.select('.x.brush')
          .selectAll('rect')
          .attr('y', focusHeight)
          .attr('height', chartHeight - focusHeight);

        // clear current brush
        d3.select('.brush').call(client.brush.clear());

        // redraw old brush with new dimensions
        d3.select('.brush').transition().duration(UPDATE_TRANS_MS).call(client.brush.extent(currentBrushExtent));

        // transition lines to correct location
        client.focus.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale(currentBrushExtent[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .attr('x2', client.xScale(currentBrushExtent[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgHigh)));

        client.focus.select('.target-top-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale(currentBrushExtent[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', client.xScale(currentBrushExtent[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgTargetTop)));

        client.focus.select('.target-bottom-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale(currentBrushExtent[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', client.xScale(currentBrushExtent[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgTargetBottom)));

        client.focus.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale(currentBrushExtent[0]))
          .attr('y1', client.yScale(scaleBg(client.settings.thresholds.bgLow)))
          .attr('x2', client.xScale(currentBrushExtent[1]))
          .attr('y2', client.yScale(scaleBg(client.settings.thresholds.bgLow)));

        // transition open-top line to correct location
        client.focus.select('.open-top')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale2(currentBrushExtent[0]))
          .attr('y1', client.yScale(scaleBg(30)))
          .attr('x2', client.xScale2(currentBrushExtent[1]))
          .attr('y2', client.yScale(scaleBg(30)));

        // transition open-left line to correct location
        client.focus.select('.open-left')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale2(currentBrushExtent[0]))
          .attr('y1', focusHeight)
          .attr('x2', client.xScale2(currentBrushExtent[0]))
          .attr('y2', chartHeight);

        // transition open-right line to correct location
        client.focus.select('.open-right')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale2(currentBrushExtent[1]))
          .attr('y1', focusHeight)
          .attr('x2', client.xScale2(currentBrushExtent[1]))
          .attr('y2', chartHeight);

        // transition high line to correct location
        client.context.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale2(dataRange[0]))
          .attr('y1', client.yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', client.xScale2(dataRange[1]))
          .attr('y2', client.yScale2(scaleBg(client.settings.thresholds.bgTargetTop)));

        // transition low line to correct location
        client.context.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', client.xScale2(dataRange[0]))
          .attr('y1', client.yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', client.xScale2(dataRange[1]))
          .attr('y2', client.yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)));
      }
    }

    // update domain
    client.xScale2.domain(dataRange);

    // only if a user brush is not active, update brush and focus chart with recent data
    // else, just transition brush
    var updateBrush = d3.select('.brush').transition().duration(UPDATE_TRANS_MS);
    if (!brushInProgress) {
      updateBrush
        .call(client.brush.extent([new Date(dataRange[1].getTime() - client.foucusRangeMS), dataRange[1]]));
      brushed(true);
    } else {
      updateBrush
        .call(client.brush.extent([new Date(currentBrushExtent[1].getTime() - client.foucusRangeMS), currentBrushExtent[1]]));
      brushed(true);
    }

    renderer.addContextCircles();

    // update x axis domain
    client.context.select('.x').call(client.xAxis2);

  }, DEBOUNCE_MS);

  function sgvToColor(sgv) {
    var color = 'grey';

    if (client.settings.theme === 'colors') {
      if (sgv > client.settings.thresholds.bgHigh) {
        color = 'red';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        color = 'yellow';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop) {
        color = '#4cff00';
      } else if (sgv < client.settings.thresholds.bgLow) {
        color = 'red';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        color = 'yellow';
      }
    }

    return color;
  }

  function sgvToColoredRange(sgv) {
    var range = '';

    if (client.settings.theme === 'colors') {
      if (sgv > client.settings.thresholds.bgHigh) {
        range = 'urgent';
      } else if (sgv > client.settings.thresholds.bgTargetTop) {
        range = 'warning';
      } else if (sgv >= client.settings.thresholds.bgTargetBottom && sgv <= client.settings.thresholds.bgTargetTop) {
        range = 'inrange';
      } else if (sgv < client.settings.thresholds.bgLow) {
        range = 'urgent';
      } else if (sgv < client.settings.thresholds.bgTargetBottom) {
        range = 'warning';
      }
    }

    return range;
  }

  function generateAlarm(file, reason) {
    alarmInProgress = true;
    alarmMessage = reason && reason.title;
    var selector = '.audio.alarms audio.' + file;

    if (!alarmingNow()) {
      d3.select(selector).each(function () {
        var audio = this;
        playAlarm(audio);
        $(this).addClass('playing');
      });
    }

    container.addClass('alarming').addClass(file === urgentAlarmSound ? 'urgent' : 'warning');

    updateTitle();
  }

  function playAlarm(audio) {
    // ?mute=true disables alarms to testers.
    if (querystring.mute !== 'true') {
      audio.play();
    } else {
      showNotification('Alarm was muted (?mute=true)');
    }
  }

  function stopAlarm(isClient, silenceTime) {
    alarmInProgress = false;
    alarmMessage = null;
    container.removeClass('urgent warning');
    d3.selectAll('audio.playing').each(function () {
      var audio = this;
      audio.pause();
      $(this).removeClass('playing');
    });

    closeNotification();
    container.removeClass('alarming');

    updateTitle();

    // only emit ack if client invoke by button press
    if (isClient) {
      if (isTimeAgoAlarmType(currentAlarmType)) {
        container.removeClass('alarming-timeago');
        var alarm = getClientAlarm(currentAlarmType);
        alarm.lastAckTime = Date.now();
        alarm.silenceTime = silenceTime;
      }
      socket.emit('ack', currentAlarmType || 'alarm', silenceTime);
    }

    brushed(false);
  }

  function updateClock() {
    updateClockDisplay();
    var interval = (60 - (new Date()).getSeconds()) * 1000 + 5;
    setTimeout(updateClock,interval);

    updateTimeAgo();

    // Dim the screen by reducing the opacity when at nighttime
    if (client.settings.nightMode) {
      var dateTime = new Date();
      if (opacity.current !== opacity.NIGHT && (dateTime.getHours() > 21 || dateTime.getHours() < 7)) {
        $('body').css({ 'opacity': opacity.NIGHT });
      } else {
        $('body').css({ 'opacity': opacity.DAY });
      }
    }
  }

  function updateClockDisplay() {
    if (inRetroMode()) {
      return;
    }
    now = Date.now();
    $('#currentTime').text(formatTime(new Date(now), true)).css('text-decoration', '');
  }

  function getClientAlarm(type) {
    var alarm = clientAlarms[type];
    if (!alarm) {
      alarm = { type: type };
      clientAlarms[type] = alarm;
    }
    return alarm;
  }

  function isTimeAgoAlarmType(alarmType) {
    return alarmType === 'warnTimeAgo' || alarmType === 'urgentTimeAgo';
  }

  function isStale (ago) {
    return client.settings.alarmTimeagoWarn && ago.status === 'warn'
      || client.settings.alarmTimeagoUrgent && ago.status === 'urgent';
  }

  function notAcked (alarm) {
    return Date.now() >= (alarm.lastAckTime || 0) + (alarm.silenceTime || 0);
  }

  function checkTimeAgoAlarm(ago) {
    var level = ago.status
      , alarm = getClientAlarm(level + 'TimeAgo');

    if (isStale(ago) && notAcked(alarm)) {
      currentAlarmType = alarm.type;
      console.info('generating timeAgoAlarm', alarm.type);
      container.addClass('alarming-timeago');
      var message = {'title': 'Last data received ' + [ago.value, ago.label].join(' ')};
      var sound = level === 'warn' ? alarmSound : urgentAlarmSound;
      generateAlarm(sound, message);
    }

    container.toggleClass('alarming-timeago', ago.status !== 'current');

    if (alarmingNow() && ago.status === 'current' && isTimeAgoAlarmType(currentAlarmType)) {
      stopAlarm(true, times.min().msecs);
    }
  }

  function updateTimeAgo() {
    var lastEntry = $('#lastEntry')
      , time = client.latestSGV ? client.latestSGV.mills : -1
      , ago = timeAgo(time)
      , retroMode = inRetroMode();

    function updateTimeAgoPill() {
      if (retroMode || !ago.value) {
        lastEntry.find('em').hide();
      } else {
        lastEntry.find('em').show().text(ago.value);
      }
      if (retroMode || ago.label) {
        lastEntry.find('label').show().text(retroMode ? 'RETRO' : ago.label);
      } else {
        lastEntry.find('label').hide();
      }
    }

    lastEntry.removeClass('current warn urgent');
    lastEntry.addClass(ago.status);

    if (ago.status !== 'current') {
      updateTitle();
    }
    checkTimeAgoAlarm(ago);

    updateTimeAgoPill();
  }

  // Tick Values
  if (client.settings.units === 'mmol') {
    tickValues = [
      2.0
      , Math.round(scaleBg(client.settings.thresholds.bgLow))
      , Math.round(scaleBg(client.settings.thresholds.bgTargetBottom))
      , 6.0
      , Math.round(scaleBg(client.settings.thresholds.bgTargetTop))
      , Math.round(scaleBg(client.settings.thresholds.bgHigh))
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

  client.futureOpacity = d3.scale.linear( )
    .domain([times.mins(25).msecs, times.mins(60).msecs])
    .range([0.8, 0.1]);

  // create svg and g to contain the chart contents
  charts = d3.select('#chartContainer').append('svg')
    .append('g')
    .attr('class', 'chartContainer')
    .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')');

  client.focus = charts.append('g');

  // create the x axis container
  client.focus.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  client.focus.append('g')
    .attr('class', 'y axis');

  client.context = charts.append('g');

  // create the x axis container
  client.context.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  client.context.append('g')
    .attr('class', 'y axis');

  function updateTimeAgoSoon() {
    setTimeout(function updatingTimeAgoNow() {
      updateTimeAgo();
    }, times.secs(10).msecs);
  }

  function refreshChart(updateToNow) {
    if (updateToNow) {
      updateBrushToNow();
    }
    updateChart(false);
    updateTimeAgoSoon();
  }

  (function watchVisibility ( ) {
    // Set the name of the hidden property and the change event for visibility
    var hidden, visibilityChange;
    if (typeof document.hidden !== 'undefined') {
      hidden = 'hidden';
      visibilityChange = 'visibilitychange';
    } else if (typeof document.mozHidden !== 'undefined') {
      hidden = 'mozHidden';
      visibilityChange = 'mozvisibilitychange';
    } else if (typeof document.msHidden !== 'undefined') {
      hidden = 'msHidden';
      visibilityChange = 'msvisibilitychange';
    } else if (typeof document.webkitHidden !== 'undefined') {
      hidden = 'webkitHidden';
      visibilityChange = 'webkitvisibilitychange';
    }

    document.addEventListener(visibilityChange, function visibilityChanged ( ) {
      var prevHidden = documentHidden;
      documentHidden = document[hidden];

      if (prevHidden && !documentHidden) {
        console.info('Document now visible, updating - ' + new Date());
        refreshChart(true);
      }
    });
  })();

  window.onresize = refreshChart;

  updateClock();
  updateTimeAgoSoon();


  function Dropdown(el) {
    this.ddmenuitem = 0;

    this.$el = $(el);
    var that = this;

    $(document).click(function() { that.close(); });
  }
  Dropdown.prototype.close = function () {
    if (this.ddmenuitem) {
      this.ddmenuitem.css('visibility', 'hidden');
      this.ddmenuitem = 0;
    }
  };
  Dropdown.prototype.open = function (e) {
    this.close();
    this.ddmenuitem = $(this.$el).css('visibility', 'visible');
    e.stopPropagation();
  };

  var silenceDropdown = new Dropdown('.dropdown-menu');

  $('.bgButton').click(function (e) {
    if (alarmingNow()) {
      silenceDropdown.open(e);
    }
  });

  $('#silenceBtn').find('a').click(function (e) {
    stopAlarm(true, $(this).data('snooze-time'));
    e.preventDefault();
  });

  $('.focus-range li').click(function(e) {
    var li = $(e.target);
    $('.focus-range li').removeClass('selected');
    li.addClass('selected');
    var hours = Number(li.data('hours'));
    client.foucusRangeMS = times.hours(hours).msecs + times.mins(30).msecs;
    refreshChart();
  });

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Client-side code to connect to server and handle incoming data
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  socket = io.connect();

  function mergeDataUpdate(isDelta, cachedDataArray, receivedDataArray) {

    function nsArrayDiff(oldArray, newArray) {
      var seen = {};
      var l = oldArray.length;
      for (var i = 0; i < l; i++) { seen[oldArray[i].mills] = true }
      var result = [];
      l = newArray.length;
      for (var j = 0; j < l; j++) { if (!seen.hasOwnProperty(newArray[j].mills)) { result.push(newArray[j]); console.log('delta data found'); } }
      return result;
    }

    // If there was no delta data, just return the original data
    if (!receivedDataArray) {
      return cachedDataArray;
    }

    // If this is not a delta update, replace all data
    if (!isDelta) {
      return receivedDataArray;
    }

    // If this is delta, calculate the difference, merge and sort
    var diff = nsArrayDiff(cachedDataArray,receivedDataArray);
    return cachedDataArray.concat(diff).sort(function(a, b) {
      return a.mills - b.mills;
    });
  }

  socket.on('dataUpdate', function receivedSGV(d) {

    if (!d) {
      return;
    }

    // Calculate the diff to existing data and replace as needed

    SGVdata = mergeDataUpdate(d.delta, SGVdata, d.sgvs);
    MBGdata = mergeDataUpdate(d.delta,MBGdata, d.mbgs);
    treatments = mergeDataUpdate(d.delta,treatments, d.treatments);

    if (d.profiles) {
      Nightscout.profile.loadData(d.profiles);
    }

    if (d.cals) { cal = d.cals[d.cals.length-1]; }
    if (d.devicestatus) { devicestatusData = d.devicestatus; }

    // Do some reporting on the console
    console.log('Total SGV data size', SGVdata.length);
    console.log('Total treatment data size', treatments.length);

    // Post processing after data is in

    if (d.sgvs) {
      // change the next line so that it uses the prediction if the signal gets lost (max 1/2 hr)
      latestUpdateTime = Date.now();
      client.latestSGV = SGVdata[SGVdata.length - 1];
      prevSGV = SGVdata[SGVdata.length - 2];
    }

    var temp1 = [ ];
    if (cal && client.rawbg.isEnabled(client.sbx)) {
      temp1 = SGVdata.map(function (entry) {
        var rawbgValue = client.rawbg.showRawBGs(entry.mgdl, entry.noise, cal, client.sbx) ? client.rawbg.calc(entry, cal, client.sbx) : 0;
        if (rawbgValue > 0) {
          return { mills: entry.mills - 2000, mgdl: rawbgValue, color: 'white', type: 'rawbg' };
        } else {
          return null;
        }
      }).filter(function(entry) { return entry !== null; });
    }
    var temp2 = SGVdata.map(function (obj) {
      return { mills: obj.mills, mgdl: obj.mgdl, direction: obj.direction, color: sgvToColor(obj.mgdl), type: 'sgv', noise: obj.noise, filtered: obj.filtered, unfiltered: obj.unfiltered};
    });
    client.data = [];
    client.data = client.data.concat(temp1, temp2);

    addPlaceholderPoints();

    client.data = client.data.concat(MBGdata.map(function (obj) { return { mills: obj.mills, mgdl: obj.mgdl, color: 'red', type: 'mbg', device: obj.device } }));

    client.data.forEach(function (d) {
      if (d.mgdl < 39) { d.color = 'transparent'; }
    });

    updateTitle();
    if (!isInitialData) {
      isInitialData = true;
      initializeCharts();
    }
    else {
      updateChart(false);
    }

  });

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Alarms and Text handling
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  socket.on('connect', function () {
    console.log('Client connected to server.');
  });


  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a HIGH we can only check if it's >= the bottom of the target
  function isAlarmForHigh() {
    return client.latestSGV.mgdl >= client.settings.thresholds.bgTargetBottom;
  }

  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a LOW we can only check if it's <= the top of the target
  function isAlarmForLow() {
    return client.latestSGV.mgdl <= client.settings.thresholds.bgTargetTop;
  }

  socket.on('announcement', function (notify) {
    console.info('announcement received from server');
    console.log('notify:',notify);
    currentAnnouncement = notify;
    currentAnnouncement.received = Date.now();
    updateTitle();
  });

  socket.on('alarm', function (notify) {
    console.info('alarm received from server');
    console.log('notify:',notify);
    var enabled = (isAlarmForHigh() && client.settings.alarmHigh) || (isAlarmForLow() && client.settings.alarmLow);
    if (enabled) {
      console.log('Alarm raised!');
      currentAlarmType = 'alarm';
      generateAlarm(alarmSound,notify);
    } else {
      console.info('alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    brushInProgress = false;
    updateChart(false);
  });

  socket.on('urgent_alarm', function (notify) {
    console.info('urgent alarm received from server');
    console.log('notify:',notify);

    var enabled = (isAlarmForHigh() && client.settings.alarmUrgentHigh) || (isAlarmForLow() && client.settings.alarmUrgentLow);
    if (enabled) {
      console.log('Urgent alarm raised!');
      currentAlarmType = 'urgent_alarm';
      generateAlarm(urgentAlarmSound,notify);
    } else {
      console.info('urgent alarm was disabled locally', client.latestSGV.mgdl, client.settings);
    }
    brushInProgress = false;
    updateChart(false);
  });

  socket.on('clear_alarm', function () {
    if (alarmInProgress) {
      console.log('clearing alarm');
      stopAlarm();
    }
  });

  $('#testAlarms').click(function(event) {
    d3.selectAll('.audio.alarms audio').each(function () {
      var audio = this;
      playAlarm(audio);
      setTimeout(function() {
        audio.pause();
      }, 4000);
    });
    event.preventDefault();
  });

  $('.appName').text(serverSettings.name);
  $('.version').text(serverSettings.version);
  $('.head').text(serverSettings.head);
  if (serverSettings.apiEnabled) {
    $('.serverSettings').show();
  }
  $('#treatmentDrawerToggle').toggle(serverSettings.careportalEnabled);
  container.toggleClass('has-minor-pills', plugins.hasShownType('pill-minor', client.settings));

};

module.exports = client;