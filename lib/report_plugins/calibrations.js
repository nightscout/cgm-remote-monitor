'use strict';
const translate = require('../language')().translate;
const d3 = (global && global.d3) || require('d3');
const textAsHtml = require('../utils/html').textAsHtml;

const calibrations = {
  name: 'calibrations'
  , label: 'Calibrations'
  , pluginType: 'report'
};

function init () {
  return calibrations;
}

module.exports = init;

calibrations.html = function html (client) {
  const translate = client.translate;
  return '<h2>' + translate('Calibrations') + '</h2>' +
    '<div id="calibrations-list"></div>' +
    '<div id="calibrations-chart"></div>';
};

calibrations.report = function report_calibrations (datastorage, sorteddaystoshow) {
  let e;
  let i;
  const Nightscout = window.Nightscout;
  const report_plugins = Nightscout.report_plugins;

  const padding = { top: 15, right: 15, bottom: 30, left: 70 };
  let treatments = [];
  sorteddaystoshow.forEach(function(day) {
    treatments = treatments.concat(datastorage[day].treatments.filter(function(t) {
      if (t.eventType === 'Sensor Start') {
        return true;
      }

      return t.eventType === 'Sensor Change';
    }));
  });

  let cals = [];
  sorteddaystoshow.forEach(function(day) {
    cals = cals.concat(datastorage[day].cal);
  });

  let sgvs = [];
  sorteddaystoshow.forEach(function(day) {
    sgvs = sgvs.concat(datastorage[day].sgv);
  });

  let mbgs = [];
  sorteddaystoshow.forEach(function(day) {
    mbgs = mbgs.concat(datastorage[day].mbg);
  });
  mbgs.forEach(function(mbg) { calcmbg(mbg); });

  const events = treatments.concat(cals).concat(mbgs).sort(function(a, b) {
    return a.mills - b.mills;
  });

  const colors = ['aqua', 'blue', 'brown', 'chartreuse', 'coral', 'cornflower-blue', 'dark-cyan', 'dark-magenta', 'dark-orange', 'fuchsia', 'green', 'yellow'];
  let colorindex = 0;
  let html = '<table>';
  let lastmbg = null;

  for (let i = 0; i < events.length; i++) {
    e = events[i];
    colorindex = (e.device !== undefined ? (colorindex + 1) % colors.length : colorindex);
    const colorClass = !e.eventType ? 'calibration-color-' + colors[colorindex] : 'calibration-event-type';

    html += '<tr>';
    html += '<td>' + report_plugins.utils.localeDateTime(new Date(e.mills)) + '</td><td class="calibration-event ' + colorClass + '">';
    e.colorClass = 'calibration-color-' + colors[colorindex];
    if (e.eventType) {
      html += '<b class="calibration-event-label">' + textAsHtml(translate(e.eventType)) + '</b>:<br>';
    } else if (typeof e.device !== 'undefined') {
      html += '<input type="checkbox" index="' + i + '" class="calibrations-checkbox" id="calibrations-' + i + '"> ';
      html += '<b class="calibration-mbg-label">MBG</b>: ' + textAsHtml(e.y) + ' Raw: ' + textAsHtml(e.raw) + '<br>';
      lastmbg = e;
      e.cals = [];
      e.checked = false;
    } else if (typeof e.scale !== 'undefined') {
      html += '<b class="calibration-cal-label">CAL</b>: ' + ' Scale: ' + e.scale.toFixed(2) + ' Intercept: ' + e.intercept.toFixed(0) + ' Slope: ' + e.slope.toFixed(2) + '<br>';
      if (lastmbg) {
        lastmbg.cals.push(e);
      }
    } else {
      html += textAsHtml(JSON.stringify(e));
    }
    html += '</td></tr>';
  }

  html += '</table>';

  $('#calibrations-list').html(html);

  // select last 3 mbgs
  checkLastCheckboxes(3);
  drawelements();

  $('.calibrations-checkbox').change(checkboxevent);

  function checkLastCheckboxes (maxcals) {
    for (i = events.length - 1; i > 0; i--) {
      if (typeof events[i].device !== 'undefined') {
        events[i].checked = true;
        $('#calibrations-' + i).prop('checked', true);
        if (--maxcals < 1) {
          break;
        }
      }
    }
  }

  function checkboxevent (event) {
    const index = $(this).attr('index');
    events[index].checked = $(this).is(':checked');
    drawelements();
    event.preventDefault();
  }

  function drawelements () {
    drawChart();
    for (let i = 0; i < events.length; i++) {
      e = events[i];
      if (e.checked) {
        drawmbg(e);
        e.cals.forEach(drawcal);
      }
    }
  }

  let calibration_context, xScale2, yScale2;

  function drawChart () {
    const maxBG = 500;

    $('#calibrations-chart').empty();
    const charts = d3.select('#calibrations-chart').append('svg');

    charts.append('rect')
      .attr('class', 'chart-background')
      .attr('width', '100%')
      .attr('height', '100%');

    calibration_context = charts.append('g');

    // define the parts of the axis that aren't dependent on width or height
    xScale2 = d3.scaleLinear()
      .domain([0, maxBG]);

    yScale2 = d3.scaleLinear()
      .domain([0, 400000]);

    const xAxis2 = d3.axisBottom(xScale2)
      .ticks(10);

    const yAxis2 = d3.axisLeft(yScale2);

    // get current data range
    const dataRange = [0, maxBG];
    const width = 600;
    const height = 500;

    // get the entire container height and width subtracting the padding
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    //set the width and height of the SVG element
    charts.attr('width', width)
      .attr('height', height);

    // ranges are based on the width and height available so reset
    xScale2.range([0, chartWidth]);
    yScale2.range([chartHeight, 0]);

    // create the x-axis container
    calibration_context.append('g')
      .attr('class', 'x axis');

    // create the y-axis container
    calibration_context.append('g')
      .attr('class', 'y axis');

    calibration_context.select('.y')
      .attr('transform', 'translate(' + ( /*chartWidth + */ padding.left) + ',' + padding.top + ')')
      .call(yAxis2);

    // if first run then just display axis with no transition
    calibration_context.select('.x')
      .attr('transform', 'translate(' + padding.left + ',' + (chartHeight + padding.top) + ')')
      .call(xAxis2);

    [50000, 100000, 150000, 200000, 250000, 300000, 350000, 400000].forEach(function(li) {
      calibration_context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(dataRange[0]) + padding.left)
        .attr('y1', yScale2(li) + padding.top)
        .attr('x2', xScale2(dataRange[1]) + padding.left)
        .attr('y2', yScale2(li) + padding.top);
    });
    [50, 100, 150, 200, 250, 300, 350, 400, 450, 500].forEach(function(li) {
      calibration_context.append('line')
        .attr('class', 'high-line')
        .attr('x1', xScale2(li) + padding.left)
        .attr('y1', padding.top)
        .attr('x2', xScale2(li) + padding.left)
        .attr('y2', chartHeight + padding.top);
    });
  }

  function drawcal (cal) {
    const y1 = 50000;
    const x1 = cal.scale * (y1 - cal.intercept) / cal.slope;
    const y2 = 400000;
    const x2 = cal.scale * (y2 - cal.intercept) / cal.slope;
    calibration_context.append('line')
      .attr('class', 'calibration-line ' + cal.colorClass)
      .attr('x1', xScale2(x1) + padding.left)
      .attr('y1', yScale2(y1) + padding.top)
      .attr('x2', xScale2(x2) + padding.left)
      .attr('y2', yScale2(y2) + padding.top);
  }

  function calcmbg (mbg) {
    const lastsgv = findlatest(new Date(mbg.mills), sgvs);

    if (lastsgv) {
      if (mbg.mills - lastsgv.mills > 5 * 60 * 1000) {
        console.log('Last SGV too old for MBG. Time diff: ' + ((mbg.mills - lastsgv.mills) / 1000 / 60).toFixed(1) + ' min', mbg);
      } else {
        mbg.raw = lastsgv.filtered || lastsgv.unfiltered;
      }
    } else {
      console.log('Last entry not found for MBG ', mbg);
    }
  }

  function drawmbg (mbg) {
    if (mbg.raw) {
      calibration_context.append('circle')
        .attr('class', 'calibration-point ' + mbg.colorClass)
        .attr('cx', xScale2(mbg.y) + padding.left)
        .attr('cy', yScale2(mbg.raw) + padding.top)
        .attr('r', 5);
    }
  }

  function findlatest (date, storage) {
    let last = null;
    const time = date.getTime();
    for (let i = 0; i < storage.length; i++) {
      if (storage[i].mills > time) {
        return last;
      }
      last = storage[i];
    }
    return last;
  }
};
