(function() {
    "use strict";

    var retrospectivePredictor = true,
        latestSGV,
        treatments,
        padding = {top: 20, right: 10, bottom: 80, left: 10},
        opacity = {current: 1, DAY: 1, NIGHT: 0.8},
        now = Date.now(),
        data = [],
        dateFn = function (d) { return new Date(d.date)},
        xScale, xScale2, yScale, yScale2,
        xAxis, yAxis, xAxis2, yAxis2,
        prevChartWidth = 0,
        prevChartHeight = 0,
        focusHeight,
        contextHeight,
        UPDATE_TRANS_MS = 750, // milliseconds
        brush,
        BRUSH_TIMEOUT = 300000,  // 5 minutes in ms
        brushTimer,
        brushInProgress = false,
        clip,
        TWENTY_FIVE_MINS_IN_MS = 1500000,
        THIRTY_MINS_IN_MS = 1800000,
        FORTY_TWO_MINS_IN_MS = 2520000,
        FOCUS_DATA_RANGE_MS = 12600000, // 3.5 hours of actual data
        audio = document.getElementById('audio'),
        alarmInProgress = false,
        currentAlarmType = null,
        alarmSound = 'alarm.mp3',
        urgentAlarmSound = 'alarm2.mp3';


    // create svg and g to contain the chart contents
    var charts = d3.select('#chartContainer').append('svg')
        .append('g')
        .attr('class', 'chartContainer')
        .attr('transform', 'translate(' + padding.left + ',' + padding.top + ')');

    var focus = charts.append('g');

    // create the x axis container
    focus.append('g')
        .attr('class', 'x axis');

    // create the y axis container
    focus.append('g')
        .attr('class', 'y axis');

    var context = charts.append('g');

    // create the x axis container
    context.append('g')
        .attr('class', 'x axis');

    // create the y axis container
    context.append('g')
        .attr('class', 'y axis');

    // initial setup of chart when data is first made available
    function initializeCharts() {

        // define the parts of the axis that aren't dependent on width or height
        xScale = d3.time.scale()
            .domain(d3.extent(data, function (d) { return d.date; }));

        yScale = d3.scale.log()
            .domain([30, 420]);

        xScale2 = d3.time.scale()
            .domain(d3.extent(data, function (d) { return d.date; }));

        yScale2 = d3.scale.log()
            .domain([36, 420]);

        xAxis = d3.svg.axis()
            .scale(xScale)
            .ticks(4)
            .orient('top');

        yAxis = d3.svg.axis()
            .scale(yScale)
            .tickFormat(d3.format('d'))
            .tickValues([40, 60, 80, 120, 180, 300, 400])
            .orient('left');

        xAxis2 = d3.svg.axis()
            .scale(xScale2)
            .ticks(4)
            .orient('bottom');

        yAxis2 = d3.svg.axis()
            .scale(yScale2)
            .tickFormat(d3.format('d'))
            .tickValues([40, 60, 80, 120, 180, 300, 400])
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
            return 1;
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
            .style('opacity', function(d) {return 1;} );
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

        var element = document.getElementById('bgButton').hidden == '';
        var nowDate = new Date(brushExtent[1] - THIRTY_MINS_IN_MS);

        // predict for retrospective data
        if (retrospectivePredictor && brushExtent[1].getTime() - THIRTY_MINS_IN_MS < now && element != true) {
            // filter data for -12 and +5 minutes from reference time for retrospective focus data prediction
            var nowData = data.filter(function(d) {
                return d.date.getTime() >= brushExtent[1].getTime() - FORTY_TWO_MINS_IN_MS &&
                    d.date.getTime() <= brushExtent[1].getTime() - TWENTY_FIVE_MINS_IN_MS
            });
            if (nowData.length > 1) {
                var prediction = predictAR(nowData);
                focusData = focusData.concat(prediction);
                var focusPoint = nowData[nowData.length - 1];
                $('.container .currentBG')
                    .text((focusPoint.sgv))
                    .css('text-decoration','line-through');
                $('.container .currentDirection')
                    .html(focusPoint.direction)
            } else {
                $('.container .currentBG')
                    .text("---")
                    .css('text-decoration','none');
            }
            $('#currentTime')
                .text(d3.time.format('%I:%M%p')(new Date(brushExtent[1] - THIRTY_MINS_IN_MS)))
                .css('text-decoration','line-through');
        } else if (retrospectivePredictor) {
            // if the brush comes back into the current time range then it should reset to the current time and sg
            var dateTime = new Date(now);
            nowDate = dateTime;
            $('#currentTime')
                .text(d3.time.format('%I:%M%p')(dateTime))
                .css('text-decoration','none');
            $('.container .currentBG')
                .text(latestSGV.y)
                .css('text-decoration','none');
            $('.container .currentDirection')
                .html(latestSGV.direction);
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
            .attr('cy', function (d) { return yScale(d.sgv);  })
            .attr('fill', function (d) { return d.color;      });

        // if new circle then just display
        focusCircles.enter().append('circle')
            .attr('cx', function (d) { return xScale(d.date); })
            .attr('cy', function (d) { return yScale(d.sgv);  })
            .attr('fill', function (d) { return d.color;      })
            .attr('r', 3);

        focusCircles.exit()
            .remove();

        // remove all insulin/carb treatment bubbles so that they can be redrawn to correct location
        d3.selectAll('.path').remove();

        // add treatment bubbles
        var bubbleSize = prevChartWidth < 400 ? 4 : (prevChartWidth < 600 ? 3 : 2);
        focus.selectAll('circle')
            .data(treatments)
            .each(function (d) { drawTreatment(d, bubbleSize, true)});

        // transition open-top line to correct location
        focus.select('.open-top')
            .attr('x1', xScale2(brush.extent()[0]))
            .attr('y1', yScale(30))
            .attr('x2', xScale2(brush.extent()[1]))
            .attr('y2', yScale(30));

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
            .attr('y1', yScale(36))
            .attr('x2', xScale(nowDate))
            .attr('y2', yScale(420));

        // update x axis
        focus.select('.x.axis')
            .call(xAxis);

        // add clipping path so that data stays within axis
        focusCircles.attr('clip-path', 'url(#clip)');
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
                    .attr('y1', yScale(36))
                    .attr('x2', xScale(new Date(now)))
                    .attr('y2', yScale(420))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the high bg threshold
                focus.append('line')
                    .attr('class', 'high-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(180))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(180))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the low bg threshold
                focus.append('line')
                    .attr('class', 'low-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale(80))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale(80))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

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
                    .attr('y1', yScale2(36))
                    .attr('x2', xScale(new Date(now)))
                    .attr('y2', yScale2(420))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the high bg threshold
                context.append('line')
                    .attr('class', 'high-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale2(180))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale2(180))
                    .style('stroke-dasharray', ('3, 3'))
                    .attr('stroke', 'grey');

                // add a y-axis line that shows the low bg threshold
                context.append('line')
                    .attr('class', 'low-line')
                    .attr('x1', xScale(dataRange[0]))
                    .attr('y1', yScale2(80))
                    .attr('x2', xScale(dataRange[1]))
                    .attr('y2', yScale2(80))
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

                // transition high line to correct location
                focus.select('.high-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale(currentBrushExtent[0]))
                    .attr('y1', yScale(180))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(180));

                // transition low line to correct location
                focus.select('.low-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale(currentBrushExtent[0]))
                    .attr('y1', yScale(80))
                    .attr('x2', xScale(currentBrushExtent[1]))
                    .attr('y2', yScale(80));

                // transition open-top line to correct location
                focus.select('.open-top')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale2(currentBrushExtent[0]))
                    .attr('y1', yScale(30))
                    .attr('x2', xScale2(currentBrushExtent[1]))
                    .attr('y2', yScale(30));

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
                    .attr('y1', yScale2(180))
                    .attr('x2', xScale2(dataRange[1]))
                    .attr('y2', yScale2(180));

                // transition low line to correct location
                context.select('.low-line')
                    .transition()
                    .duration(UPDATE_TRANS_MS)
                    .attr('x1', xScale2(dataRange[0]))
                    .attr('y1', yScale2(80))
                    .attr('x2', xScale2(dataRange[1]))
                    .attr('y2', yScale2(80));
            }
        }

        // update domain
        xScale2.domain(dataRange);

        context.select('.now-line')
            .transition()
            .duration(UPDATE_TRANS_MS)
            .attr('x1', xScale2(new Date(now)))
            .attr('y1', yScale2(36))
            .attr('x2', xScale2(new Date(now)))
            .attr('y2', yScale2(420));

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
            .attr('cy', function (d) { return yScale2(d.sgv);  })
            .attr('fill', function (d) { return d.color;       })
            .style('opacity', function (d)   { return highlightBrushPoints(d) });

        // if new circle then just display
        contextCircles.enter().append('circle')
            .attr('cx', function (d)   { return xScale2(d.date); })
            .attr('cy', function (d)   { return yScale2(d.sgv);  })
            .attr('fill', function (d) { return d.color;         })
            .style('opacity', function (d)   { return highlightBrushPoints(d) })
            .attr('r', 2);

        contextCircles.exit()
            .remove();

        // update x axis domain
        context.select('.x')
            .call(xAxis2);
    }

    // look for resize but use timer to only call the update script when a resize stops
    var resizeTimer;
    window.onresize = function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            updateChart(false);
        }, 100);
    };

    var silenceDropdown = new Dropdown(".dropdown-menu");

    $('#bgButton').click(function(e) {
        silenceDropdown.open(e);
    });

    $("#silenceBtn").find("a").click(function() {
        stopAlarm(true, $(this).data("snooze-time"));
    });

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Client-side code to connect to server and handle incoming data
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    var isInitialData = false;
    var socket = io.connect();

    socket.on('now', function (d) {
        now = d;
        var dateTime = new Date(now);
        $('#currentTime').text(d3.time.format('%I:%M%p')(dateTime));

        // Dim the screen by reducing the opacity when at nighttime
        if (opacity.current != opacity.NIGHT && (dateTime.getHours() > 21 || dateTime.getHours() < 7 )) {
            $('body').css({'opacity': opacity.NIGHT});
        } else {
            $('body').css({'opacity': opacity.DAY});
        }
    });

    socket.on('sgv', function (d) {
        if (d.length > 1) {
            // change the next line so that it uses the prediction if the signal gets lost (max 1/2 hr)
            if (d[0].length) {
                var current = d[0][d[0].length - 1];
                latestSGV = current;
                var secsSinceLast = (Date.now() - new Date(current.x).getTime()) / 1000;
                var currentBG = current.y;

                //TODO: currently these are filtered on the server
                //TODO: use icons for these magic values
                switch (current.y) {
                    case 0:  currentBG = '??0'; break; //None
                    case 1:  currentBG = '?SN'; break; //SENSOR_NOT_ACTIVE
                    case 2:  currentBG = '??2'; break; //MINIMAL_DEVIATION
                    case 3:  currentBG = '?NA'; break; //NO_ANTENNA
                    case 5:  currentBG = '?NC'; break; //SENSOR_NOT_CALIBRATED
                    case 6:  currentBG = '?CD'; break; //COUNTS_DEVIATION
                    case 7:  currentBG = '??7'; break; //?
                    case 8:  currentBG = '??8'; break; //?
                    case 9:  currentBG = '?AD'; break; //ABSOLUTE_DEVIATION
                    case 10: currentBG = '?PD'; break; //POWER_DEVIATION
                    case 12: currentBG = '?RF'; break; //BAD_RF
                }

                $('#lastEntry').text(timeAgo(secsSinceLast)).toggleClass('current', secsSinceLast < 10 * 60);
                $('.container .currentBG').text(currentBG);
                $('.container .currentDirection').html(current.direction);
                $('.container .current').toggleClass('high', current.y > 180).toggleClass('low', current.y < 70)
            }
            data = d[0].map(function (obj) { return { date: new Date(obj.x), sgv: obj.y, direction: obj.direction, color: 'grey'} });
            data = data.concat(d[1].map(function (obj) { return { date: new Date(obj.x), sgv: obj.y, color: 'blue'} }));
            data = data.concat(d[2].map(function (obj) { return { date: new Date(obj.x), sgv: obj.y, color: 'red'} }));
            treatments = d[3];
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

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // Alarms and Text handling
    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    socket.on('connect', function () {
        console.log('Client connected to server.')
    });
    socket.on('alarm', function() {
        console.log("Alarm raised!");
        currentAlarmType = 'alarm';
        generateAlarm(alarmSound);
        brushInProgress = false;
        updateChart(false);
    });
    socket.on('urgent_alarm', function() {
        console.log("Urgent alarm raised!");
        currentAlarmType = 'urgent_alarm';
        generateAlarm(urgentAlarmSound);
        brushInProgress = false;
        updateChart(false);
    });
    socket.on('clear_alarm', function() {
        if (alarmInProgress) {
            console.log('clearing alarm');
            stopAlarm();
        }
    });


    $('#testAlarms').click(function(event) {
        d3.select('.audio.alarms audio').each(function (data, i) {
          var audio = this;
          audio.play();
          setTimeout(function() {
              audio.pause();
          }, 4000);
        });
        event.preventDefault();
    });

    function generateAlarm(file) {
        alarmInProgress = true;
        var selector = '.audio.alarms audio.' + file;
        d3.select(selector).each(function (d, i) {
          var audio = this;
          audio.play();
          $(this).addClass('playing');
        });
        var element = document.getElementById('bgButton');
        element.hidden = '';
        var element1 = document.getElementById('noButton');
        element1.hidden = 'true';
        $('.container .currentBG').text();
    }

    function stopAlarm(isClient, silenceTime) {
        alarmInProgress = false;
        var element = document.getElementById('bgButton');
        element.hidden = 'true';
        element = document.getElementById('noButton');
        element.hidden = '';
        d3.select('audio.playing').each(function (d, i) {
          var audio = this;
          audio.pause();
          $(this).removeClass('playing');
        });

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

        if (offset <= MINUTE)              parts = { lablel: 'now' };
        if (offset <= MINUTE * 2)          parts = { label: '1 min ago' };
        else if (offset < (MINUTE * 60))   parts = { value: Math.round(Math.abs(offset / MINUTE)), label: 'mins' };
        else if (offset < (HOUR * 2))      parts = { label: '1 hr ago' };
        else if (offset < (HOUR * 24))     parts = { value: Math.round(Math.abs(offset / HOUR)), label: 'hrs' };
        else if (offset < DAY)             parts = { label: '1 day ago' };
        else if (offset < (DAY * 7))       parts = { value: Math.round(Math.abs(offset / DAY)), label: 'day' };
        else if (offset < (WEEK * 52))     parts = { value: Math.round(Math.abs(offset / WEEK)), label: 'week' };
        else                               parts = { label: 'a long time ago' };

        if (parts.value)
          return parts.value + ' ' + parts.label + ' ago';
        else
          return parts.label;

    }

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
            .attr('transform', 'translate(' + xScale(treatment.x) + ', ' + yScale(treatment.y) + ')');

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
    function predictAR(actual) {
        var ONE_MINUTE = 60 * 1000;
        var FIVE_MINUTES = 5 * ONE_MINUTE;
        var predicted = [];
        var BG_REF = 140;
        var BG_MIN = 36;
        var BG_MAX = 400;
        if (actual.length < 2) {
            var y = [Math.log(actual[0].sgv / BG_REF), Math.log(actual[0].sgv / BG_REF)];
        } else {
            var elapsedMins = (actual[1].date - actual[0].date) / ONE_MINUTE;
            if (elapsedMins < 5.1) {
                y = [Math.log(actual[0].sgv / BG_REF), Math.log(actual[1].sgv / BG_REF)];
            } else {
                y = [Math.log(actual[0].sgv / BG_REF), Math.log(actual[0].sgv / BG_REF)];
            }
        }
        var n = 20;
        var AR = [-0.723, 1.716];
        var dt = actual[1].date.getTime();
        for (var i = 0; i <= n; i++) {
            y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
            dt = dt + FIVE_MINUTES;
            predicted[i] = {
                date: new Date(dt+3000),
                sgv: Math.max(BG_MIN, Math.min(BG_MAX, Math.round(BG_REF * Math.exp(y[1])))),
                color: 'blue'
            };
        }
        return predicted;
    }
})();
