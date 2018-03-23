'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');

var daytoday = {
  name: 'daytoday'
  , label: 'Day to day'
  , pluginType: 'report'
};

function init() {
  return daytoday;
}

module.exports = init;

daytoday.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Day to day') + '</h2>'
    + '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>'
    + translate('Display') + ': '
    + '<input type="checkbox" id="rp_optionsinsulin" checked><span style="color:blue;opacity:0.5">'+translate('Insulin')+'</span>'
    + '<input type="checkbox" id="rp_optionscarbs" checked><span style="color:red;opacity:0.5">'+translate('Carbs')+'</span>'
    + '<input type="checkbox" id="rp_optionsbasal" checked><span style="color:#0099ff;opacity:0.5">'+translate('Basal rate')+'</span>'
    + '<input type="checkbox" id="rp_optionsnotes" checked>'+translate('Notes')
    + '<input type="checkbox" id="rp_optionsfood" checked>'+translate('Food')
    + '<input type="checkbox" id="rp_optionsraw"><span style="color:gray;opacity:1">'+translate('Raw')+'</span>'
    + '<input type="checkbox" id="rp_optionsiob"><span style="color:blue;opacity:0.5">'+translate('IOB')+'</span>'
    + '<input type="checkbox" id="rp_optionscob"><span style="color:red;opacity:0.5">'+translate('COB')+'</span>'
    + '<input type="checkbox" id="rp_optionsopenaps"><span style="color:sienna;opacity:0.5">'+translate('OpenAPS')+'</span>'
    + '<input type="checkbox" id="rp_optionsdistribution"><span style="color:blue;opacity:0.5">'+translate('Insulin distribution')+'</span>'
    + '&nbsp;'+translate('Size')
    + ' <select id="rp_size">'
    + '  <option x="800" y="250">800x250px</option>'
    + '  <option x="1000" y="300" selected>1000x300px</option>'
    + '  <option x="1200" y="400">1200x400px</option>'
    + '  <option x="1550" y="600">1550x600px</option>'
    + '</select>'
    + '<br>'
    + translate('Scale') + ': '
    + '<input type="radio" name="rp_scale" id="rp_linear" checked>'
    + translate('Linear')
    + '<input type="radio" name="rp_scale" id="rp_log">'
    + translate('Logarithmic')
    + '<br>'
    + '<div id="daytodaycharts">'
    + '</div>'
    ;
    return ret;
};

daytoday.prepareHtml = function daytodayPrepareHtml(sorteddaystoshow) {
  $('#daytodaycharts').html('');
  sorteddaystoshow.forEach(function eachDay(d) {
    $('#daytodaycharts').append($('<table><tr><td><div id="daytodaychart-' + d + '"></div></td><td><div id="daytodaystatchart-' + d + '"></td></tr></table>'));
  });
};

daytoday.report = function report_daytoday(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  var TOOLTIP_TRANS_MS = 300;

  var padding = { top: 15, right: 22, bottom: 30, left: 35 };

  daytoday.prepareHtml(sorteddaystoshow) ;
  sorteddaystoshow.forEach( function eachDay(day) {
    drawChart(day,datastorage[day],options);
  });

  function timeTicks(n,i) {
    var t12 = [
      '12am', '', '2am', '', '4am', '', '6am', '', '8am', '', '10am', '',
      '12pm', '', '2pm', '', '4pm', '', '6pm', '', '8pm', '', '10pm', '', '12am'
    ];
    if (Nightscout.client.settings.timeFormat === 24) {
      return ('00' + i).slice(-2);
    } else {
      return t12[i];
    }
  }

  function drawChart(day,data,options) {
    var tickValues
      , charts
      , context
      , xScale2, yScale2
      , yInsulinScale, yCarbsScale, yScaleBasals
      , xAxis2, yAxis2
      , dateFn = function (d) { return new Date(d.date); }
      , foodtexts = 0;

   tickValues = client.ticks(client, {
     scaleY: options.scale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
     , targetTop: options.targetHigh
     , targetBottom: options.targetLow
   });

  // add defs for combo boluses
  var dashWidth = 5;
  d3.select('body').append('svg')
    .append('defs')
    .append('pattern')
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

    // create svg and g to contain the chart contents
    charts = d3.select('#daytodaychart-' + day).html(
      '<b>'+
      report_plugins.utils.localeDate(day)+
      '</b><br>'
      ).append('svg');

    charts.append('rect')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('fill', 'WhiteSmoke');

    context = charts.append('g');

    // define the parts of the axis that aren't dependent on width or height
    xScale2 = d3.time.scale()
      .domain(d3.extent(data.sgv, dateFn));

    if (options.scale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scale.log()
        .domain([client.utils.scaleMgdl(options.basal ? 30 : 36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scale.linear()
        .domain([client.utils.scaleMgdl(options.basal ? -40 : 36), client.utils.scaleMgdl(420)]);
    }

    // allow insulin to be negative (when plotting negative IOB)
    yInsulinScale = d3.scale.linear()
      .domain([-2 * options.maxInsulinValue, 2 * options.maxInsulinValue]);

    yCarbsScale = d3.scale.linear()
      .domain([0, options.maxCarbsValue*1.25]);

    yScaleBasals = d3.scale.linear();

    xAxis2 = d3.svg.axis()
      .scale(xScale2)
      .tickFormat(timeTicks)
      .ticks(24)
      .orient('bottom');

    yAxis2 = d3.svg.axis()
      .scale(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues)
      .orient('left');

    // get current data range
    var dataRange = d3.extent(data.sgv, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = options.width - padding.left - padding.right;
    var chartHeight = options.height - padding.top - padding.bottom;

    //set the width and height of the SVG element
    charts.attr('width', options.width)
      .attr('height', options.height);

    // ranges are based on the width and height available so reset
    xScale2.range([0, chartWidth]);
    yScale2.range([chartHeight,0]);
    yInsulinScale.range([chartHeight * 2, 0]);
    yCarbsScale.range([chartHeight,0]);
    yScaleBasals.range([yScale2(client.utils.scaleMgdl(72)), chartHeight]);

    // add target BG rect
    context.append('rect')
      .attr('x', xScale2(dataRange[0])+padding.left)
      .attr('y', yScale2(options.targetHigh)+padding.top)
      .attr('width', xScale2(dataRange[1]- xScale2(dataRange[0])))
      .attr('height', yScale2(options.targetLow)-yScale2(options.targetHigh))
      .style('fill', '#D6FFD6')
      .attr('stroke', 'grey');

    // create the x axis container
    context.append('g')
      .attr('class', 'x axis');

    // create the y axis container
    context.append('g')
      .attr('class', 'y axis');

    context.select('.y')
      .attr('transform', 'translate(' + (padding.left) + ',' + padding.top + ')')
      .style('stroke', 'black')
      .style('shape-rendering', 'crispEdges')
      .style('fill', 'none')
      .call(yAxis2);

    // if first run then just display axis with no transition
    context.select('.x')
      .attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
      .style('stroke', 'black')
      .style('shape-rendering', 'crispEdges')
      .style('fill', 'none')
      .call(xAxis2);

    _.each(tickValues, function (n, li) {
      context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(dataRange[0])+padding.left)
        .attr('y1', yScale2(tickValues[li])+padding.top)
        .attr('x2', xScale2(dataRange[1])+padding.left)
        .attr('y2', yScale2(tickValues[li])+padding.top)
        .style('stroke-dasharray', ('1, 5'))
        .attr('stroke', 'grey');
    });

    // bind up the context chart data to an array of circles
    var contextCircles = context.selectAll('circle')
        .data(data.sgv);

    function prepareContextCircles(sel) {
      var badData = [];
      sel.attr('cx', function (d) {
        return xScale2(d.date) + padding.left;
        })
          .attr('cy', function (d) {
            if (isNaN(d.sgv)) {
                badData.push(d);
                return yScale2(client.utils.scaleMgdl(450) + padding.top);
            } else {
                return yScale2(d.sgv) + padding.top;
            }
          })
          .attr('fill', function (d) {
            if (d.color === 'gray' && !options.raw) {
               return 'transparent';
            }
            return d.color;
          })
          .style('opacity', function () { return 0.5 })
          .attr('stroke-width', function (d) {if (d.type === 'mbg') { return 2; } else if (options.openAps && d.openaps) { return 1; } else { return 0; }})
          .attr('stroke', function () { return 'black'; })
          .attr('r', function(d) {
            if (d.type === 'mbg') {
              return 4;
            } else {
              return 2 + (options.width - 800) / 400;
            }
          })
          .on('mouseover', function (d) {
            if (options.openAps && d.openaps) {
              client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
              var text = '<b>BG:</b> ' + d.openaps.suggested.bg
                + ', ' + d.openaps.suggested.reason
                + (d.openaps.suggested.mealAssist ? ' <b>Meal Assist:</b> ' + d.openaps.suggested.mealAssist : '');
              client.tooltip.html(text)
                .style('left', (d3.event.pageX) + 'px')
                .style('top', (d3.event.pageY + 15) + 'px');
            }
          })
          .on('mouseout', hideTooltip);

          if (badData.length > 0) {
            console.warn('Bad Data: isNaN(sgv)', badData);
          }
          return sel;
      }

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit()
      .remove();

    var to = moment(day).add(1, 'days');
    var from = moment(day);
    var iobpolyline = '', cobpolyline = '';

    // basals data
    var linedata = [];
    var notemplinedata = [];
    var basalareadata = [];
    var tempbasalareadata = [];
    var comboareadata = [];
    var lastbasal = 0;
    var lastDt = from;
    var lastIOB;
    var basals = context.append('g');

    data.netBasalPositive = [];
    data.netBasalNegative = [];
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23].forEach(function(hour) {
      data.netBasalPositive[hour] = 0;
      data.netBasalNegative[hour] = 0;
    });

    profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

    var bolusInsulin = 0;
    var baseBasalInsulin = 0;
    var positiveTemps = 0;
    var negativeTemps = 0;

    iobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
    cobpolyline += (xScale2(moment(from)) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
    var timestart = new Date();
    var cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
    var iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);

    console.log("Device COB status available: ", cobStatusAvailable);
    console.log("Device IOB status available: ", iobStatusAvailable);

    for (var dt=moment(from); dt < to; dt.add(5, 'minutes')) {
      if (options.iob && !iobStatusAvailable) {
        var iob = client.plugins('iob').calcTotal(datastorage.treatments,datastorage.devicestatus,profile,dt.toDate()).iob;
        // make the graph discontinuous when data is missing
        if (iob === undefined) {
          iobpolyline += ', ' + (xScale2(lastDt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
          iobpolyline += ', ' + (xScale2(dt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
        } else {
          if (lastIOB === undefined) {
            iobpolyline += ', ' + (xScale2(dt) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
          }
          iobpolyline += ', '+ (xScale2(dt) + padding.left) + ',' + (yInsulinScale(iob) + padding.top);
        }
        lastDt = dt.clone();
        lastIOB = iob;
      }
      if (options.cob && !cobStatusAvailable) {
        var cob = client.plugins('cob').cobTotal(datastorage.treatments,datastorage.devicestatus,profile,dt.toDate()).cob;
        if (!dt.isSame(from)) {
          cobpolyline += ', ';
        }
        cobpolyline += (xScale2(dt.toDate()) + padding.left) + ',' + (yCarbsScale(cob) + padding.top) + ' ';
      }
      if (options.basal)  {
        var date = dt.format('x');
        var hournow = dt.hour();
        var basalvalue = profile.getTempBasal(date);
        // Calculate basal stats
        baseBasalInsulin += basalvalue.basal * 5 / 60; // 5 minutes part
        var tempPart = (basalvalue.tempbasal - basalvalue.basal) * 5 / 60;
        if (tempPart > 0) {
          positiveTemps += tempPart;
          data.netBasalPositive[hournow] += tempPart;
        } if (tempPart < 0) {
          negativeTemps += tempPart;
          data.netBasalNegative[hournow] += tempPart;
        }

        if (!_.isEqual(lastbasal, basalvalue)) {
          linedata.push( { d: date, b: basalvalue.totalbasal } );
          notemplinedata.push( { d: date, b: basalvalue.basal } );
          if (basalvalue.combobolustreatment && basalvalue.combobolustreatment.relative) {
            tempbasalareadata.push( { d: date, b: basalvalue.tempbasal } );
            basalareadata.push( { d: date, b: 0 } );
            comboareadata.push( { d: date, b: basalvalue.totalbasal } );
          } else if (basalvalue.treatment) {
            tempbasalareadata.push( { d: date, b: basalvalue.totalbasal } );
            basalareadata.push( { d: date, b: 0 } );
            comboareadata.push( { d: date, b: 0 } );
          } else {
            tempbasalareadata.push( { d: date, b: 0 } );
            basalareadata.push( { d: date, b: basalvalue.totalbasal } );
            comboareadata.push( { d: date, b: 0 } );
          }
        }
        lastbasal = basalvalue;
      }
    }

    // Draw COB from devicestatuses if available
    if (cobStatusAvailable) {
      var lastdate = 0;
      var previousdate = 0;
      var cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(cobArray, function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          cobpolyline += ', ';
          cobpolyline += (xScale2(previousdate) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
          cobpolyline += ', ';
          cobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yCarbsScale(0) + padding.top) + ' ';
        }
        cobpolyline += ', ';
        cobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yCarbsScale(point.cob) + padding.top) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      cobpolyline += ', ' + (xScale2(lastdate) + padding.left) + ',' + (yCarbsScale(0) + padding.top);
    } else {
      cobpolyline += ', ' + (xScale2(to) + padding.left) + ',' + (yCarbsScale(0) + padding.top);
    }

    // Draw IOB from devicestatuses if available
    if (iobStatusAvailable) {
      var lastdate = 0;
      var previousdate = 0;
      var iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, from.valueOf(), to.valueOf());
      _.each(iobArray, function drawCob (point) {
        if (previousdate !== 0 && point.mills - previousdate > times.mins(15).msecs) {
          iobpolyline += ', ';
          iobpolyline += (xScale2(previousdate) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
          iobpolyline += ', ';
          iobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yInsulinScale(0) + padding.top) + ' ';
        }
        iobpolyline += ', ';
        iobpolyline += (xScale2(point.mills) + padding.left) + ',' + (yInsulinScale(point.iob) + padding.top) + ' ';
        if (point.mills > lastdate) lastdate = point.mills;
        previousdate = point.mills;
      });
      iobpolyline += ', ' + (xScale2(lastdate) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
    } else {
      iobpolyline += ', ' + (xScale2(to) + padding.left) + ',' + (yInsulinScale(0) + padding.top);
    }

    if (options.iob) {
      context.append('polyline')
        .attr('stroke', 'blue')
        .attr('opacity', '0.5')
        .attr('fill-opacity', '0.1')
        .attr('points',iobpolyline);
    }
    if (options.cob) {
      context.append('polyline')
        .attr('stroke', 'red')
        .attr('opacity', '0.5')
        .attr('fill-opacity', '0.1')
        .attr('points',cobpolyline);
    }

    if (options.basal) {
      var toTempBasal = profile.getTempBasal(to.format('x'));

      linedata.push( { d: to.format('x'), b: toTempBasal.totalbasal } );
      notemplinedata.push( { d: to.format('x'), b: toTempBasal.basal } );
      basalareadata.push( { d: to.format('x'), b: toTempBasal.basal } );
      tempbasalareadata.push( { d: to.format('x'), b: toTempBasal.totalbasal } );
      comboareadata.push( { d: to.format('x'), b: toTempBasal.totalbasal } );

      var basalMax = d3.max(linedata, function(d) { return d.b; });
      basalMax = Math.max(basalMax, d3.max(basalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(tempbasalareadata, function(d) { return d.b; }));
      basalMax = Math.max(basalMax, d3.max(comboareadata, function(d) { return d.b; }));

      yScaleBasals.domain([basalMax, 0]);

      var valueline = d3.svg.line()
        .interpolate('step-after')
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y(function(d) { return yScaleBasals(d.b) + padding.top; });

      var area = d3.svg.area()
        .interpolate('step-after')
        .x(function(d) { return xScale2(d.d) + padding.left; })
        .y0(yScaleBasals(0) + padding.top)
        .y1(function(d) { return yScaleBasals(d.b) + padding.top; });

      var g = basals.append('g');

      g.append('path')
        .attr('class', 'line basalline')
        .attr('stroke', '#0099ff')
        .attr('stroke-width', 1)
        .attr('fill', 'none')
        .attr('d', valueline(linedata))
        .attr('clip-path', 'url(#clip)');

      g.append('path')
        .attr('class', 'line notempline')
        .attr('stroke', '#0099ff')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', ('3, 3'))
        .attr('fill', 'none')
        .attr('d', valueline(notemplinedata))
        .attr('clip-path', 'url(#clip)');

      g.append('path')
        .attr('class', 'area basalarea')
        .datum(basalareadata)
        .attr('fill', '#0099ff')
        .attr('fill-opacity', .1)
        .attr('stroke-width', 0)
        .attr('d', area);

      g.append('path')
        .attr('class', 'area tempbasalarea')
        .datum(tempbasalareadata)
        .attr('fill', '#0099ff')
        .attr('fill-opacity', .3)
        .attr('stroke-width', 1)
        .attr('d', area);

      g.append('path')
        .attr('class', 'area comboarea')
        .datum(comboareadata)
        .attr('fill', 'url(#hash)')
        .attr('fill-opacity', .3)
        .attr('stroke-width', 1)
        .attr('d', area);

      datastorage.tempbasalTreatments.forEach(function (t) {
        // only if basal and focus interval overlap and there is a chance to fit
        if (t.mills < to.format('x') && t.mills + times.mins(t.duration).msecs > from.format('x')) {
          var text = g.append('text')
            .attr('class', 'tempbasaltext')
            .attr('font-size', '12px')
            .attr('font-weight', 'bold')
            .attr('fill', '#0099ff')
            .attr('text-anchor', 'middle')
            .attr('dy', '.35em')
            .attr('x', xScale2((Math.max(t.mills, from.format('x')) + Math.min(t.mills + times.mins(t.duration).msecs, to.format('x')))/2) + padding.left)
            .attr('y', yScaleBasals(0) - 10 + padding.top)
//            .text((t.percent ? (t.percent > 0 ? '+' : '') + t.percent + '%' : '') + (t.absolute ? Number(t.absolute).toFixed(2) + 'U' : ''));
          // better hide if not fit
          if (text.node().getBBox().width > xScale2(t.mills + times.mins(t.duration).msecs) - xScale2(t.mills)) {
            text.attr('display', 'none');
          }
        }
      });
    }


    data.treatments.forEach(function (treatment) {
      // Calculate bolus stats
      if (treatment.insulin) {
        bolusInsulin += treatment.insulin;
      }
      // Combo bolus part
      if (treatment.relative) {
        bolusInsulin += treatment.relative;
      }

      var renderNotes = treatment.notes && options.notes;

      if (treatment.eventType === 'Note' && !options.notes) return;

      if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 || renderNotes) {
        var lastfoodtext = foodtexts;
        var drawpointer = false;
        if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 && options.food) {
          var foods = treatment.boluscalc.foods;
          for (var fi=0; fi<foods.length; fi++) {
            var f = foods[fi];
            var text = ''+ f.name + ' ';
            text += ''+ (f.carbs*f.portions).toFixed(1) + ' g';
            context.append('text')
              .style('font-size', '10px')
              .style('font-weight', 'normal')
              .attr('fill', 'black')
              .attr('y', foodtexts * 15 + padding.top)
              .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
              .html(text);
            foodtexts = (foodtexts + 1) % 6;
            drawpointer = true;
          }
        }
        if (renderNotes && !treatment.duration && treatment.eventType !== 'Temp Basal') {
          context.append('text')
            .style('font-size', '10px')
            .style('font-weight', 'normal')
            .attr('fill', 'black')
            .attr('y', foodtexts * 15 + padding.top)
            .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
            .html(treatment.notes);
          foodtexts = (foodtexts+1)%6;
          drawpointer = true;
        }
        if (drawpointer) {
          context.append('line')
            .attr('class', 'high-line')
            .attr('x1', xScale2(treatment.mills) + padding.left)
            .attr('y1', lastfoodtext * 15 + padding.top)
            .attr('x2', xScale2(treatment.mills) + padding.left)
            .attr('y2', padding.top + treatment.carbs ? yCarbsScale(treatment.carbs) : ( treatment.insulin ? yInsulinScale(treatment.insulin) : chartHeight))
            .style('stroke-dasharray', ('1, 7'))
            .attr('stroke', 'grey');
        }
      }

      if (treatment.carbs && options.carbs) {
        var ic = profile.getCarbRatio(new Date(treatment.mills));
        context.append('rect')
          .attr('y',yCarbsScale(treatment.carbs))
          .attr('height', chartHeight-yCarbsScale(treatment.carbs))
          .attr('width', 5)
          .attr('stroke', 'red')
          .attr('opacity', '0.5')
          .attr('fill', 'red')
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + +padding.top + ')');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'red')
          .attr('transform', 'rotate(-45,' + (xScale2(treatment.mills) + padding.left) + ',' + (padding.top+yCarbsScale(treatment.carbs)) + ') ' +
            'translate(' + (xScale2(treatment.mills) + padding.left +10) + ',' + (padding.top+yCarbsScale(treatment.carbs)) + ')')
          .text(treatment.carbs+' g ('+(treatment.carbs/ic).toFixed(2)+'U)');
      }

      if (treatment.insulin && options.insulin) {
        context.append('rect')
          .attr('y',yInsulinScale(treatment.insulin))
          .attr('height', chartHeight-yInsulinScale(treatment.insulin))
          .attr('width', 5)
          .attr('stroke', 'blue')
          .attr('opacity', '0.5')
          .attr('fill', 'blue')
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left - 2) + ',' + +padding.top + ')');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'blue')
          //.attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'rotate(-45,' + (xScale2(treatment.mills) + padding.left - 2) + ',' + (padding.top+yInsulinScale(treatment.insulin)) + ')' +
            'translate(' + (xScale2(treatment.mills) + padding.left + 10) + ',' + (padding.top+yInsulinScale(treatment.insulin)) + ')')
          .text(Number(treatment.insulin).toFixed(2)+'U');
      }

      // process the rest
      if (treatment.insulin || treatment.carbs || treatment.eventType == 'Temp Basal' || treatment.eventType == 'Combo Bolus') {
        // ignore
      } else if (treatment.eventType === 'Profile Switch') {
        // profile switch
        appendProfileSwitch(context, treatment);
        if (treatment.duration && !treatment.cuttedby) {
          appendProfileSwitch(context, {
            cutting: treatment.profile
            , profile: client.profilefunctions.activeProfileToTime(times.mins(treatment.duration).msecs + treatment.mills + 1)
            , mills: times.mins(treatment.duration).msecs + treatment.mills
            , end: true
          });
        }
      } else if (treatment.eventType === 'Exercise' && treatment.duration) {
        context.append('rect')
          .attr('x', xScale2(treatment.mills) + padding.left)
          .attr('y', yScale2(client.utils.scaleMgdl(396)) + padding.top)
          .attr('width', xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills))
          .attr('height', yScale2(client.utils.scaleMgdl(360)) - yScale2(client.utils.scaleMgdl(396)))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'Violet');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Violet')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', yScale2(client.utils.scaleMgdl(378)) + padding.top)
          .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs/2) + padding.left)
          .text(treatment.notes);
      } else if (treatment.eventType === 'Note' && treatment.duration) {
        context.append('rect')
          .attr('x', xScale2(treatment.mills) + padding.left)
          .attr('y', yScale2(client.utils.scaleMgdl(360)) + padding.top)
          .attr('width', xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills))
          .attr('height', yScale2(client.utils.scaleMgdl(324)) - yScale2(client.utils.scaleMgdl(360)))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'Salmon');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Salmon')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', yScale2(client.utils.scaleMgdl(342)) + padding.top)
          .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs/2) + padding.left)
          .text(treatment.notes);
      } else if (treatment.eventType === 'OpenAPS Offline' && treatment.duration) {
        context.append('rect')
          .attr('x', xScale2(treatment.mills) + padding.left)
          .attr('y', yScale2(client.utils.scaleMgdl(324)) + padding.top)
          .attr('width', xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills))
          .attr('height', yScale2(client.utils.scaleMgdl(288)) - yScale2(client.utils.scaleMgdl(324)))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'Brown');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'Brown')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', yScale2(client.utils.scaleMgdl(306)) + padding.top)
          .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs/2) + padding.left)
          .text(treatment.notes);
      } else if (!treatment.duration) {
      // other treatments without duration
        context.append('circle')
          .attr('cx', xScale2(treatment.mills) + padding.left)
          .attr('cy', yScale2(scaledTreatmentBG(treatment,data.sgv)) + padding.top)
          .attr('fill', 'purple')
          .style('opacity', 1)
          .attr('stroke-width', 1)
          .attr('stroke', 'black')
          .attr('r', 4);
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'purple')
          .attr('y', yScale2(scaledTreatmentBG(treatment,data.sgv)) + padding.top -10)
          .attr('x', xScale2(treatment.mills) + padding.left + 10)
          .text(translate(client.careportal.resolveEventName(treatment.eventType)));
      } else if (treatment.duration) {
      // other treatments with duration
        context.append('rect')
          .attr('x', xScale2(treatment.mills) + padding.left)
          .attr('y', yScale2(client.utils.scaleMgdl(432)) + padding.top)
          .attr('width', xScale2(treatment.mills + times.mins(treatment.duration).msecs) - xScale2(treatment.mills))
          .attr('height', yScale2(client.utils.scaleMgdl(396)) - yScale2(client.utils.scaleMgdl(432)))
          .attr('stroke-width', 1)
          .attr('opacity', .2)
          .attr('stroke', 'white')
          .attr('fill', 'black');
        context.append('text')
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .attr('fill', 'black')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('y', yScale2(client.utils.scaleMgdl(414)) + padding.top)
          .attr('x', xScale2(treatment.mills + times.mins(treatment.duration).msecs/2) + padding.left)
          .text(treatment.notes);
      } else {
        console.log("missed treatment", treatment);
      }
    });

    if (options.insulindistribution) {
      var boluscolor = 'blue';
      var basalcolor = '#0099ff';

      console.log('Insulin for day: ' + day + ' bolus: ' + bolusInsulin + ' basebasal: ' + baseBasalInsulin + ' positiveTemps: ' + positiveTemps + ' negativeTemps: ' + negativeTemps);
      var table = $('<table>');
      $('<tr><td><b>' + translate('Bolus insulin:') + '</b></td><td align="right">' + bolusInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      if (positiveTemps > 0 || negativeTemps > 0) {
        $('<tr><td>' + translate('Base basal insulin:') + '</td><td align="right">' + baseBasalInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      if (positiveTemps > 0) {
        $('<tr><td>' + translate('Positive temp basal insulin:') + '</td><td align="right">' + positiveTemps.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      if (negativeTemps < 0) {
        $('<tr><td>' + translate('Negative temp basal insulin:') + '</td><td align="right">' + negativeTemps.toFixed(1) + 'U</td></tr>').appendTo(table);
      }
      var totalBasalInsulin = baseBasalInsulin + positiveTemps + negativeTemps;
      $('<tr><td><b>' + translate('Total basal insulin:') + '</b></td><td align="right">' + totalBasalInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      var totalDailyInsulin = bolusInsulin + baseBasalInsulin + positiveTemps + negativeTemps;
      $('<tr><td><b>' + translate('Total daily insulin:') + '</b></td><td align="right">' + totalDailyInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      $('<tr><td colspan="2"><span id="daytodaystatinsulinpiechart-' + day + '"></span><span id="daytodaystatcarbspiechart-' + day + '"></span></td></tr>').appendTo(table);
      $('#daytodaystatchart-' + day).append(table);

      var chartData = [
        {
          label: translate('Basal'),
          count: totalBasalInsulin,
          pct: (totalBasalInsulin / totalDailyInsulin * 100).toFixed(0)
        },
        {label: translate('Bolus'), count: bolusInsulin, pct: (bolusInsulin / totalDailyInsulin * 100).toFixed(0)}
      ];

      // Insulin distribution chart
      var width = 120;
      var height = 120;
      var radius = Math.min(width, height) / 2;

      var color = d3.scale.ordinal().range([basalcolor, boluscolor]);

      var labelArc = d3.svg.arc()
          .outerRadius(radius / 2)
          .innerRadius(radius / 2);

      var svg = d3.select('#daytodaystatinsulinpiechart-' + day)
          .append('svg')
          .attr('width', width)
          .attr('height', height)
          .append('g')
          .attr('transform', 'translate(' + (width / 2) +
              ',' + (height / 2) + ')');

      var arc = d3.svg.arc()
          .outerRadius(radius);

      var pie = d3.layout.pie()
          .value(function (d) {
            return d.count;
          })
          .sort(null);

      var insulg = svg.selectAll('.insulinarc')
          .data(pie(chartData))
          .enter()
          .append('g')
          .attr('class', 'insulinarc');

      insulg.append('path')
          .attr('d', arc)
          .attr('opacity', '0.5')
          .attr('fill', function (d) {
            return color(d.data.label);
          });

      insulg.append('text')
          .attr('transform', function (d) {
            return 'translate(' + labelArc.centroid(d) + ')';
          })
          .attr('dy', '.15em')
          .style('font-weight', 'bold')
          .attr('text-anchor', 'middle')
          .text(function (d) {
            return d.data.pct + '%';
          });

      // Carbs pie chart

      var carbscolor = d3.scale.ordinal().range(['red']);

      var carbsData = [
        {label: translate('Carbs'), count: data.dailyCarbs}
      ];

      var carbssvg = d3.select('#daytodaystatcarbspiechart-' + day)
          .append('svg')
          .attr('width', width)
          .attr('height', height)
          .append('g')
          .attr('transform', 'translate(' + (width / 2) +
              ',' + (height / 2) + ')');

      var carbsarc = d3.svg.arc()
          .outerRadius(radius * data.dailyCarbs / options.maxDailyCarbsValue);

      var carbspie = d3.layout.pie()
          .value(function (d) {
            return d.count;
          })
          .sort(null);

      var carbsg = carbssvg.selectAll('.carbsarc')
          .data(carbspie(carbsData))
          .enter()
          .append('g')
          .attr('class', 'carbsarc');

      carbsg.append('path')
          .attr('d', carbsarc)
          .attr('opacity', '0.5')
          .attr('fill', function (d) {
            return carbscolor(d.data.label);
          });

      carbsg.append('text')
          .attr('transform', function () {
            return 'translate(0,0)';
          })
          .attr('dy', '.15em')
          .style('font-weight', 'bold')
          .attr('text-anchor', 'middle')
          .text(function (d) {
            return d.data.count + 'g';
          });
    }

    appendProfileSwitch(context, {
      //eventType: 'Profile Switch'
      profile: client.profilefunctions.activeProfileToTime(from)
      , mills: from + times.mins(15).msecs
      , first: true
    });

    function appendProfileSwitch(context, treatment) {
      var sign = treatment.first ? '▲▲▲' : '▬▬▬';
      var text;
      if (treatment.cutting) {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.cutting) + '    ' + '►►►' + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      } else  {
        text = sign + '    ' + client.profilefunctions.profileSwitchName(treatment.profile) + '    ' + sign;
      }
      context.append('text')
        .style('font-size', 12)
        .style('font-weight', 'bold')
        .attr('fill', '#0099ff')
        .attr('text-anchor', 'start')
        .attr('dy', '.35em')
        .attr('transform', 'rotate(-90 ' + (xScale2(treatment.mills)  + padding.left) + ',' + (yScaleBasals(0) + padding.top - 10) + ') ' +
          'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + (yScaleBasals(0) + padding.top - 10) + ')')
        .text(text);
    }

    console.log("Rendering " + day, new Date().getTime() - timestart.getTime(), "msecs");
  }

  function hideTooltip ( ) {
    client.tooltip.transition()
      .duration(TOOLTIP_TRANS_MS)
      .style('opacity', 0);
  }
};
