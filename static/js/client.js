//TODO: clean up
var app = {}, browserSettings = {}, browserStorage = $.localStorage;

(function () {
    "use strict";

    var BRUSH_TIMEOUT = 300000 // 5 minutes in ms
        , UPDATE_TRANS_MS = 750 // milliseconds
        , ONE_MIN_IN_MS = 60000
        , FIVE_MINS_IN_MS = 300000
        , TWENTY_FIVE_MINS_IN_MS = 1500000
        , THIRTY_MINS_IN_MS = 1800000
        , SIXTY_MINS_IN_MS = 3600000
        , FOCUS_DATA_RANGE_MS = 12600000 // 3.5 hours of actual data
        , FORMAT_TIME_12 = '%I:%M'
        , FORMAT_TIME_24 = '%H:%M%'
        , FORMAT_TIME_SCALE = '%I %p'
        , WIDTH_TIME_HIDDEN = 500
        , MINUTES_SINCE_LAST_UPDATE_WARN = 10
        , MINUTES_SINCE_LAST_UPDATE_URGENT = 20;

    var socket
        , isInitialData = false
        , latestSGV
        , prevSGV
        , errorCode
        , treatments
        , padding = { top: 20, right: 10, bottom: 30, left: 10 }
        , opacity = {current: 1, DAY: 1, NIGHT: 0.5}
        , now = Date.now()
        , data = []
        , audio = document.getElementById('audio')
        , alarmInProgress = false
        , currentAlarmType = null
        , alarmSound = 'alarm.mp3'
        , urgentAlarmSound = 'alarm2.mp3';

    var tickValues
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
        , dateFn = function (d) { return new Date(d.date) }
        , brush
        , brushTimer
        , brushInProgress = false
        , clip;

    function formatTime(time) {
        var timeFormat = getTimeFormat();
        time = d3.time.format(timeFormat)(time);
        if(timeFormat == FORMAT_TIME_12){
            time = time.replace(/^0/, '').toLowerCase();
        }
      return time;
    }

    function getTimeFormat(isForScale) {
        var timeFormat = FORMAT_TIME_12;
        if (browserSettings.timeFormat) {
            if (browserSettings.timeFormat == "24") {
                timeFormat = FORMAT_TIME_24;
            }
        }

        if (isForScale && (timeFormat == FORMAT_TIME_12)) {
            timeFormat = FORMAT_TIME_SCALE
        }

        return timeFormat;
    }

    var x2TickFormat = d3.time.format.multi([
        [".%L", function(d) { return d.getMilliseconds(); }],
        [":%S", function(d) { return d.getSeconds(); }],
        ["%I:%M", function(d) { return d.getMinutes(); }],
        [(getTimeFormat() == FORMAT_TIME_12) ? "%I %p": '%H:%M%', function(d) { return d.getHours(); }],
        ["%a %d", function(d) { return d.getDay() && d.getDate() != 1; }],
        ["%b %d", function(d) { return d.getDate() != 1; }],
        ["%B", function(d) { return d.getMonth(); }],
        ["%Y", function() { return true; }]
    ]);


  // lixgbg: Convert mg/dL BG value to metric mmol
    function scaleBg(bg) {
        if (browserSettings.units == "mmol") {
            return (Math.round((bg / 18) * 10) / 10).toFixed(1);
        } else {
            return bg;
        }
    }
    // initial setup of chart when data is first made available
    function initializeCharts() {

        // define the parts of the axis that aren't dependent on width or height
        xScale = d3.time.scale()
            .domain(d3.extent(data, function (d) { return d.date; }));

        yScale = d3.scale.log()
            .domain([scaleBg(30), scaleBg(510)]);

        xScale2 = d3.time.scale()
            .domain(d3.extent(data, function (d) { return d.date; }));

        yScale2 = d3.scale.log()
            .domain([scaleBg(36), scaleBg(420)]);

        xAxis = d3.svg.axis()
            .scale(xScale)
            .tickFormat(d3.time.format(getTimeFormat(true)))
            .ticks(4)
            .orient('top');

        yAxis = d3.svg.axis()
            .scale(yScale)
            .tickFormat(d3.format('d'))
            .tickValues(tickValues)
            .orient('left');

      xAxis2 = d3.svg.axis()
          .scale(xScale2)
          .tickFormat(x2TickFormat)
          .ticks(4)
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
        if (data.date.getTime() >= brush.extent()[0].getTime() && data.date.getTime() <= brush.extent()[1].getTime()) {
            return futureOpacity(data.date.getTime() - latestSGV.x);
        } else {
            return 0.5;
        }
    }

    // clears the current user brush and resets to the current real time data
    function updateBrushToNow() {

        // get current time range
        var dataRange = d3.extent(data, dateFn);

        // update brush and focus chart with recent data
        d3.select('.brush')
            .transition()
            .duration(UPDATE_TRANS_MS)
            .call(brush.extent([new Date(dataRange[1].getTime() - FOCUS_DATA_RANGE_MS), dataRange[1]]));
        brushed(true);

        // clear user brush tracking
        brushInProgress = false;
    }

    function brushStarted() {
        // update the opacity of the context data points to brush extent
        context.selectAll('circle')
            .data(data)
            .style('opacity', function (d) { return 1; });
    }

    function brushEnded() {
        // update the opacity of the context data points to brush extent
        context.selectAll('circle')
            .data(data)
            .style('opacity', function (d) { return highlightBrushPoints(d) });
    }

    // function to call when context chart is brushed
    function brushed(skipTimer) {

        if (!skipTimer) {
            // set a timer to reset focus chart to real-time data
            clearTimeout(brushTimer);
            brushTimer = setTimeout(updateBrushToNow, BRUSH_TIMEOUT);
            brushInProgress = true;
        }

        var brushExtent = brush.extent();

        // ensure that brush extent is fixed at 3.5 hours
        if (brushExtent[1].getTime() - brushExtent[0].getTime() != FOCUS_DATA_RANGE_MS) {

            // ensure that brush updating is with the time range
            if (brushExtent[0].getTime() + FOCUS_DATA_RANGE_MS > d3.extent(data, dateFn)[1].getTime()) {
                brushExtent[0] = new Date(brushExtent[1].getTime() - FOCUS_DATA_RANGE_MS);
                d3.select('.brush')
                    .call(brush.extent([brushExtent[0], brushExtent[1]]));
            } else {
                brushExtent[1] = new Date(brushExtent[0].getTime() + FOCUS_DATA_RANGE_MS);
                d3.select('.brush')
                    .call(brush.extent([brushExtent[0], brushExtent[1]]));
            }
        }

        // get slice of data so that concatenation of predictions do not interfere with subsequent updates
        var focusData = data.slice();

        if (alarmInProgress) {
            if ($(window).width() > WIDTH_TIME_HIDDEN) {
                $(".time").show();
            } else {
                $(".time").hide();
            }
        }

        var element = document.getElementById('bgButton').hidden == '';
        var nowDate = new Date(brushExtent[1] - THIRTY_MINS_IN_MS);

        // predict for retrospective data
        // by changing lookback from 1 to 2, we modify the AR algorithm to determine its initial slope from 10m
        // of data instead of 5, which eliminates the incorrect and misleading predictions generated when
        // the dexcom switches from unfiltered to filtered at the start of a rapid rise or fall, while preserving
        // almost identical predications at other times.
        var lookback = 2;
        if (brushExtent[1].getTime() - THIRTY_MINS_IN_MS < now && element != true) {
            // filter data for -12 and +5 minutes from reference time for retrospective focus data prediction
            var lookbackTime = (lookback+2)*FIVE_MINS_IN_MS + 2*ONE_MIN_IN_MS;
            var nowDataRaw = data.filter(function(d) {
                return d.date.getTime() >= brushExtent[1].getTime() - TWENTY_FIVE_MINS_IN_MS - lookbackTime &&
                    d.date.getTime() <= brushExtent[1].getTime() - TWENTY_FIVE_MINS_IN_MS &&
                    d.type == 'sgv';
            });
            // sometimes nowDataRaw contains duplicates.  uniq it.
            var lastDate = new Date("1/1/1970");
            var nowData = nowDataRaw.filter(function(n) {
                if ( (lastDate.getTime() + ONE_MIN_IN_MS) < n.date.getTime()) {
                    lastDate = n.date;
                    return n;
                }
            });
            if (nowData.length > lookback) {
                var prediction = predictAR(nowData, lookback);
                focusData = focusData.concat(prediction);
                var focusPoint = nowData[nowData.length - 1];
                var prevfocusPoint = nowData[nowData.length - 2];

                //in this case the SGV is scaled
                if (focusPoint.y < 40)
                    $('.container .currentBG').text('LOW');
                else if (focusPoint.y > 400)
                    $('.container .currentBG').text('HIGH');
                else
                    $('.container .currentBG').text(focusPoint.sgv);
                    var retroDelta = scaleBg(focusPoint.y) - scaleBg(prevfocusPoint.y);
                    if (browserSettings.units == "mmol") {
                        retroDelta = retroDelta.toFixed(1);
                    }
                    if (retroDelta < 0) {
                        var retroDeltaString = retroDelta;
                    }
                    else {
                        var retroDeltaString = "+" + retroDelta;
                    }
                    if (browserSettings.units == "mmol") {
                    var retroDeltaString = retroDeltaString + " mmol/L"
                    }
                    else {
                    var retroDeltaString = retroDeltaString + " mg/dL"
                    }

                $('.container .currentBG').css('text-decoration','line-through');
                $('.container .currentDelta')
                    .text(retroDeltaString)
                    .css('text-decoration','line-through');
                $('.container .currentDirection').html(focusPoint.direction)
            } else {
                $('.container .currentBG')
                    .text("---")
                    .css('text-decoration','');
                $('.container .currentDelta').text('');
            }
            $('#currentTime')
                .text(formatTime(new Date(brushExtent[1] - THIRTY_MINS_IN_MS)))
                .css('text-decoration','line-through');

            $('#lastEntry').text("RETRO").removeClass('current');

            $('.container #noButton .currentBG').css({color: 'grey'});
            $('.container #noButton .currentDelta').css({color: 'grey'});
            $('.container #noButton .currentDirection').css({color: 'grey'});

        } else {
            // if the brush comes back into the current time range then it should reset to the current time and sg
            var nowData = data.filter(function(d) {
                return d.type == 'sgv';
            });
            var x=lookback+1;
            nowData = nowData.slice(nowData.length-x, nowData.length);
            //nowData = [nowData[nowData.length - lookback-1], nowData[nowData.length - 1]];
            var prediction = predictAR(nowData, lookback);
            focusData = focusData.concat(prediction);
            var dateTime = new Date(now);
            nowDate = dateTime;
            $('#currentTime')
                .text(formatTime(dateTime))
                .css('text-decoration', '');

            if (errorCode) {
                var errorDisplay;

                switch (parseInt(errorCode)) {
                    case 0:  errorDisplay = '??0'; break; //None
                    case 1:  errorDisplay = '?SN'; break; //SENSOR_NOT_ACTIVE
                    case 2:  errorDisplay = '??2'; break; //MINIMAL_DEVIATION
                    case 3:  errorDisplay = '?NA'; break; //NO_ANTENNA
                    case 5:  errorDisplay = '?NC'; break; //SENSOR_NOT_CALIBRATED
                    case 6:  errorDisplay = '?CD'; break; //COUNTS_DEVIATION
                    case 7:  errorDisplay = '??7'; break; //?
                    case 8:  errorDisplay = '??8'; break; //?
                    case 9:  errorDisplay = '&#8987;'; break; //ABSOLUTE_DEVIATION
                    case 10: errorDisplay = '???'; break; //POWER_DEVIATION
                    case 12: errorDisplay = '?RF'; break; //BAD_RF
                    default: errorDisplay = '?' + parseInt(errorCode) + '?'; break;
                }

                $('#lastEntry').text("CGM ERROR").removeClass('current').addClass("urgent");

                $('.container .currentBG').html(errorDisplay)
                    .css('text-decoration', '');
                $('.container .currentDelta').text('')
                    .css('text-decoration','');
                $('.container .currentDirection').html('✖');

                var color = sgvToColor(errorCode);
                $('.container #noButton .currentBG').css({color: color});
                $('.container #noButton .currentDirection').css({color: color});

            } else {

                var secsSinceLast = (Date.now() - new Date(latestSGV.x).getTime()) / 1000;
                $('#lastEntry').text(timeAgo(secsSinceLast)).toggleClass('current', secsSinceLast < 10 * 60);

                //in this case the SGV is unscaled
                if (latestSGV.y < 40)
                    $('.container .currentBG').text('LOW');
                else if (latestSGV.y > 400)
                    $('.container .currentBG').text('HIGH');
                else
                    $('.container .currentBG').text(scaleBg(latestSGV.y));
		            var bgDelta = scaleBg(latestSGV.y) - scaleBg(prevSGV.y);
                    if (browserSettings.units == "mmol") {
                        bgDelta = bgDelta.toFixed(1);
                    }
                    if (bgDelta < 0) {
                        var bgDeltaString = bgDelta;
                    }
		            else {
			            var bgDeltaString = "+" + bgDelta;
		            }
                    if (browserSettings.units == "mmol") {
                        var bgDeltaString = bgDeltaString + " mmol/L"
                    }
                    else {
                        var bgDeltaString = bgDeltaString + " mg/dL"
                    }

                $('.container .currentBG').css('text-decoration', '');
                $('.container .currentDelta')
                    .text(bgDeltaString)
                    .css('text-decoration','');
                $('.container .currentDirection').html(latestSGV.direction);

                var color = sgvToColor(latestSGV.y);
                $('.container #noButton .currentBG').css({color: color});
                $('.container #noButton .currentDirection').css({color: color});

                // bgDelta and retroDelta to follow sgv color
                // instead of Scott Leibrand's wip/iob-cob settings below

                // var deltaColor = deltaToColor(bgDelta);
                // $('.container #noButton .currentDelta').css({color: deltaColor});

                $('.container #noButton .currentDelta').css({color: color});
            }
        }

        xScale.domain(brush.extent());

        // bind up the focus chart data to an array of circles
        // selects all our data into data and uses date function to get current max date
        var focusCircles = focus.selectAll('circle').data(focusData, dateFn);

        // if already existing then transition each circle to its new position
        focusCircles
            .transition()
            .duration(UPDATE_TRANS_MS)
            .attr('cx', function (d) { return xScale(d.date); })
            .attr('cy', function (d) { return yScale(d.sgv); })
            .attr('fill', function (d) { return d.color; })
            .attr('opacity', function (d) { return futureOpacity(d.date.getTime() - latestSGV.x); });

        // if new circle then just display
        focusCircles.enter().append('circle')
            .attr('cx', function (d) { return xScale(d.date); })
            .attr('cy', function (d) { return yScale(d.sgv); })
            .attr('fill', function (d) { return d.color; })
            .attr('opacity', function (d) { return futureOpacity(d.date.getTime() - latestSGV.x); })
            .attr('stroke-width', function (d) {if (d.type == 'mbg') return 2; else return 0; })
            .attr('stroke', function (d) { return "white"; })
            .attr('r', function(d) { if (d.type == 'mbg') return 6; else return 3;});

        focusCircles.exit()
            .remove();

        // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
        d3.selectAll('.path').remove();

        // add treatment bubbles
        //
        //var bubbleSize = prevChartWidth < 400 ? 4 : (prevChartWidth < 600 ? 3 : 2);
        //focus.selectAll('circle')
        //    .data(treatments)
        //    .each(function (d) { drawTreatment(d, bubbleSize, true) });

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

        // update x axis
        focus.select('.x.axis')
            .call(xAxis);

        // add clipping path so that data stays within axis
        focusCircles.attr('clip-path', 'url(#clip)');

        try {
            // bind up the focus chart data to an array of circles
            var treatCircles = focus.selectAll('rect').data(treatments);

            // if already existing then transition each circle to its new position
            treatCircles.transition()
                  .duration(UPDATE_TRANS_MS)
                  .attr('x', function (d) { return xScale(new Date(d.created_at)); })
                  .attr('y', function (d) { return yScale(scaleBg(500)); })
                  .attr("width", 15)
                  .attr("height", 15)
                  .attr("rx", 6)
                  .attr("ry", 6)
                  .attr('stroke-width', 2)
                  .attr('stroke', function (d) { return "white"; })
                  .attr('fill', function (d) { return "grey"; });


            // if new circle then just display
            treatCircles.enter().append('rect')
                  .attr('x', function (d) { return xScale(d.created_at); })
                  .attr('y', function (d) { return yScale(scaleBg(500)); })
                  .attr("width", 15)
                  .attr("height", 15)
                  .attr("rx", 6)
                  .attr("ry", 6)
                  .attr('stroke-width', 2)
                  .attr('stroke', function (d) { return "white"; })
                  .attr('fill', function (d) { return "grey"; })
                  .on("mouseover", function (d) {
                      div.transition().duration(200).style("opacity", .9);
                      div.html("<strong>Time:</strong> " + formatTime(d.created_at) + "<br/>" + "<strong>Treatment type:</strong> " + d.eventType + "<br/>" +
                          (d.carbs ? "<strong>Carbs:</strong> " + d.carbs + "<br/>" : '') +
                          (d.insulin ? "<strong>Insulin:</strong> " + d.insulin + "<br/>" : '') +
                          (d.glucose ? "<strong>BG:</strong> " + d.glucose + (d.glucoseType ? ' (' + d.glucoseType + ')': '') + "<br/>" : '') +
                          (d.enteredBy ? "<strong>Entered by:</strong> " + d.enteredBy + "<br/>" : '') +
                          (d.notes ? "<strong>Notes:</strong> " + d.notes : '')
                      )
                      .style("left", (d3.event.pageX) + "px")
                      .style("top", (d3.event.pageY - 28) + "px");
                  })
          .on("mouseout", function (d) {
              div.transition()
                  .duration(500)
                  .style("opacity", 0);
          });
            
            treatCircles.attr('clip-path', 'url(#clip)');
        } catch (err) {
            console.error(err);
        }
    }

    // called for initial update and updates for resize
    function updateChart(init) {

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
        if ((prevChartWidth != chartWidth) || (prevChartHeight != chartHeight)) {

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
                    .attr('y1', yScale(scaleBg(36)))
                    .attr('x2', xScale(new Date(now)))
                    .attr('y2', yScale(scaleBg(420)))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the high bg threshold
                focus.append('line')
                    .attr('class', 'high-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_high)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_high)))
                    .style('stroke-dasharray', ('1, 6'))
                    .attr('stroke', '#777');

                // add a y-axis line that shows the high bg threshold
                focus.append('line')
                    .attr('class', 'target-top-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_target_top)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_target_top)))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the low bg threshold
                focus.append('line')
                    .attr('class', 'target-bottom-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_target_bottom)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_target_bottom)))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the low bg threshold
                focus.append('line')
                    .attr('class', 'low-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_low)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_low)))
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
                    .attr('y1', yScale2(scaleBg(app.thresholds.bg_target_top)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale2(scaleBg(app.thresholds.bg_target_top)))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the low bg threshold
                context.append('line')
                    .attr('class', 'low-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale2(scaleBg(app.thresholds.bg_target_bottom)))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale2(scaleBg(app.thresholds.bg_target_bottom)))
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

                // reset clip to new dimensions
                clip.transition()
                    .attr('width', chartWidth)
                    .attr('height', chartHeight);

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
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_high)))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_high)));

                focus.select('.target-top-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale(currentBrushExtent[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_target_top)))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_target_top)));

                focus.select('.target-bottom-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale(currentBrushExtent[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_target_bottom)))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_target_bottom)));

                focus.select('.low-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale(currentBrushExtent[0]))
                    .attr('y1', yScale(scaleBg(app.thresholds.bg_low)))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(scaleBg(app.thresholds.bg_low)));

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
                    .attr('y1', yScale2(scaleBg(app.thresholds.bg_target_top)))
                    .attr('x2', xScale2(dataRange[1]))
                    .attr('y2', yScale2(scaleBg(app.thresholds.bg_target_top)));

                // transition low line to correct location
                context.select('.low-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale2(dataRange[0]))
                    .attr('y1', yScale2(scaleBg(app.thresholds.bg_target_bottom)))
                    .attr('x2', xScale2(dataRange[1]))
                    .attr('y2', yScale2(scaleBg(app.thresholds.bg_target_bottom)));
            }
        }

        // update domain
        xScale2.domain(dataRange);

        context.select('.now-line')
            .transition()
            .duration(UPDATE_TRANS_MS)
            .attr('x1', xScale2(new Date(now)))
            .attr('y1', yScale2(scaleBg(36)))
            .attr('x2', xScale2(new Date(now)))
            .attr('y2', yScale2(scaleBg(420)));

        // only if a user brush is not active, update brush and focus chart with recent data
        // else, just transition brush
        var updateBrush = d3.select('.brush').transition().duration(UPDATE_TRANS_MS);
        if (!brushInProgress) {
            updateBrush
                .call(brush.extent([new Date(dataRange[1].getTime() - FOCUS_DATA_RANGE_MS), dataRange[1]]));
            brushed(true);
        } else {
            updateBrush
                .call(brush.extent([currentBrushExtent[0], currentBrushExtent[1]]));
            brushed(true);
        }

        // bind up the context chart data to an array of circles
        var contextCircles = context.selectAll('circle')
            .data(data);

        // if already existing then transition each circle to its new position
        contextCircles.transition()
            .duration(UPDATE_TRANS_MS)
            .attr('cx', function (d) { return xScale2(d.date); })
            .attr('cy', function (d) { return yScale2(d.sgv); })
            .attr('fill', function (d) { return d.color; })
            .style('opacity', function (d) { return highlightBrushPoints(d) });

        // if new circle then just display
        contextCircles.enter().append('circle')
            .attr('cx', function (d) { return xScale2(d.date); })
            .attr('cy', function (d) { return yScale2(d.sgv); })
            .attr('fill', function (d) { return d.color; })
            .style('opacity', function (d) { return highlightBrushPoints(d) })
            .attr('stroke-width', function (d) {if (d.type == 'mbg') return 2; else return 0; })
            .attr('stroke', function (d) { return "white"; })
            .attr('r', function(d) { if (d.type == 'mbg') return 4; else return 2;});

        contextCircles.exit()
            .remove();

        // update x axis domain
        context.select('.x')
            .call(xAxis2);
    }

    function sgvToColor(sgv) {
        var color = 'grey';

        if (browserSettings.theme == "colors") {
            if (sgv > app.thresholds.bg_high) {
                color = 'red';
            } else if (sgv > app.thresholds.bg_target_top) {
                color = 'yellow';
            } else if (sgv >= app.thresholds.bg_target_bottom && sgv <= app.thresholds.bg_target_top) {
                color = '#4cff00';
            } else if (sgv < app.thresholds.bg_low) {
                color = 'red';
            } else if (sgv < app.thresholds.bg_target_bottom) {
                color = 'yellow';
            }
        }

        return color;
    }

    function generateAlarm(file) {
        alarmInProgress = true;
        var selector = '.audio.alarms audio.' + file;
        d3.select(selector).each(function (d, i) {
            var audio = this;
            playAlarm(audio);
            $(this).addClass('playing');
        });
        var bgButton = $('#bgButton');
        bgButton.show();
        bgButton.toggleClass("urgent", file == urgentAlarmSound);
        var noButton = $('#noButton');
        noButton.hide();
        $('.container .currentBG').text();

        if ($(window).width() <= WIDTH_TIME_HIDDEN) {
            $(".time").hide();
        }
    }

    function playAlarm(audio) {
        // ?mute=true disables alarms to testers.
        if (querystring.mute != "true") {
            audio.play();
        } else {
            showNotification("Alarm is muted per your request. (?mute=true)");
        }
    }

    function stopAlarm(isClient, silenceTime) {
        alarmInProgress = false;
        var bgButton = $('#bgButton');
        bgButton.hide();
        var noButton = $('#noButton');
        noButton.show();
        d3.select('audio.playing').each(function (d, i) {
            var audio = this;
            audio.pause();
            $(this).removeClass('playing');
        });

        $(".time").show();

        // only emit ack if client invoke by button press
        if (isClient) {
            socket.emit('ack', currentAlarmType || 'alarm', silenceTime);
            brushed(false);
        }
    }

    function timeAgo(offset) {
        var parts = {},
            MINUTE = 60,
            HOUR = 3600,
            DAY = 86400,
            WEEK = 604800;

        //offset = (MINUTE * MINUTES_SINCE_LAST_UPDATE_WARN) + 60
        //offset = (MINUTE * MINUTES_SINCE_LAST_UPDATE_URGENT) + 60

        if (offset <= MINUTE)              parts = { label: 'now' };
        if (offset <= MINUTE * 2)          parts = { label: '1 min ago' };
        else if (offset < (MINUTE * 60))   parts = { value: Math.round(Math.abs(offset / MINUTE)), label: 'mins' };
        else if (offset < (HOUR * 2))      parts = { label: '1 hr ago' };
        else if (offset < (HOUR * 24))     parts = { value: Math.round(Math.abs(offset / HOUR)), label: 'hrs' };
        else if (offset < DAY)             parts = { label: '1 day ago' };
        else if (offset < (DAY * 7))       parts = { value: Math.round(Math.abs(offset / DAY)), label: 'day' };
        else if (offset < (WEEK * 52))     parts = { value: Math.round(Math.abs(offset / WEEK)), label: 'week' };
        else                               parts = { label: 'a long time ago' };

        if (offset > (MINUTE * MINUTES_SINCE_LAST_UPDATE_URGENT)) {
            var lastEntry = $("#lastEntry");
            lastEntry.removeClass("warn");
            lastEntry.addClass("urgent");

            $(".bgStatus").removeClass("current");
        } else if (offset > (MINUTE * MINUTES_SINCE_LAST_UPDATE_WARN)) {
            var lastEntry = $("#lastEntry");
            lastEntry.removeClass("urgent");
            lastEntry.addClass("warn");
        } else {
            $(".bgStatus").addClass("current");
            $("#lastEntry").removeClass("warn urgent");
        }

        if (parts.value)
            return parts.value + ' ' + parts.label + ' ago';
        else
            return parts.label;

    }

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //draw a compact visualization of a treatment (carbs, insulin)
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    function drawTreatment(treatment, scale, showValues) {
        var carbs = treatment.carbs;
        var insulin = treatment.insulin;
        var CR = treatment.CR;

        var R1 = Math.sqrt(Math.min(carbs, insulin * CR)) / scale,
            R2 = Math.sqrt(Math.max(carbs, insulin * CR)) / scale,
            R3 = R2 + 8 / scale;

        var arc_data = [
            { 'element': '', 'color': '#9c4333', 'start': -1.5708, 'end': 1.5708, 'inner': 0, 'outer': R1 },
            { 'element': '', 'color': '#d4897b', 'start': -1.5708, 'end': 1.5708, 'inner': R1, 'outer': R2 },
            { 'element': '', 'color': 'transparent', 'start': -1.5708, 'end': 1.5708, 'inner': R2, 'outer': R3 },
            { 'element': '', 'color': '#3d53b7', 'start': 1.5708, 'end': 4.7124, 'inner': 0, 'outer': R1 },
            { 'element': '', 'color': '#5d72c9', 'start': 1.5708, 'end': 4.7124, 'inner': R1, 'outer': R2 },
            { 'element': '', 'color': 'transparent', 'start': 1.5708, 'end': 4.7124, 'inner': R2, 'outer': R3 }
        ];

        if (carbs < insulin * CR) arc_data[1].color = 'transparent';
        if (carbs > insulin * CR) arc_data[4].color = 'transparent';
        if (carbs > 0) arc_data[2].element = Math.round(carbs) + ' g';
        if (insulin > 0) arc_data[5].element = Math.round(insulin * 10) / 10 + ' U';

        var arc = d3.svg.arc()
            .innerRadius(function (d) { return 5 * d.inner; })
            .outerRadius(function (d) { return 5 * d.outer; })
            .endAngle(function (d) { return d.start; })
            .startAngle(function (d) { return d.end; });

        var treatmentDots = focus.selectAll('treatment-dot')
            .data(arc_data)
            .enter()
            .append('g')
            .attr('transform', 'translate(' + xScale(treatment.x) + ', ' + yScale(scaleBg(treatment.y)) + ')');

        var arcs = treatmentDots.append('path')
            .attr('class', 'path')
            .attr('fill', function (d, i) { return d.color; })
            .attr('id', function (d, i) { return 's' + i; })
            .attr('d', arc);


        // labels for carbs and insulin
        if (showValues) {
            var label = treatmentDots.append('g')
                .attr('class', 'path')
                .attr('id', 'label')
                .style('fill', 'white');
            label.append('text')
                .style('font-size', 30 / scale)
                .style('font-family', 'Arial')
                .attr('text-anchor', 'middle')
                .attr('dy', '.35em')
                .attr('transform', function (d) {
                    d.outerRadius = d.outerRadius * 2.1;
                    d.innerRadius = d.outerRadius * 2.1;
                    return 'translate(' + arc.centroid(d) + ')';
                })
                .text(function (d) { return d.element; })
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // function to predict
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    function predictAR(actual, lookback) {
        var ONE_MINUTE = 60 * 1000;
        var FIVE_MINUTES = 5 * ONE_MINUTE;
        var predicted = [];
        var BG_REF = scaleBg(140);
        var BG_MIN = scaleBg(36);
        var BG_MAX = scaleBg(400);
        // these are the one sigma limits for the first 13 prediction interval uncertainties (65 minutes)
        var CONE = [0.020, 0.041, 0.061, 0.081, 0.099, 0.116, 0.132, 0.146, 0.159, 0.171, 0.182, 0.192, 0.201];
        // these are modified to make the cone much blunter
        //var CONE = [0.030, 0.060, 0.090, 0.120, 0.140, 0.150, 0.160, 0.170, 0.180, 0.185, 0.190, 0.195, 0.200];
        // for testing
        //var CONE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        if (actual.length < lookback+1) {
            var y = [Math.log(actual[actual.length-1].sgv / BG_REF), Math.log(actual[actual.length-1].sgv / BG_REF)];
        } else {
            var elapsedMins = (actual[actual.length-1].date - actual[actual.length-1-lookback].date) / ONE_MINUTE;
            // construct a "5m ago" sgv offset from current sgv by the average change over the lookback interval
            var lookbackSgvChange = actual[lookback].sgv-actual[0].sgv;
            var fiveMinAgoSgv = actual[lookback].sgv - lookbackSgvChange/elapsedMins*5;
            y = [Math.log(fiveMinAgoSgv / BG_REF), Math.log(actual[lookback].sgv / BG_REF)];
            /*
            if (elapsedMins < lookback * 5.1) {
                y = [Math.log(actual[0].sgv / BG_REF), Math.log(actual[lookback].sgv / BG_REF)];
            } else {
                y = [Math.log(actual[lookback].sgv / BG_REF), Math.log(actual[lookback].sgv / BG_REF)];
            }
            */
        }
        var AR = [-0.723, 1.716];
        var dt = actual[lookback].date.getTime();
        var predictedColor = 'blue';
        if (browserSettings.theme == "colors") {
            predictedColor = 'cyan';
        }
        for (var i = 0; i < CONE.length; i++) {
            y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
            dt = dt + FIVE_MINUTES;
            // Add 2000 ms so not same point as SG
            predicted[i * 2] = {
                date: new Date(dt + 2000),
                sgv: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp((y[1] - 2 * CONE[i]))))),
                color: predictedColor
            };
            // Add 4000 ms so not same point as SG
            predicted[i * 2 + 1] = {
                date: new Date(dt + 4000),
                sgv: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp((y[1] + 2 * CONE[i]))))),
                color: predictedColor
            };
            predicted.forEach(function (d) {
                d.type = 'forecast';
                if (d.sgv < BG_MIN)
                    d.color = "transparent";
            })
        }
        return predicted;
    }

    function init() {
        var div = d3.select("body").append("div")
            .attr("class", "tooltip")
            .style("opacity", 0);

        // Tick Values
        if (browserSettings.units == "mmol") {
            tickValues = [
                  2.0
                , Math.round(scaleBg(app.thresholds.bg_low))
                , Math.round(scaleBg(app.thresholds.bg_target_bottom))
                , 6.0
                , Math.round(scaleBg(app.thresholds.bg_target_top))
                , Math.round(scaleBg(app.thresholds.bg_high))
                , 22.0
            ];
        } else {
            tickValues = [
                  40
                , app.thresholds.bg_low
                , app.thresholds.bg_target_bottom
                , 120
                , app.thresholds.bg_target_top
                , app.thresholds.bg_high
                , 400
            ];
        }

        futureOpacity = d3.scale.linear( )
            .domain([TWENTY_FIVE_MINS_IN_MS, SIXTY_MINS_IN_MS])
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

        // look for resize but use timer to only call the update script when a resize stops
        var resizeTimer;
        window.onresize = function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                updateChart(false);
            }, 100);
        };

        var silenceDropdown = new Dropdown(".dropdown-menu");

        $('#bgButton').click(function (e) {
            silenceDropdown.open(e);
        });

        $("#silenceBtn").find("a").click(function (e) {
            stopAlarm(true, $(this).data("snooze-time"));
            e.preventDefault();
        });

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        // Client-side code to connect to server and handle incoming data
        ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        socket = io.connect();

        socket.on('now', function (d) {
            now = d;
            var dateTime = new Date(now);
            $('#currentTime').text(formatTime(dateTime));

            // Dim the screen by reducing the opacity when at nighttime
            if (browserSettings.nightMode) {
                if (opacity.current != opacity.NIGHT && (dateTime.getHours() > 21 || dateTime.getHours() < 7)) {
                    $('body').css({ 'opacity': opacity.NIGHT });
                } else {
                    $('body').css({ 'opacity': opacity.DAY });
                }
            }
        });

        socket.on('sgv', function (d) {
            if (d.length > 1) {
                errorCode = d.length >= 5 ? d[4] : undefined;

                // change the next line so that it uses the prediction if the signal gets lost (max 1/2 hr)
                if (d[0].length) {
                    latestSGV = d[0][d[0].length - 1];
                    prevSGV = d[0][d[0].length - 2];
                }
                data = d[0].map(function (obj) {
                    return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), direction: obj.direction, color: sgvToColor(obj.y), type: 'sgv'}
                });
                // TODO: This is a kludge to advance the time as data becomes stale by making old predictor clear (using color = 'none')
                // This shouldn't have to be sent and can be fixed by using xScale.domain([x0,x1]) function with
                // 2 days before now as x0 and 30 minutes from now for x1 for context plot, but this will be
                // required to happen when "now" event is sent from websocket.js every minute.  When fixed,
                // remove all "color != 'none'" code
                data = data.concat(d[1].map(function (obj) { return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: 'none', type: 'server-forecast'} }));

                //Add MBG's also, pretend they are SGV's
                data = data.concat(d[2].map(function (obj) { return { date: new Date(obj.x), y: obj.y, sgv: scaleBg(obj.y), color: 'red', type: 'mbg'} }));

                data.forEach(function (d) {
                    if (d.y < 39)
                        d.color = "transparent";
                });

                treatments = d[3];
                treatments.forEach(function (d) {
                    d.created_at = new Date(d.created_at);
                });

                if (!isInitialData) {
                    isInitialData = true;
                    initializeCharts();
                }
                else {
                    updateChart(false);
                }
            }
        });

        ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        // Alarms and Text handling
        ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
        socket.on('connect', function () {
            console.log('Client connected to server.')
        });

        //with predicted alarms, latestSGV may still be in target so to see if the alarm
        //  is for a HIGH we can only check if it's >= the bottom of the target
        function isAlarmForHigh() {
            return latestSGV.y >= app.thresholds.bg_target_bottom;
        }

        //with predicted alarms, latestSGV may still be in target so to see if the alarm
        //  is for a LOW we can only check if it's <= the top of the target
        function isAlarmForLow() {
            return !!errorCode || latestSGV.y <= app.thresholds.bg_target_top;
        }

        socket.on('alarm', function () {
            console.info("alarm received from server");
            var enabled = (isAlarmForHigh() && browserSettings.alarmHigh) || (isAlarmForLow() && browserSettings.alarmLow);
            if (enabled) {
                console.log("Alarm raised!");
                currentAlarmType = 'alarm';
                generateAlarm(alarmSound);
            } else {
                console.info("alarm was disabled locally", latestSGV.y, browserSettings);
            }
            brushInProgress = false;
            updateChart(false);
        });
        socket.on('urgent_alarm', function () {
            console.info("urgent alarm received from server");
            var enabled = (isAlarmForHigh() && browserSettings.alarmUrgentHigh) || (isAlarmForLow() && browserSettings.alarmUrgentLow);
            if (enabled) {
                console.log("Urgent alarm raised!");
                currentAlarmType = 'urgent_alarm';
                generateAlarm(urgentAlarmSound);
            } else {
                console.info("urgent alarm was disabled locally", latestSGV.y, browserSettings);
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
    }

    $.ajax("/api/v1/status.json", {
        success: function (xhr) {
            app = { name: xhr.name
                , version: xhr.version
                , head: xhr.head
                , apiEnabled: xhr.apiEnabled
                , thresholds: xhr.thresholds
                , units: xhr.units
                , careportalEnabled: xhr.careportalEnabled
            };
        }
    }).done(function() {
        $(".appName").text(app.name);
        $(".version").text(app.version);
        $(".head").text(app.head);
        if (app.apiEnabled) {
            $(".serverSettings").show();
        }
        $("#treatmentDrawerToggle").toggle(app.careportalEnabled);
        browserSettings = getBrowserSettings(browserStorage);
        init();
    });

})();
