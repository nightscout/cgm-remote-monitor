'use strict';

var $ = (global && global.$) || require('jquery');
var _ = require('lodash');
var d3 = (global && global.d3) || require('d3');

var language = require('../language')();
var profile = require('../profilefunctions')();
var sandbox = require('../sandbox')();
var units = require('../units')();
var times = require('../times');

var client = { };

client.init = function init(serverSettings, plugins) {

  client.settings = require('./browser-settings')(serverSettings, plugins);
  client.utils = require('../utils')(client.settings);

  var translate = language.translate;

  var BRUSH_TIMEOUT = times.mins(5).msecs
    , DEBOUNCE_MS = 10
    , TOOLTIP_TRANS_MS = 200 // milliseconds
    , UPDATE_TRANS_MS = 750 // milliseconds
    , FORMAT_TIME_12 = '%-I:%M %p'
    , FORMAT_TIME_12_COMAPCT = '%-I:%M'
    , FORMAT_TIME_24 = '%H:%M%'
    , FORMAT_TIME_12_SCALE = '%-I %p'
    , FORMAT_TIME_24_SCALE = '%H'
    , WIDTH_SMALL_DOTS = 400
    , WIDTH_BIG_DOTS = 800;

  var socket
    , isInitialData = false
    , SGVdata = []
    , MBGdata = []
    , latestSGV
    , latestUpdateTime
    , prevSGV
    , treatments
    , cal
    , devicestatusData
    , padding = { top: 0, right: 10, bottom: 30, left: 10 }
    , opacity = {current: 1, DAY: 1, NIGHT: 0.5}
    , now = Date.now()
    , data = []
    , foucusRangeMS = times.hours(3).msecs
    , clientAlarms = {}
    , alarmInProgress = false
    , alarmMessage
    , currentAlarmType = null
    , currentAnnouncement
    , alarmSound = 'alarm.mp3'
    , urgentAlarmSound = 'alarm2.mp3';

  var sbx
    , rawbg = plugins('rawbg')
    , delta = plugins('delta')
    , direction = plugins('direction')
    , errorcodes = plugins('errorcodes')
    , timeAgo = client.utils.timeAgo;

  var tooltip
    , tickValues
    , charts
    , futureOpacity
    , focus
    , context
    , xScale, xScale2, yScale, yScale2
    , xAxis, yAxis, xAxis2, yAxis2
    , prevChartWidth = 0
    , prevChartHeight = 0
    , focusHeight
    , contextHeight
    , dateFn = function (d) { return new Date(d.mills) }
    , documentHidden = false
    , brush
    , brushTimer
    , brushInProgress = false
    , clip;

  var container = $('.container')
    , bgStatus = $('.bgStatus')
    , currentBG = $('.bgStatus .currentBG')
    , majorPills = $('.bgStatus .majorPills')
    , minorPills = $('.bgStatus .minorPills')
    , statusPills = $('.status .statusPills')
    ;

  language.set(client.settings.language).DOMtranslate();

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

    var time = latestSGV ? latestSGV.mills : (prevSGV ? prevSGV.mills : -1)
      , ago = timeAgo(time);

    if (ago && ago.status !== 'current') {
      title =  s(ago.value) + s(ago.label, ' - ') + title;
    } else if (latestSGV) {
      var currentMgdl = latestSGV.mgdl;

      if (currentMgdl < 39) {
        title = s(errorcodes.toDisplay(currentMgdl), ' - ') + title;
      } else {
        var deltaDisplay = delta.calc(prevSGV, latestSGV, sbx).display;
        title = s(scaleBg(currentMgdl)) + s(deltaDisplay) + s(direction.info(latestSGV).label) + title;
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
    xScale = d3.time.scale()
      .domain(d3.extent(data, dateFn));

    yScale = d3.scale.log()
      .domain([scaleBg(30), scaleBg(510)]);

    xScale2 = d3.time.scale()
      .domain(d3.extent(data, dateFn));

    yScale2 = d3.scale.log()
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

    xAxis = d3.svg.axis()
      .scale(xScale)
      .tickFormat(tickFormat)
      .ticks(4)
      .orient('bottom');

    yAxis = d3.svg.axis()
      .scale(yScale)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues)
      .orient('left');

    xAxis2 = d3.svg.axis()
      .scale(xScale2)
      .tickFormat(tickFormat)
      .ticks(6)
      .orient('bottom');

    yAxis2 = d3.svg.axis()
      .scale(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues)
      .orient('right');

    // setup a brush
    brush = d3.svg.brush()
      .x(xScale2)
      .on('brushstart', brushStarted)
      .on('brush', brushed)
      .on('brushend', brushEnded);

    updateChart(true);
  }

// get the desired opacity for context chart based on the brush extent
  function highlightBrushPoints(data) {
    if (data.mills >= brush.extent()[0].getTime() && data.mills <= brush.extent()[1].getTime()) {
      return futureOpacity(data.mills - latestSGV.mills);
    } else {
      return 0.5;
    }
  }

  function addPlaceholderPoints () {
    // TODO: This is a kludge to advance the time as data becomes stale by making old predictor clear (using color = 'none')
    // This shouldn't need to be generated and can be fixed by using xScale.domain([x0,x1]) function with
    // 2 days before now as x0 and 30 minutes from now for x1 for context plot, but this will be
    // required to happen when 'now' event is sent from websocket.js every minute.  When fixed,
    // remove this code and all references to `type: 'server-forecast'`
    var last = _.findLast(data, {type: 'sgv'});
    var lastTime = last && last.mills;
    if (!lastTime) {
      console.error('Bad Data, last point has no mills', last);
      lastTime = Date.now();
    }

    var n = Math.ceil(12 * (1 / 2 + (now - lastTime) / times.mins(60).msecs)) + 1;
    for (var i = 1; i <= n; i++) {
      data.push({
        mills: lastTime + (i * times.mins(5).msecs), mgdl: 100, color: 'none', type: 'server-forecast'
      });
    }
  }

// clears the current user brush and resets to the current real time data
  function updateBrushToNow(skipBrushing) {

    // get current time range
    var dataRange = d3.extent(data, dateFn);

    // update brush and focus chart with recent data
    d3.select('.brush')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .call(brush.extent([new Date(dataRange[1].getTime() - foucusRangeMS), dataRange[1]]));

    addPlaceholderPoints();

    if (!skipBrushing) {
      brushed(true);

      // clear user brush tracking
      brushInProgress = false;
    }
  }

  function brushStarted() {
    // update the opacity of the context data points to brush extent
    context.selectAll('circle')
      .data(data)
      .style('opacity', 1);
  }

  function brushEnded() {
    // update the opacity of the context data points to brush extent
    context.selectAll('circle')
      .data(data)
      .style('opacity', function (d) { return highlightBrushPoints(d) });
  }

  function alarmingNow() {
    return container.hasClass('alarming');
  }

  function inRetroMode() {
    if (!brush) {
      return false;
    }

    var time = brush.extent()[1].getTime();

    return !alarmingNow() && time - times.mins(25).msecs < now;
  }

  function brushed(skipTimer) {

    if (!skipTimer) {
      // set a timer to reset focus chart to real-time data
      clearTimeout(brushTimer);
      brushTimer = setTimeout(updateBrushToNow, BRUSH_TIMEOUT);
      brushInProgress = true;
    }

    var brushExtent = brush.extent();

    // ensure that brush extent is fixed at 3.5 hours
    if (brushExtent[1].getTime() - brushExtent[0].getTime() !== foucusRangeMS) {
      // ensure that brush updating is with the time range
      if (brushExtent[0].getTime() + foucusRangeMS > d3.extent(data, dateFn)[1].getTime()) {
        brushExtent[0] = new Date(brushExtent[1].getTime() - foucusRangeMS);
        d3.select('.brush')
          .call(brush.extent([brushExtent[0], brushExtent[1]]));
      } else {
        brushExtent[1] = new Date(brushExtent[0].getTime() + foucusRangeMS);
        d3.select('.brush')
          .call(brush.extent([brushExtent[0], brushExtent[1]]));
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
        currentBG.html(errorcodes.toDisplay(value));
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

      $('.container').removeClass('loading');

    }

    function updatePlugins (sgvs, time) {

      var pluginBase = plugins.base(majorPills, minorPills, statusPills, bgStatus, tooltip);

      sbx = sandbox.clientInit(
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
      plugins.setProperties(sbx);

      //only shown plugins get a chance to update visualisations
      plugins.updateVisualisations(sbx);
    }

    var nowData = data.filter(function(d) {
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

      updateCurrentSGV(latestSGV);
      updateClockDisplay();
      updateTimeAgo();
      updatePlugins(nowData, nowDate);

    }

    xScale.domain(brush.extent());

    // get slice of data so that concatenation of predictions do not interfere with subsequent updates
    var focusData = data.slice();

    if (sbx.pluginBase.forecastPoints) {
      focusData = focusData.concat(sbx.pluginBase.forecastPoints);
    }

    // bind up the focus chart data to an array of circles
    // selects all our data into data and uses date function to get current max date
    var focusCircles = focus.selectAll('circle').data(focusData, dateFn);

    var DEFAULT_FOCUS = times.hours(3).msecs;
    var focusRangeAdjustment = foucusRangeMS === DEFAULT_FOCUS ? 1 : 1 + ((foucusRangeMS - DEFAULT_FOCUS) / DEFAULT_FOCUS / 8);

    var dotRadius = function(type) {
      var radius = prevChartWidth > WIDTH_BIG_DOTS ? 4 : (prevChartWidth < WIDTH_SMALL_DOTS ? 2 : 3);
      if (type === 'mbg') {
        radius *= 2;
      } else if (type === 'forecast') {
        radius = Math.min(3, radius - 1);
      } else if (type === 'rawbg') {
        radius = Math.min(2, radius - 1);
      }

      return radius / focusRangeAdjustment;
    };

    function isDexcom(device) {
      return device && device.toLowerCase().indexOf('dexcom') === 0;
    }

    function prepareFocusCircles(sel) {
      var badData = [];
      sel.attr('cx', function (d) {
        if (!d) {
          console.error('Bad data', d);
          return xScale(new Date(0));
        } else if (!d.mills) {
          console.error('Bad data, no mills', d);
          return xScale(new Date(0));
        } else {
          return xScale(new Date(d.mills));
        }
      })
        .attr('cy', function (d) {
          var scaled = sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return yScale(scaleBg(450));
          } else {
            return yScale(scaled);
          }
        })
        .attr('fill', function (d) { return d.type === 'forecast' ? 'none' : d.color; })
        .attr('opacity', function (d) { return futureOpacity(d.mills - latestSGV.mills); })
        .attr('stroke-width', function (d) { return d.type === 'mbg' ? 2 : d.type === 'forecast' ? 1 : 0; })
        .attr('stroke', function (d) {
          return (isDexcom(d.device) ? 'white' : d.type === 'forecast' ? d.color : '#0099ff');
        })
        .attr('r', function (d) { return dotRadius(d.type); });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    // if already existing then transition each circle to its new position
    prepareFocusCircles(focusCircles.transition().duration(UPDATE_TRANS_MS));

    // if new circle then just display
    prepareFocusCircles(focusCircles.enter().append('circle'))
      .on('mouseover', function (d) {
        if (d.type === 'sgv' || d.type === 'mbg') {
          var bgType = (d.type === 'sgv' ? 'CGM' : (isDexcom(d.device) ? 'Calibration' : 'Meter'))
            , rawbgValue = 0
            , noiseLabel = '';

          if (d.type === 'sgv') {
            if (rawbg.showRawBGs(d.mgdl, d.noise, cal, sbx)) {
              rawbgValue = scaleBg(rawbg.calc(d, cal, sbx));
            }
            noiseLabel = rawbg.noiseCodeToDisplay(d.mgdl, d.noise);
          }

          tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
          tooltip.html('<strong>' + bgType + ' BG:</strong> ' + sbx.scaleEntry(d) +
            (d.type === 'mbg' ? '<br/><strong>Device: </strong>' + d.device : '') +
            (rawbgValue ? '<br/><strong>Raw BG:</strong> ' + rawbgValue : '') +
            (noiseLabel ? '<br/><strong>Noise:</strong> ' + noiseLabel : '') +
            '<br/><strong>Time:</strong> ' + formatTime(new Date(d.mills)))
            .style('left', (d3.event.pageX) + 'px')
            .style('top', (d3.event.pageY + 15) + 'px');
        }
      })
      .on('mouseout', function (d) {
        if (d.type === 'sgv' || d.type === 'mbg') {
          tooltip.transition()
            .duration(TOOLTIP_TRANS_MS)
            .style('opacity', 0);
        }
      });

    focusCircles.exit()
      .remove();

    // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
    d3.selectAll('.path').remove();

    // add treatment bubbles
    // a higher bubbleScale will produce smaller bubbles (it's not a radius like focusDotRadius)
    var bubbleScale = (prevChartWidth < WIDTH_SMALL_DOTS ? 4 : (prevChartWidth < WIDTH_BIG_DOTS ? 3 : 2)) * focusRangeAdjustment;

    focus.selectAll('circle')
      .data(treatments)
      .each(function (d) { drawTreatment(d, bubbleScale, true) });

    // transition open-top line to correct location
    focus.select('.open-top')
      .attr('x1', xScale2(brush.extent()[0]))
      .attr('y1', yScale(scaleBg(30)))
      .attr('x2', xScale2(brush.extent()[1]))
      .attr('y2', yScale(scaleBg(30)));

    // transition open-left line to correct location
    focus.select('.open-left')
      .attr('x1', xScale2(brush.extent()[0]))
      .attr('y1', focusHeight)
      .attr('x2', xScale2(brush.extent()[0]))
      .attr('y2', prevChartHeight);

    // transition open-right line to correct location
    focus.select('.open-right')
      .attr('x1', xScale2(brush.extent()[1]))
      .attr('y1', focusHeight)
      .attr('x2', xScale2(brush.extent()[1]))
      .attr('y2', prevChartHeight);

    focus.select('.now-line')
      .transition()
      .duration(UPDATE_TRANS_MS)
      .attr('x1', xScale(nowDate))
      .attr('y1', yScale(scaleBg(36)))
      .attr('x2', xScale(nowDate))
      .attr('y2', yScale(scaleBg(420)));

    context.select('.now-line')
      .transition()
      .attr('x1', xScale2(brush.extent()[1]- times.mins(30).msecs))
      .attr('y1', yScale2(scaleBg(36)))
      .attr('x2', xScale2(brush.extent()[1]- times.mins(30).msecs))
      .attr('y2', yScale2(scaleBg(420)));

    // update x axis
    focus.select('.x.axis')
      .call(xAxis);

    // add clipping path so that data stays within axis
    focusCircles.attr('clip-path', 'url(#clip)');

    function prepareTreatCircles(sel) {
      function strokeColor (d) {
        var color = 'white';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'grey';
        }
        return color;
      }

      function fillColor (d) {
        var color ='grey';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'red';
        }
        return color;
      }

      sel.attr('cx', function (d) { return xScale(new Date(d.mills)); })
        .attr('cy', function (d) { return yScale(sbx.scaleEntry(d)); })
        .attr('r', function () { return dotRadius('mbg'); })
        .attr('stroke-width', 2)
        .attr('stroke', strokeColor)
        .attr('fill', fillColor);

      return sel;
    }

    function treatmentTooltip (d) {
      return '<strong>'+translate('Time')+':</strong> ' + formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Treatment type')+':</strong> ' + d.eventType + '<br/>' : '') +
        (d.glucose ? '<strong>'+translate('BG')+':</strong> ' + d.glucose + (d.glucoseType ? ' (' + translate(d.glucoseType) + ')': '') + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered by')+':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.notes ? '<strong>'+translate('Notes')+':</strong> ' + d.notes : '');
    }

    function announcementTooltip (d) {
      return '<strong>'+translate('Time')+':</strong> ' + formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Announcement')+'</strong><br/>' : '') +
        (d.notes && d.notes.length > 1 ? '<strong>'+translate('Message')+':</strong> ' + d.notes + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered by')+':</strong> ' + d.enteredBy + '<br/>' : '');
    }

    //NOTE: treatments with insulin or carbs are drawn by drawTreatment()
    // bind up the focus chart data to an array of circles
    var treatCircles = focus.selectAll('rect').data(treatments.filter(function(treatment) {
      return !treatment.carbs && !treatment.insulin;
    }));

    // if already existing then transition each circle to its new position
    prepareTreatCircles(treatCircles.transition().duration(UPDATE_TRANS_MS));

    // if new circle then just display
    prepareTreatCircles(treatCircles.enter().append('circle'))
      .on('mouseover', function (d) {
        tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
        tooltip.html(d.isAnnouncement ? announcementTooltip(d) : treatmentTooltip(d))
          .style('left', (d3.event.pageX) + 'px')
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', function () {
        tooltip.transition()
          .duration(TOOLTIP_TRANS_MS)
          .style('opacity', 0);
      });

    treatCircles.attr('clip-path', 'url(#clip)');
  }

// called for initial update and updates for resize
  var updateChart = _.debounce(function debouncedUpdateChart(init) {

    if (documentHidden && !init) {
      console.info('Document Hidden, not updating - ' + (new Date()));
      return;
    }
    // get current data range
    var dataRange = d3.extent(data, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = (document.getElementById('chartContainer')
      .getBoundingClientRect().width) - padding.left - padding.right;

    var chartHeight = (document.getElementById('chartContainer')
      .getBoundingClientRect().height) - padding.top - padding.bottom;

    // get the height of each chart based on its container size ratio
    focusHeight = chartHeight * .7;
    contextHeight = chartHeight * .2;

    // get current brush extent
    var currentBrushExtent = brush.extent();

    // only redraw chart if chart size has changed
    if ((prevChartWidth !== chartWidth) || (prevChartHeight !== chartHeight)) {

      prevChartWidth = chartWidth;
      prevChartHeight = chartHeight;

      //set the width and height of the SVG element
      charts.attr('width', chartWidth + padding.left + padding.right)
        .attr('height', chartHeight + padding.top + padding.bottom);

      // ranges are based on the width and height available so reset
      xScale.range([0, chartWidth]);
      xScale2.range([0, chartWidth]);
      yScale.range([focusHeight, 0]);
      yScale2.range([chartHeight, chartHeight - contextHeight]);

      if (init) {

        // if first run then just display axis with no transition
        focus.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(xAxis);

        focus.select('.y')
          .attr('transform', 'translate(' + chartWidth + ',0)')
          .call(yAxis);

        // if first run then just display axis with no transition
        context.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(xAxis2);

        context.append('g')
          .attr('class', 'x brush')
          .call(d3.svg.brush().x(xScale2).on('brush', brushed))
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
        focus.append('line')
          .attr('class', 'now-line')
          .attr('x1', xScale(new Date(now)))
          .attr('y1', yScale(scaleBg(30)))
          .attr('x2', xScale(new Date(now)))
          .attr('y2', yScale(scaleBg(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        focus.append('line')
          .attr('class', 'high-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that shows the high bg threshold
        focus.append('line')
          .attr('class', 'target-top-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        focus.append('line')
          .attr('class', 'target-bottom-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        focus.append('line')
          .attr('class', 'low-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgLow)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgLow)))
          .style('stroke-dasharray', ('1, 6'))
          .attr('stroke', '#777');

        // add a y-axis line that opens up the brush extent from the context to the focus
        focus.append('line')
          .attr('class', 'open-top')
          .attr('stroke', 'black')
          .attr('stroke-width', 2);

        // add a x-axis line that closes the the brush container on left side
        focus.append('line')
          .attr('class', 'open-left')
          .attr('stroke', 'white');

        // add a x-axis line that closes the the brush container on right side
        focus.append('line')
          .attr('class', 'open-right')
          .attr('stroke', 'white');

        // add a line that marks the current time
        context.append('line')
          .attr('class', 'now-line')
          .attr('x1', xScale(new Date(now)))
          .attr('y1', yScale2(scaleBg(36)))
          .attr('x2', xScale(new Date(now)))
          .attr('y2', yScale2(scaleBg(420)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the high bg threshold
        context.append('line')
          .attr('class', 'high-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

        // add a y-axis line that shows the low bg threshold
        context.append('line')
          .attr('class', 'low-line')
          .attr('x1', xScale(dataRange[0]))
          .attr('y1', yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', xScale(dataRange[1]))
          .attr('y2', yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .style('stroke-dasharray', ('3, 3'))
          .attr('stroke', 'grey');

      } else {

        // for subsequent updates use a transition to animate the axis to the new position
        var focusTransition = focus.transition().duration(UPDATE_TRANS_MS);

        focusTransition.select('.x')
          .attr('transform', 'translate(0,' + focusHeight + ')')
          .call(xAxis);

        focusTransition.select('.y')
          .attr('transform', 'translate(' + chartWidth + ', 0)')
          .call(yAxis);

        var contextTransition = context.transition().duration(UPDATE_TRANS_MS);

        contextTransition.select('.x')
          .attr('transform', 'translate(0,' + chartHeight + ')')
          .call(xAxis2);

        if (clip) {
          // reset clip to new dimensions
          clip.transition()
            .attr('width', chartWidth)
            .attr('height', chartHeight);
        }

        // reset brush location
        context.select('.x.brush')
          .selectAll('rect')
          .attr('y', focusHeight)
          .attr('height', chartHeight - focusHeight);

        // clear current brush
        d3.select('.brush').call(brush.clear());

        // redraw old brush with new dimensions
        d3.select('.brush').transition().duration(UPDATE_TRANS_MS).call(brush.extent(currentBrushExtent));

        // transition lines to correct location
        focus.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale(currentBrushExtent[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgHigh)))
          .attr('x2', xScale(currentBrushExtent[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgHigh)));

        focus.select('.target-top-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale(currentBrushExtent[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', xScale(currentBrushExtent[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgTargetTop)));

        focus.select('.target-bottom-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale(currentBrushExtent[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', xScale(currentBrushExtent[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgTargetBottom)));

        focus.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale(currentBrushExtent[0]))
          .attr('y1', yScale(scaleBg(client.settings.thresholds.bgLow)))
          .attr('x2', xScale(currentBrushExtent[1]))
          .attr('y2', yScale(scaleBg(client.settings.thresholds.bgLow)));

        // transition open-top line to correct location
        focus.select('.open-top')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale2(currentBrushExtent[0]))
          .attr('y1', yScale(scaleBg(30)))
          .attr('x2', xScale2(currentBrushExtent[1]))
          .attr('y2', yScale(scaleBg(30)));

        // transition open-left line to correct location
        focus.select('.open-left')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale2(currentBrushExtent[0]))
          .attr('y1', focusHeight)
          .attr('x2', xScale2(currentBrushExtent[0]))
          .attr('y2', chartHeight);

        // transition open-right line to correct location
        focus.select('.open-right')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale2(currentBrushExtent[1]))
          .attr('y1', focusHeight)
          .attr('x2', xScale2(currentBrushExtent[1]))
          .attr('y2', chartHeight);

        // transition high line to correct location
        context.select('.high-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale2(dataRange[0]))
          .attr('y1', yScale2(scaleBg(client.settings.thresholds.bgTargetTop)))
          .attr('x2', xScale2(dataRange[1]))
          .attr('y2', yScale2(scaleBg(client.settings.thresholds.bgTargetTop)));

        // transition low line to correct location
        context.select('.low-line')
          .transition()
          .duration(UPDATE_TRANS_MS)
          .attr('x1', xScale2(dataRange[0]))
          .attr('y1', yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)))
          .attr('x2', xScale2(dataRange[1]))
          .attr('y2', yScale2(scaleBg(client.settings.thresholds.bgTargetBottom)));
      }
    }

    // update domain
    xScale2.domain(dataRange);

    // only if a user brush is not active, update brush and focus chart with recent data
    // else, just transition brush
    var updateBrush = d3.select('.brush').transition().duration(UPDATE_TRANS_MS);
    if (!brushInProgress) {
      updateBrush
        .call(brush.extent([new Date(dataRange[1].getTime() - foucusRangeMS), dataRange[1]]));
      brushed(true);
    } else {
      updateBrush
        .call(brush.extent([new Date(currentBrushExtent[1].getTime() - foucusRangeMS), currentBrushExtent[1]]));
      brushed(true);
    }

    // bind up the context chart data to an array of circles
    var contextCircles = context.selectAll('circle')
      .data(data);

    function prepareContextCircles(sel) {
      var badData = [];
      sel.attr('cx', function (d) { return xScale2(new Date(d.mills)); })
        .attr('cy', function (d) {
          var scaled = sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return yScale2(scaleBg(450));
          } else {
            return yScale2(scaled);
          }
        })
        .attr('fill', function (d) { return d.color; })
        .style('opacity', function (d) { return highlightBrushPoints(d) })
        .attr('stroke-width', function (d) { return d.type === 'mbg' ? 2 : 0; })
        .attr('stroke', function ( ) { return 'white'; })
        .attr('r', function (d) { return d.type === 'mbg' ? 4 : 2; });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    // if already existing then transition each circle to its new position
    prepareContextCircles(contextCircles.transition().duration(UPDATE_TRANS_MS));

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit()
      .remove();

    // update x axis domain
    context.select('.x')
      .call(xAxis2);

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

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//draw a compact visualization of a treatment (carbs, insulin)
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  function drawTreatment(treatment, scale, showValues) {

    if (!treatment.carbs && !treatment.insulin) { return; }

    // don't render the treatment if it's not visible
    if (Math.abs(xScale(new Date(treatment.mills))) > window.innerWidth) { return; }

    var CR = treatment.CR || 20;
    var carbs = treatment.carbs || CR;
    var insulin = treatment.insulin || 1;

    var R1 = Math.sqrt(Math.min(carbs, insulin * CR)) / scale,
      R2 = Math.sqrt(Math.max(carbs, insulin * CR)) / scale,
      R3 = R2 + 8 / scale;

    if (isNaN(R1) || isNaN(R3) || isNaN(R3)) {
      console.warn('Bad Data: Found isNaN value in treatment', treatment);
      return;
    }

    var arc_data = [
      { 'element': '', 'color': 'white', 'start': -1.5708, 'end': 1.5708, 'inner': 0, 'outer': R1 },
      { 'element': '', 'color': 'transparent', 'start': -1.5708, 'end': 1.5708, 'inner': R2, 'outer': R3 },
      { 'element': '', 'color': '#0099ff', 'start': 1.5708, 'end': 4.7124, 'inner': 0, 'outer': R1 },
      { 'element': '', 'color': 'transparent', 'start': 1.5708, 'end': 4.7124, 'inner': R2, 'outer': R3 }
    ];

    arc_data[0].outlineOnly = !treatment.carbs;
    arc_data[2].outlineOnly = !treatment.insulin;

    if (treatment.carbs > 0) {
      arc_data[1].element = Math.round(treatment.carbs) + ' g';
    }

    if (treatment.insulin > 0) {
      arc_data[3].element = Math.round(treatment.insulin * 100) / 100 + ' U';
    }

    var arc = d3.svg.arc()
      .innerRadius(function (d) { return 5 * d.inner; })
      .outerRadius(function (d) { return 5 * d.outer; })
      .endAngle(function (d) { return d.start; })
      .startAngle(function (d) { return d.end; });

    var treatmentDots = focus.selectAll('treatment-dot')
      .data(arc_data)
      .enter()
      .append('g')
      .attr('transform', 'translate(' + xScale(new Date(treatment.mills)) + ', ' + yScale(sbx.scaleEntry(treatment)) + ')')
      .on('mouseover', function () {
        tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
        tooltip.html('<strong>'+translate('Time')+':</strong> ' + formatTime(new Date(treatment.mills)) + '<br/>' + '<strong>'+translate('Treatment type')+':</strong> ' + translate(treatment.eventType) + '<br/>' +
            (treatment.carbs ? '<strong>'+translate('Carbs')+':</strong> ' + treatment.carbs + '<br/>' : '') +
            (treatment.insulin ? '<strong>'+translate('Insulin')+':</strong> ' + treatment.insulin + '<br/>' : '') +
            (treatment.glucose ? '<strong>'+translate('BG')+':</strong> ' + treatment.glucose + (treatment.glucoseType ? ' (' + translate(treatment.glucoseType) + ')': '') + '<br/>' : '') +
            (treatment.enteredBy ? '<strong>'+translate('Entered by')+':</strong> ' + treatment.enteredBy + '<br/>' : '') +
            (treatment.notes ? '<strong>'+translate('Notes')+':</strong> ' + treatment.notes : '')
        )
          .style('left', (d3.event.pageX) + 'px')
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', function () {
        tooltip.transition()
          .duration(TOOLTIP_TRANS_MS)
          .style('opacity', 0);
      });

    treatmentDots.append('path')
      .attr('class', 'path')
      .attr('fill', function (d) { return d.outlineOnly ? 'transparent' : d.color; })
      .attr('stroke-width', function (d) { return d.outlineOnly ? 1 : 0; })
      .attr('stroke', function (d) { return d.color; })
      .attr('id', function (d, i) { return 's' + i; })
      .attr('d', arc);


    // labels for carbs and insulin
    if (showValues) {
      var label = treatmentDots.append('g')
        .attr('class', 'path')
        .attr('id', 'label')
        .style('fill', 'white');
      label.append('text')
        .style('font-size', 40 / scale)
        .style('text-shadow', '0px 0px 10px rgba(0, 0, 0, 1)')
        .attr('text-anchor', 'middle')
        .attr('dy', '.35em')
        .attr('transform', function (d) {
          d.outerRadius = d.outerRadius * 2.1;
          d.innerRadius = d.outerRadius * 2.1;
          return 'translate(' + arc.centroid(d) + ')';
        })
        .text(function (d) { return d.element; });
    }
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
      , time = latestSGV ? latestSGV.mills : -1
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

  tooltip = d3.select('body').append('div')
    .attr('class', 'tooltip')
    .style('opacity', 0);

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

  futureOpacity = d3.scale.linear( )
    .domain([times.mins(25).msecs, times.mins(60).msecs])
    .range([0.8, 0.1]);

  // create svg and g to contain the chart contents
  charts = d3.select('#chartContainer').append('svg')
    .append('g')
    .attr('class', 'chartContainer')
    .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')');

  focus = charts.append('g');

  // create the x axis container
  focus.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  focus.append('g')
    .attr('class', 'y axis');

  context = charts.append('g');

  // create the x axis container
  context.append('g')
    .attr('class', 'x axis');

  // create the y axis container
  context.append('g')
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
    foucusRangeMS = times.hours(hours).msecs + times.mins(30).msecs;
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
      latestSGV = SGVdata[SGVdata.length - 1];
      prevSGV = SGVdata[SGVdata.length - 2];
    }

    var temp1 = [ ];
    if (cal && rawbg.isEnabled(sbx)) {
      temp1 = SGVdata.map(function (entry) {
        var rawbgValue = rawbg.showRawBGs(entry.mgdl, entry.noise, cal, sbx) ? rawbg.calc(entry, cal, sbx) : 0;
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
    data = [];
    data = data.concat(temp1, temp2);

    addPlaceholderPoints();

    data = data.concat(MBGdata.map(function (obj) { return { mills: obj.mills, mgdl: obj.mgdl, color: 'red', type: 'mbg', device: obj.device } }));

    data.forEach(function (d) {
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
    return latestSGV.mgdl >= client.settings.thresholds.bgTargetBottom;
  }

  //with predicted alarms, latestSGV may still be in target so to see if the alarm
  //  is for a LOW we can only check if it's <= the top of the target
  function isAlarmForLow() {
    return latestSGV.mgdl <= client.settings.thresholds.bgTargetTop;
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
      console.info('alarm was disabled locally', latestSGV.mgdl, client.settings);
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
      console.info('urgent alarm was disabled locally', latestSGV.mgdl, client.settings);
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

  if (client.settings.enable.indexOf('ar2') < 0) {
    client.settings.enable += ' ar2';
  }

  $('.appName').text(serverSettings.name);
  $('.version').text(serverSettings.version);
  $('.head').text(serverSettings.head);
  if (serverSettings.apiEnabled) {
    $('.serverSettings').show();
  }
  $('#treatmentDrawerToggle').toggle(serverSettings.careportalEnabled);
  plugins.init(client.settings);
  sbx = sandbox.clientInit(client.settings, Date.now());
  $('.container').toggleClass('has-minor-pills', plugins.hasShownType('pill-minor', client.settings));

};

module.exports = client;