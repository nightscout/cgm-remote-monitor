'use strict';

var _ = require('lodash');
var moment = window.moment;
var d3 = (global && global.d3) || require('d3');

var dayColors = [
  'rgb(73, 22, 153)'
  , 'rgb(34, 201, 228)'
  , 'rgb(0, 153, 123)'
  , 'rgb(135, 135, 228)'
  , 'rgb(135, 49, 204)'
  , 'rgb(36, 36, 228)'
  , 'rgb(0, 234, 188)'
];

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

  var colorIdx = 0;

  var legend = '<table>';

  legend += '<tr><td><svg width="16" height="16"><g><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Sunday</td>';
  legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Monday</td>';
  legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Tuesday</td>';
  legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Wednesday</td></tr>';
  legend += '<tr><td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Thursday</td>';
  legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Friday</td>';
  legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>Saturday</td></tr>';
  legend += '</table>';

  $('#weektoweekcharts').append($(legend));

  weekstoshow.forEach(function eachWeek(d) {
    $('#weektoweekcharts').append($('<table><tr><td><div id="weektoweekchart-' + d[0] + '-' + d[d.length-1] + '"></div></td><td><div id="weektoweekstatchart-' + d[0] + '-' + d[d.length-1] + '"></td></tr></table>'));
  });
};

weektoweek.report = function report_weektoweek(datastorage, sorteddaystoshow, options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var report_plugins = Nightscout.report_plugins;
  
  var padding = { top: 15, right: 22, bottom: 30, left: 35 };

  var weekstoshow = [ ];

  var startDay = moment(sorteddaystoshow[0] + ' 00:00:00');

  sorteddaystoshow.forEach( function eachDay(day) {
    var weekNum = Math.abs(moment(day + ' 00:00:00').diff(startDay, 'weeks'));

    if (typeof weekstoshow[weekNum] === 'undefined') {
      weekstoshow[weekNum] = [ ];
    }

    weekstoshow[weekNum].push(day);
  });

  weekstoshow = weekstoshow.map(function orderWeek(week) {
    return _.sortBy(week);
  });

  weektoweek.prepareHtml(weekstoshow);

  weekstoshow.forEach( function eachWeek(week) {
    var sgvData = [ ];
    var weekStart = moment(week[0] + ' 00:00:00');

    week.forEach( function eachDay(day) {
      var dayNum = Math.abs(moment(day + ' 00:00:00').diff(weekStart, 'days'));

      datastorage[day].sgv.forEach ( function eachSgv(sgv) {
        var sgvWeekday = moment(sgv.date).day();
        var sgvColor = dayColors[sgvWeekday];

        if (sgv.color === 'gray') {
          sgvColor = sgv.color;
        }

        sgvData.push( {
          'color': sgvColor
          , 'date': moment(sgv.date).subtract(dayNum, 'days').toDate()
          , 'filtered': sgv.filtered
          , 'mills': sgv.mills - dayNum * 24*60*60000
          , 'noise': sgv.noise
          , 'sgv': sgv.sgv
          , 'type': sgv.type
          , 'unfiltered': sgv.unfiltered
          , 'y': sgv.y
        });
      });
    });

    drawChart(week, sgvData, options);
  });

  function timeTicks(n, i) {
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
  
  function drawChart(week, sgvData, options) {
    var tickValues
      , charts
      , context
      , xScale2, yScale2
      , xAxis2, yAxis2
      , dateFn = function (d) { return new Date(d.date); };

   tickValues = client.ticks(client, {
     scaleY: options.weekscale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
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
    xScale2 = d3.scaleTime()
      .domain(d3.extent(sgvData, dateFn));

    if (options.weekscale === report_plugins.consts.SCALE_LOG) {
      yScale2 = d3.scaleLog()
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scaleLinear()
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    }

    xAxis2 = d3.axisBottom(xScale2)
      .tickFormat(timeTicks)
      .ticks(24);

    yAxis2 = d3.axisLeft(yScale2)
      .tickFormat(d3.format('d'))
      .tickValues(tickValues);

    // get current data range
    var dataRange = d3.extent(sgvData, dateFn);

    // get the entire container height and width subtracting the padding
    var chartWidth = options.weekwidth - padding.left - padding.right;
    var chartHeight = options.weekheight - padding.top - padding.bottom;

    //set the width and height of the SVG element
    charts.attr('width', options.weekwidth)
      .attr('height', options.weekheight);
    
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
              return 2 + (options.weekwidth - 800) / 400; 
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
    client.tooltip.style('opacity', 0);
  }
};
