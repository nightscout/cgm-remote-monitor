'use strict';

var _ = require('lodash');
var moment = window.moment;

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
      translate('Display') + ': '
    + '<input type="checkbox" id="rp_optionsinsulin" checked><span style="color:blue;opacity:0.5">'+translate('Insulin')+'</span>'
    + '<input type="checkbox" id="rp_optionscarbs" checked><span style="color:red;opacity:0.5">'+translate('Carbs')+'</span>'
    + '<input type="checkbox" id="rp_optionsnotes" checked>'+translate('Notes')
    + '<input type="checkbox" id="rp_optionsfood" checked>'+translate('Food')
    + '<input type="checkbox" id="rp_optionsraw"><span style="color:gray;opacity:1">'+translate('Raw')+'</span>'
    + '<input type="checkbox" id="rp_optionsiob"><span style="color:blue;opacity:0.5">'+translate('IOB')+'</span>'
    + '<input type="checkbox" id="rp_optionscob"><span style="color:red;opacity:0.5">'+translate('COB')+'</span>'
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
    $('#daytodaycharts').append($('<div id="daytodaychart-' + d + '"></div>'));
  });
};

daytoday.report = function report_daytoday(datastorage,sorteddaystoshow,options) {
  var Nightscout = window.Nightscout;
  var client = Nightscout.client;
  var translate = client.translate;
  var profile = client.sbx.data.profile;
  var report_plugins = Nightscout.report_plugins;
  var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;
  
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
    if (Nightscout.client.settings.timeFormat === '24') {
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
      , yInsulinScale, yCarbsScale
      , xAxis2, yAxis2
      , dateFn = function (d) { return new Date(d.date) }
      , foodtexts = 0;

    // Tick Values
    if (options.scale === report_plugins.consts.SCALE_LOG) {
      if (client.settings.units === 'mmol') {
        tickValues = [
            2.0
          , 3.0
          , options.targetLow
          , 6.0
          , 8.0
          , options.targetHigh
          , 16.0
          , 22.0
        ];
      } else {
        tickValues = [
            40
          , 60
          , options.targetLow
          , 120
          , 160
          , options.targetHigh
          , 250
          , 400
        ];
      }
    } else {
      if (client.settings.units === 'mmol') {
        tickValues = [
            2.0
          , 4.0
          , 6.0
          , 8.0
          , 10.0
          , 12.0
          , 14.0
          , 16.0
          , 18.0
          , 20.0
          , 22.0
        ];
      } else {
        tickValues = [
            40
          , 80
          , 120
          , 160
          , 200
          , 240
          , 280
          , 320
          , 360
          , 400
        ];
      }
    }
    
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
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    } else {
      yScale2 = d3.scale.linear()
        .domain([client.utils.scaleMgdl(36), client.utils.scaleMgdl(420)]);
    }

    yInsulinScale = d3.scale.linear()
      .domain([0, options.maxInsulinValue*2]);

    yCarbsScale = d3.scale.linear()
      .domain([0, options.maxCarbsValue*1.25]);

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
    yInsulinScale.range([chartHeight,0]);
    yCarbsScale.range([chartHeight,0]);

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
      .attr('transform', 'translate(' + (/*chartWidth + */ padding.left) + ',' + padding.top + ')')
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
        .style('stroke-dasharray', ('3, 3'))
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
          .attr('stroke-width', function (d) {if (d.type === 'mbg') { return 2; } else { return 0; }})
          .attr('stroke', function () { return 'black'; })
          .attr('r', function(d) { if (d.type === 'mbg') { return 4; } else { return 2; }});

          if (badData.length > 0) {
            console.warn('Bad Data: isNaN(sgv)', badData);
          }
          return sel;
      }

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit()
      .remove();

    var to = moment(day).add(1, 'days'); //.add(new Date().getTimezoneOffset(), 'minutes');
    var from = moment(day); //.add(new Date().getTimezoneOffset(), 'minutes');
    var iobpolyline = '', cobpolyline = '';
    for (var dt=from; dt < to; dt.add(5, 'minutes')) {
      if (options.iob) {
        var iob = Nightscout.plugins('iob').calcTotal(data.treatments,profile,dt.toDate()).iob;
        if (dt!==from) {
          iobpolyline += ', ';
        }
        iobpolyline += (xScale2(dt) + padding.left) + ',' + (yInsulinScale(iob) + padding.top) + ' ';
      }
      if (options.cob) {
        var cob = Nightscout.plugins('cob').cobTotal(data.treatments,profile,dt.toDate()).cob;
        if (dt!==from) {
          cobpolyline += ', ';
        }
        cobpolyline += (xScale2(dt.toDate()) + padding.left) + ',' + (yCarbsScale(cob) + padding.top) + ' ';
      }
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

    data.treatments.forEach(function (treatment) {
      if (treatment.boluscalc && treatment.boluscalc.foods && treatment.boluscalc.foods.length > 0 || treatment.notes) {
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
              .attr('y', foodtexts * 15)
              .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + padding.top + ')')
              .html(text);
            foodtexts = (foodtexts+1)%6;
            drawpointer = true;
          }
        }
        if (treatment.notes && options.notes) {
          context.append('text')
            .style('font-size', '10px')
            .style('font-weight', 'normal')
            .attr('fill', 'black')
            .attr('y', foodtexts * 15)
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
          .attr('y', yCarbsScale(treatment.carbs)-10)
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left) + ',' + +padding.top + ')')
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
          .attr('y', yInsulinScale(treatment.insulin)-10)
          .attr('transform', 'translate(' + (xScale2(treatment.mills) + padding.left - 2) + ',' + +padding.top + ')')
          .text(treatment.insulin+'U');
      }
      // other treatments
      if (!treatment.insulin && !treatment.carbs) {
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
      }
    });
  }
};
