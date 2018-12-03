'use strict';

var _ = require('lodash');
var moment = window.moment;
var times = require('../times');
var d3 = (global && global.d3) || require('d3');

var weektoweek = {
  name: 'weektoweek'
  , label: 'Week to week'
  , pluginType: 'report'
};

function init() {
  return weektoweek;
}

module.exports = init;

weektoweek.html = function html(client) {
  var translate = client.translate;
  var ret =
    '<h2>' + translate('Week to week') + '</h2>'
    + '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>'
    + '&nbsp;'+translate('Size')
    + ' <select id="wrp_size">'
    + '  <option x="800" y="250">800x250px</option>'
    + '  <option x="1000" y="300" selected>1000x300px</option>'
    + '  <option x="1200" y="400">1200x400px</option>'
    + '  <option x="1550" y="600">1550x600px</option>'
    + '</select>'
    + '<br>'
    + translate('Scale') + ': '
    + '<input type="radio" name="wrp_scale" id="wrp_linear" checked>'
    + translate('Linear')
    + '<input type="radio" name="wrp_scale" id="wrp_log">'
    + translate('Logarithmic')
    + '<br>'
    + '<div id="weektoweekcharts">'
    + '</div>'
    ;
    return ret;
};

weektoweek.prepareHtml = function weektoweekPrepareHtml(weekstoshow) {
  $('#weektoweekcharts').html('');
  weekstoshow.forEach(function eachWeek(d) {
    $('#weektoweekcharts').append($('<table><tr><td><div id="weektoweekchart-' + d[0] + '-' + d[d.length-1] + '"></div></td><td><div id="weektoweekstatchart-' + d[0] + '-' + d[d.length-1] + '"></td></tr></table>'));
  });
};

weektoweek.report = function report_weektoweek(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;
  
  var TOOLTIP_TRANS_MS = 300;

  var padding = { top: 15, right: 22, bottom: 30, left: 35 };

  var tddSum = 0;
  var carbsSum = 0;

  var weekstoshow = [ ];
  weekstoshow[0] = [ ];
  var weekIdx = 0;
  var dayIdx = 0;
  var reset_day = 0;

  if (sorteddaystoshow[0] > sorteddaystoshow[sorteddaystoshow.length]) {
    reset_day = moment.localeData().firstDayOfWeek() - 1;
    if (reset_day < 0) {
      reset_day += 7;
    }
  } else {
    reset_day = moment.localeData().firstDayOfWeek();
  }

  sorteddaystoshow.forEach( function eachDay(day) {
    if (moment(day).day() === reset_day) {
      weekIdx += 1;
      weekstoshow[weekIdx] = [ ];
      weekstoshow[weekIdx][0] = day;
      dayIdx = 0;
    } else {
      weekstoshow[weekIdx][dayIdx] = day;
      dayIdx += 1;
    }
  });

  weekstoshow = weekstoshow.map(function orderWeek(week) {
    return _.sortBy(week);
  });

  weektoweek.prepareHtml(weekstoshow);

  weekstoshow.forEach( function eachWeek(week) {
    var sgvData = [ ];
    var currDay = 0;

    week.forEach( function eachDay(day) {
      console.log('Rectifying day: ' + day);
      console.log('First sgv: ' + datastorage[day].sgv[0].date + ' last sgv: ' + datastorage[day].sgv[datastorage[day].sgv.length - 1].date);
      datastorage[day].sgv.forEach ( function eachSgv(sgv) {
        sgvData.push( {
          'color': sgv.color
          , 'date': moment(sgv.date).subtract(currDay, 'days').toDate()
          , 'filtered': sgv.filtered
          , 'mills': sgv.mills - currDay * 24*60*60000
          , 'noise': sgv.noise
          , 'sgv': sgv.sgv
          , 'type': sgv.type
          , 'unfiltered': sgv.unfiltered
          , 'y': sgv.y
        });
      });

      console.log('First sgv: ' + sgvData[0].date + ' last sgv: ' + sgvData[sgvData.length - 1].date);

      currDay += 1;
    });

    drawChart(week, sgvData, options);
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
  
  function drawChart(week,sgvData,options) {
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
    charts = d3.select('#weektoweekchart-' + week[0] + '-' + week[week.length-1]).html(
      '<b>'+
      report_plugins.utils.localeDate(week[0])+
      '-' +
      report_plugins.utils.localeDate(week[week.length-1])+
      '</b><br>'
      ).append('svg');

    charts.append('rect')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('fill', 'WhiteSmoke');
    
    context = charts.append('g');

    // define the parts of the axis that aren't dependent on width or height
    xScale2 = d3.time.scale()
      .domain(d3.extent(sgvData, dateFn));

    if (options.scale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scale.log()
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scale.linear()
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    }

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
    var dataRange = d3.extent(sgvData, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = options.width - padding.left - padding.right;
    var chartHeight = options.height - padding.top - padding.bottom;

    //set the width and height of the SVG element
    charts.attr('width', options.width)
      .attr('height', options.height);
    
    // ranges are based on the width and height available so reset
    xScale2.range([0, chartWidth]);
    yScale2.range([chartHeight,0]);

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
        .data(sgvData);

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
            if (d.color === 'gray') {
               return 'transparent';
            }
            return d.color; 
          })
          .style('opacity', function () { return 0.5 })
          .attr('stroke-width', function (d) {if (d.type === 'mbg') { return 2; } else { return 0; }})
          .attr('stroke', function () { return 'black'; })
          .attr('r', function(d) { 
            if (d.type === 'mbg') { 
              return 4; 
            } else { 
              return 2 + (options.width - 800) / 400; 
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
  }

  function hideTooltip ( ) {
    client.tooltip.transition()
      .duration(TOOLTIP_TRANS_MS)
      .style('opacity', 0);
  }
};
