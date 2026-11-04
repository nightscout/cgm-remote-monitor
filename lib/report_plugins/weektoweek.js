'use strict';

var moment = window.moment;
var d3 = (global && global.d3) || require('../d3.mjs');
var times = require('../times');

var dayColors = [
  'rgb(31, 119, 180)'
  , 'rgb(255, 127, 14)'
  , 'rgb(44, 160, 44)'
  , 'rgb(214, 39, 40)'
  , 'rgb(148, 103, 189)'
  , 'rgb(140, 86, 75)'
  , 'rgb(23, 190, 207)'
];

var weektoweek = {
  name: 'weektoweek'
  , label: 'Week to week'
  , pluginType: 'report'
};

function init (ctx) {

  weektoweek.html = function html (client) {
    var translate = client.translate;
    var ret =
      '<h2>' + translate('Week to week') + '</h2>' +
      '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>' +
      '&nbsp;' + translate('Size') +
      ' <select id="wrp_size">' +
      '  <option x="800" y="250">800x250px</option>' +
      '  <option x="1000" y="300" selected>1000x300px</option>' +
      '  <option x="1200" y="400">1200x400px</option>' +
      '  <option x="1550" y="600">1550x600px</option>' +
      '</select>' +
      '<br>' +
      translate('Scale') + ': ' +
      '<input type="radio" name="wrp_scale" id="wrp_linear" checked>' +
      translate('Linear') +
      '<input type="radio" name="wrp_scale" id="wrp_log">' +
      translate('Logarithmic') +
      '<br>' +
      '<div id="weektoweekcharts">' +
      '</div>';
    return ret;
  };

  weektoweek.prepareHtml = function weektoweekPrepareHtml (weekstoshow) {
    $('#weektoweekcharts').html('');

    var translate = ctx.language.translate;

    var colorIdx = 0;

    var legend = '<table>';

    legend += '<tr><td><svg width="16" height="16"><g><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Sunday') + '</td>';
    legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Monday') + '</td>';
    legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Tuesday') + '</td>';
    legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Wednesday') + '</td></tr>';
    legend += '<tr><td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Thursday') + '</td>';
    legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx++] + '" r="40"></circle></g></svg></td><td>' + translate('Friday') + '</td>';
    legend += '<td><svg width="16" height="16"><circle fill="' + dayColors[colorIdx] + '" r="40"></circle></g></svg></td><td>' + translate('Saturday') + '</td></tr>';
    legend += '</table>';

    $('#weektoweekcharts').append($(legend));

    weekstoshow.forEach(function eachWeek (d) {
      $('#weektoweekcharts').append($('<div class="wtw-card"><table><tr><td><div id="weektoweekchart-' + d[0] + '-' + d[d.length - 1] + '"></div></td><td><div id="weektoweekstatchart-' + d[0] + '-' + d[d.length - 1] + '"></td></tr></table></div>'));
    });
  };

  weektoweek.report = function report_weektoweek (datastorage, sorteddaystoshow, options) {
    var Nightscout = window.Nightscout;
    var client = Nightscout.client;
    var report_plugins = Nightscout.report_plugins;
    var profile = client.sbx.data.profile;

    var padding = { top: 15, right: 22, bottom: 30, left: 35 };

    var weekstoshow = [];

    var startDay = profile.parseInTimezone(sorteddaystoshow[0]);

    sorteddaystoshow.forEach(function eachDay (day) {
      var weekNum = Math.abs(profile.parseInTimezone(day).diff(startDay, 'weeks'));

      if (typeof weekstoshow[weekNum] === 'undefined') {
        weekstoshow[weekNum] = [];
      }

      weekstoshow[weekNum].push(day);
    });
    weekstoshow = weekstoshow.map(function orderWeek (week) {
      return [...week].sort();
    });

    weektoweek.prepareHtml(weekstoshow);
    profile.loadData(datastorage.profiles);
    profile.updateTreatments(
      datastorage.profileSwitchTreatments,
      datastorage.tempbasalTreatments,
      datastorage.combobolusTreatments
    );

    var maxWeeklyCarbs = 0;
    weekstoshow.forEach(function eachCandidateWeek (candidateWeek) {
    var weekCarbs = candidateWeek.reduce(function sumCarbs (sum, day) {
      return sum + Number(datastorage[day].dailyCarbs || 0);
    }, 0);
    maxWeeklyCarbs = Math.max(maxWeeklyCarbs, weekCarbs);
    });

    weekstoshow.forEach(function eachWeek (week) {
      var sgvData = [];
      var weeklyStats = {
        bolusInsulin: 0,
        baseBasalInsulin: 0,
        positiveTemps: 0,
        negativeTemps: 0,
        carbs: 0,
        protein: 0,
        fat: 0
      };
      var weekStart = profile.parseInTimezone(week[0]);

      week.forEach(function eachDay (day) {
        var dayNum = Math.abs(profile.parseInTimezone(day).diff(weekStart, 'days'));

        var dayData = datastorage[day];

        weeklyStats.carbs += Number(dayData.dailyCarbs || 0);
        weeklyStats.protein += Number(dayData.dailyProtein || 0);
        weeklyStats.fat += Number(dayData.dailyFat || 0);

        dayData.treatments.forEach(function addBolus (treatment) {
          if (treatment.insulin) {
            weeklyStats.bolusInsulin += Number(treatment.insulin);
          }
          if (treatment.relative) {
            weeklyStats.bolusInsulin += Number(treatment.relative);
          }
        });

        var from = profile.parseInTimezone(day);
        var to = moment(from.clone()).add(1, 'days');
        var basalTimes = profile.getBasalRenderTimes(
          from.valueOf(),
          to.valueOf(),
          times.mins(5).msecs
        );

        basalTimes.forEach(function addBasal (date, index) {
          var nextDate = index + 1 < basalTimes.length ? basalTimes[index + 1] : to.valueOf();
          var durationHours = Math.max(0, Math.min(nextDate, to.valueOf()) - date) / times.hour().msecs;
          var basalValue = profile.getTempBasal(date);
          var tempPart = (basalValue.tempbasal - basalValue.basal) * durationHours;

          weeklyStats.baseBasalInsulin += basalValue.basal * durationHours;
          if (tempPart > 0) weeklyStats.positiveTemps += tempPart;
          if (tempPart < 0) weeklyStats.negativeTemps += tempPart;
        });

        datastorage[day].sgv.forEach(function eachSgv (sgv) {
          var sgvDate = profile.applyTimezone(moment(sgv.date));
          var sgvWeekday = sgvDate.day();
          var sgvColor = dayColors[sgvWeekday];

          if (sgv.color === 'gray') {
            sgvColor = sgv.color;
          }

          sgvData.push({
            'color': sgvColor
            , 'date': sgvDate.subtract(dayNum, 'days').toDate()
            , 'filtered': sgv.filtered
            , 'mills': sgv.mills - dayNum * 24 * 60 * 60000
            , 'noise': sgv.noise
            , 'sgv': sgv.sgv
            , 'type': sgv.type
            , 'unfiltered': sgv.unfiltered
            , 'y': sgv.y
          });
        });
      });

      drawChart(week, sgvData, weeklyStats, options);
    });

    function timeTicks (n, i) {
      var t12 = [
      '12am', '', '2am', '', '4am', '', '6am', '', '8am', '', '10am', ''
      , '12pm', '', '2pm', '', '4pm', '', '6pm', '', '8pm', '', '10pm', '', '12am'
    ];
      if (Nightscout.client.settings.timeFormat === 24) {
        return ('00' + i).slice(-2);
      } else {
        return t12[i];
      }
    }

    function drawChart (week, sgvData, weeklyStats, options) {
      var tickValues
        , charts
        , context
        , xScale2, yScale2
        , xAxis2, yAxis2
        , dateFn = function(d) { return new Date(d.date); };

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
      charts = d3.select('#weektoweekchart-' + week[0] + '-' + week[week.length - 1]).html(
        '<b>' +
        report_plugins.utils.localeDate(week[0]) +
        '-' +
        report_plugins.utils.localeDate(week[week.length - 1]) +
        '</b><br>'
      ).append('svg');

      charts.append('rect')
        .attr('width', '100%')
        .attr('height', '100%')
        .attr('fill', '#ffffff');

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
      yScale2.range([chartHeight, 0]);

      // add target BG rect
      context.append('rect')
        .attr('x', xScale2(dataRange[0]) + padding.left)
        .attr('y', yScale2(options.targetHigh) + padding.top)
        .attr('width', xScale2(dataRange[1] - xScale2(dataRange[0])))
        .attr('height', yScale2(options.targetLow) - yScale2(options.targetHigh))
        .style('fill', 'rgba(76,175,80,0.12)')
        .style('print-color-adjust', 'exact')
        .attr('stroke', 'none');

      // create the x axis container
      context.append('g')
        .attr('class', 'x axis');

      // create the y axis container
      context.append('g')
        .attr('class', 'y axis');

      context.select('.y')
        .attr('transform', 'translate(' + (padding.left) + ',' + padding.top + ')')
        .style('stroke', '#cfd8dc')
        .style('shape-rendering', 'crispEdges')
        .style('fill', 'none')
        .call(yAxis2)
        .selectAll('text')
        .style('stroke', 'none')
        .style('fill', '#607d8b');

      // if first run then just display axis with no transition
      context.select('.x')
        .attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
        .style('stroke', '#cfd8dc')
        .style('shape-rendering', 'crispEdges')
        .style('fill', 'none')
        .call(xAxis2)
        .selectAll('text')
        .style('stroke', 'none')
        .style('fill', '#607d8b');

      tickValues?.forEach(function(n, li) {
        context.append('line')
          .attr('class', 'high-line')
          .attr('x1', xScale2(dataRange[0]) + padding.left)
          .attr('y1', yScale2(tickValues[li]) + padding.top)
          .attr('x2', xScale2(dataRange[1]) + padding.left)
          .attr('y2', yScale2(tickValues[li]) + padding.top)
          .attr('stroke', '#eceff1');
      });

      // bind up the context chart data to an array of circles
      var contextCircles = context.selectAll('circle')
        .data(sgvData);

      function prepareContextCircles (sel) {
        var badData = [];
        sel.attr('cx', function(d) {
            return xScale2(d.date) + padding.left;
          })
          .attr('cy', function(d) {
            if (isNaN(d.sgv)) {
              badData.push(d);
              return yScale2(client.utils.scaleMgdl(450) + padding.top);
            } else {
              return yScale2(d.sgv) + padding.top;
            }
          })
          .attr('fill', function(d) {
            if (d.color === 'gray') {
              return 'transparent';
            }
            return d.color;
          })
          .style('opacity', function() { return 0.5 })
          .attr('stroke-width', function(d) { if (d.type === 'mbg') { return 2; } else { return 0; } })
          .attr('stroke', function() { return 'black'; })
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

      var table = $('<table>');
      var totalBasalInsulin = weeklyStats.baseBasalInsulin +
      weeklyStats.positiveTemps + weeklyStats.negativeTemps;
      var totalWeeklyInsulin = weeklyStats.bolusInsulin + totalBasalInsulin;

      $('<tr><td><b>Bolus insulin:</b></td><td align="right">' +
        weeklyStats.bolusInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      $('<tr><td><b>Total basal insulin:</b></td><td align="right">' +
        totalBasalInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      $('<tr><td><b>Total insulin for week:</b></td><td align="right">' +
        totalWeeklyInsulin.toFixed(1) + 'U</td></tr>').appendTo(table);
      $('<tr><td>Total carbs:</td><td align="right">' + weeklyStats.carbs + ' g</td></tr>').appendTo(table);
      $('<tr><td>Total protein:</td><td align="right">' + weeklyStats.protein + ' g</td></tr>').appendTo(table);
      $('<tr><td>Total fat:</td><td align="right">' + weeklyStats.fat + ' g</td></tr>').appendTo(table);
      var weekId = week[0] + '-' + week[week.length - 1];
      $('<tr><td colspan="2">' +'<span id="weektoweekstatinsulinpiechart-' + weekId + '"></span>' +'<span id="weektoweekstatcarbspiechart-' + weekId + '"></span>' +'</td></tr>').appendTo(table);
      $('#weektoweekstatchart-' + week[0] + '-' + week[week.length - 1]).append(table);

      var width = 120;
      var height = 120;
      var radius = Math.min(width, height) / 2;

      var insulinData = [
        {
          label: 'Basal',
          count: totalBasalInsulin,
          pct: totalWeeklyInsulin > 0
            ? (totalBasalInsulin / totalWeeklyInsulin * 100).toFixed(0)
            : 0
        },
        {
          label: 'Bolus',
          count: weeklyStats.bolusInsulin,
          pct: totalWeeklyInsulin > 0
            ? (weeklyStats.bolusInsulin / totalWeeklyInsulin * 100).toFixed(0)
            : 0
        }
      ];

      var insulinColor = d3.scaleOrdinal()
        .domain(['Basal', 'Bolus'])
        .range(['#0099ff', 'blue']);

      var insulinSvg = d3.select('#weektoweekstatinsulinpiechart-' + weekId)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');

      var insulinPie = d3.pie()
        .value(function(d) { return d.count; })
        .sort(null);

      var insulinArc = d3.arc()
        .innerRadius(0)
        .outerRadius(radius);

      var insulinLabelArc = d3.arc()
        .innerRadius(radius / 2)
        .outerRadius(radius / 2);

      var insulinGroups = insulinSvg.selectAll('.insulinarc')
        .data(insulinPie(insulinData))
        .enter()
        .append('g')
        .attr('class', 'insulinarc');

      insulinGroups.append('path')
        .attr('d', insulinArc)
        .attr('opacity', 0.5)
        .attr('fill', function(d) {
          return insulinColor(d.data.label);
        });

      insulinGroups.append('text')
        .attr('transform', function(d) {
          return 'translate(' + insulinLabelArc.centroid(d) + ')';
        })
        .attr('dy', '.15em')
        .style('font-weight', 'bold')
        .attr('text-anchor', 'middle')
        .text(function(d) {
          return d.data.pct + '%';
        });

      var carbsSvg = d3.select('#weektoweekstatcarbspiechart-' + weekId)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', 'translate(' + width / 2 + ',' + height / 2 + ')');

      var carbsRadius = maxWeeklyCarbs > 0
        ? radius * weeklyStats.carbs / maxWeeklyCarbs
        : 0;

      var carbsArc = d3.arc()
        .innerRadius(0)
        .outerRadius(carbsRadius);

      var carbsPie = d3.pie()
        .value(function(d) { return d.count; })
        .sort(null);

      var carbsGroups = carbsSvg.selectAll('.carbsarc')
        .data(carbsPie([{ label: 'Carbs', count: weeklyStats.carbs }]))
        .enter()
        .append('g')
        .attr('class', 'carbsarc');

      carbsGroups.append('path')
        .attr('d', carbsArc)
        .attr('opacity', 0.5)
        .attr('fill', 'red');

      carbsGroups.append('text')
        .attr('text-anchor', 'middle')
        .attr('dy', '.15em')
        .style('font-weight', 'bold')
        .text(weeklyStats.carbs.toFixed(0) + 'g');
      /**$('<tr><td><b>Bolus insulin:</b></td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td>Base basal insulin:</td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td>Positive temp basal insulin:</td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td>Negative temp basal insulin:</td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td><b>Total basal insulin:</b></td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td><b>Total daily insulin:</b></td><td align="right">0.0U</td></tr>').appendTo(table);
      $('<tr><td>Total carbs:</td><td align="right">0 g</td></tr>').appendTo(table);
      $('<tr><td>Total protein:</td><td align="right">0 g</td></tr>').appendTo(table);
      $('<tr><td>Total fat:</td><td align="right">0 g</td></tr>').appendTo(table);
      $('#weektoweekstatchart-' + week[0] + '-' + week[week.length - 1]).append(table);**/

      // if new circle then just display
      prepareContextCircles(contextCircles.enter().append('circle'));

      contextCircles.exit()
        .remove();
    }

    function hideTooltip () {
      client.tooltip.style('display', 'none');
    }
  };
  return weektoweek;
}

module.exports = init;
