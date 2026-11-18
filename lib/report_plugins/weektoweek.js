'use strict';

const moment = window.moment;
const d3 = (global && global.d3) || require('d3');

const dayClasses = [
  'weekday-sunday'
  
  , 'weekday-monday'
  
  , 'weekday-tuesday'
  
  , 'weekday-wednesday'
  
  , 'weekday-thursday'
  
  , 'weekday-friday'
  
  , 'weekday-saturday'
];

const weektoweek = {
  name: 'weektoweek'
  , label: 'Week to week'
  , pluginType: 'report'
};

function init (ctx) {

  weektoweek.html = function html (client) {
    const translate = client.translate;
    return `<h2>${translate('Week to week')}</h2>
<b>${translate('To see this report, press SHOW while in this view')}</b><br>
${translate('Scale')}:
<input type="radio" name="wrp_scale" id="wrp_linear" checked>${translate('Linear')}
<input type="radio" name="wrp_scale" id="wrp_log">${translate('Logarithmic')}
<br>
<div id="weektoweekcharts"></div>
`;
  };

  weektoweek.prepareHtml = function weektoweekPrepareHtml (weekstoshow) {
    let weekToWeekCharts = $('#weektoweekcharts');
    weekToWeekCharts.html('');

    const translate = ctx.language.translate;

    const legend = `<table>
<tr>
<td><svg width="16" height="16"><circle class="${dayClasses[0]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Sunday')}</td>
<td><svg width="16" height="16"><circle class="${dayClasses[1]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Monday')}</td>
<td><svg width="16" height="16"><circle class="${dayClasses[2]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Tuesday')}</td>
<td><svg width="16" height="16"><circle class="${dayClasses[3]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Wednesday')}</td>
</tr>
<tr>
<td><svg width="16" height="16"><circle class="${dayClasses[4]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Thursday')}</td>
<td><svg width="16" height="16"><circle class="${dayClasses[5]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Friday')}</td>
<td><svg width="16" height="16"><circle class="${dayClasses[6]}" cx="8" cy="8" r="6"></circle></svg></td><td>${translate('Saturday')}</td>
</tr>
</table>`;

    weekToWeekCharts.append($(legend));

    weekstoshow.forEach(function eachWeek (d) {
      weekToWeekCharts.append($(`<div id="weektoweekchart-${d[0]}-${d[d.length - 1]}"></div>`));
    });
  };

  weektoweek.report = function report_weektoweek (datastorage, sorteddaystoshow, options) {
    const Nightscout = window.Nightscout;
    const client = Nightscout.client;
    const report_plugins = Nightscout.report_plugins;
    const profile = client.sbx.data.profile;

    const padding = { top: 15, right: 22, bottom: 30, left: 35 };

    let weekstoshow = [];

    const startDay = profile.parseInTimezone(sorteddaystoshow[0]);

    sorteddaystoshow.forEach(function eachDay (day) {
      const weekNum = Math.abs(profile.parseInTimezone(day).diff(startDay, 'weeks'));

      if (typeof weekstoshow[weekNum] === 'undefined') {
        weekstoshow[weekNum] = [];
      }

      weekstoshow[weekNum].push(day);
    });
    weekstoshow = weekstoshow.map(function orderWeek (week) {
      return [...week].sort();
    });

    weektoweek.prepareHtml(weekstoshow);

    weekstoshow.forEach(function eachWeek (week) {
      const sgvData = [];
      const weekStart = profile.parseInTimezone(week[0]);

      week.forEach(function eachDay (day) {
        const dayNum = Math.abs(profile.parseInTimezone(day).diff(weekStart, 'days'));

        datastorage[day].sgv.forEach(function eachSgv (sgv) {
          const sgvDate = profile.applyTimezone(moment(sgv.date));
          const sgvWeekday = sgvDate.day();
          let sgvColor = 'weekday';

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
            , 'weekday': sgvWeekday
            , 'y': sgv.y
          });
        });
      });

      drawChart(week, sgvData, options);
    });

    function timeTicks (n, i) {
      const t12 = [
        '12am', '', '2am', '', '4am', '', '6am', '', '8am', '', '10am', ''
        
        , '12pm', '', '2pm', '', '4pm', '', '6pm', '', '8pm', '', '10pm', '', '12am'
      ];
      if (Nightscout.client.settings.timeFormat === 24) {
        return (`00${i}`).slice(-2);
      } else {
        return t12[i];
      }
    }

    function drawChart (week, sgvData, options) {
      let tickValues
        , charts
        , context
        , xScale2, yScale2
        , xAxis2, yAxis2;
      const dateFn = function(d) {
        return new Date(d.date);
      };

      tickValues = client.ticks(client, {
        scaleY: options.weekscale === report_plugins.consts.SCALE_LOG ? 'log' : 'linear'
        , targetTop: options.targetHigh
        , targetBottom: options.targetLow
      });

      // add defs for combo boluses
      const dashWidth = 5;
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
        .attr('class', 'combo-pattern')
        .append('path').attr('d', `M0,0 l${dashWidth},${dashWidth}`)
        .append('path').attr('d', `M${dashWidth},0 l-${dashWidth},${dashWidth}`);

      // create svg and g to contain the chart contents
      const chartContainer = d3.select(`#weektoweekchart-${week[0]}-${week[week.length - 1]}`).html(
        `<b>${report_plugins.utils.localeDate(week[0])}-${report_plugins.utils.localeDate(week[week.length - 1])}</b><br>`
      ).append('div').attr('class', 'chart weektoweek-chart');
      const container = chartContainer.node();
      const width = container && container.clientWidth ? container.clientWidth : 800;
      const height = container && container.clientHeight ? container.clientHeight : 500;
      const chartWidth = Math.max(100, width - padding.left - padding.right);
      const chartHeight = Math.max(100, height - padding.top - padding.bottom);
      charts = chartContainer.append('svg')
        .attr('viewBox', '0 0 ' + width + ' ' + height)
        .attr('preserveAspectRatio', 'xMidYMid meet');

      charts.append('rect')
        .attr('class', 'chart-background')
        .attr('width', '100%')
        .attr('height', '100%');

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
      const dataRange = d3.extent(sgvData, dateFn);

      // ranges are based on the width and height available so reset
      xScale2.range([0, chartWidth]);
      yScale2.range([chartHeight, 0]);

      // add target BG rect
      context.append('rect')
        .attr('class', 'target-bg')
        .attr('x', xScale2(dataRange[0]) + padding.left)
        .attr('y', yScale2(options.targetHigh) + padding.top)
        .attr('width', chartWidth)
        .attr('height', yScale2(options.targetLow) - yScale2(options.targetHigh));

      // create the x axis container
      context.append('g')
        .attr('class', 'x axis');

      // create the y axis container
      context.append('g')
        .attr('class', 'y axis');

      context.select('.y')
        .attr('transform', `translate(${padding.left},${padding.top})`)
        .call(yAxis2);

      // if first run then just display axis with no transition
      context.select('.x')
        .attr('transform', `translate(${padding.left},${chartHeight + padding.top})`)
        .call(xAxis2);
      tickValues?.forEach(function(n, li) {
        context.append('line')
          .attr('class', 'high-line')
          .attr('x1', xScale2(dataRange[0]) + padding.left)
          .attr('y1', yScale2(tickValues[li]) + padding.top)
          .attr('x2', xScale2(dataRange[1]) + padding.left)
          .attr('y2', yScale2(tickValues[li]) + padding.top);
      });

      // bind up the context chart data to an array of circles
      const contextCircles = context.selectAll('circle')
        .data(sgvData);

      function prepareContextCircles (sel) {
        const badData = [];
        sel.attr('class', function(d) {
            const classes = ['measurement'];
            if (d.color === 'gray') classes.push('transparent');
            else if (d.color === 'red') classes.push('critical-value');
            else if (d.color === 'purple') classes.push('prediction-value');
            else classes.push(dayClasses[d.weekday] || 'normal-value');
            if (d.type === 'mbg') classes.push('mbg');
            return classes.join(' ');
          })
          .attr('cx', function(d) {
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

    function hideTooltip () {
      client.tooltip.style('display', 'none');
    }
  };
  return weektoweek;
}

module.exports = init;
