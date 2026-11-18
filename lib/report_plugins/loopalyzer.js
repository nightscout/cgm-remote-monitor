'use strict';

const moment = window.moment;
const d3 = (global && global.d3) || require('d3');
const textAsHtml = require('../utils/html').textAsHtml;
//var times = require('../times');

const loopalyzer = {
  name: 'loopalyzer'
  , label: 'Loopalyzer'
  , pluginType: 'report'
};

function init () {
  return loopalyzer;
}

module.exports = init;

const laDebug = false; // If we should print console.logs
const laVersion = '2019-02-02 v6';
const risingInterpolationGap = 6; // How large a gap in COB/IOB graph is allowed to be to be interpolated if end value is larger than start
const fallingInterpolationGap = 24; // And if less than start
const interpolationRatio = 1.25; // But do allow rising interpolation if gap larger than interpolationGap and end value is less than 10% larger than start

loopalyzer.html = function html (client) {
  const translate = client.translate;
  let ret = '';
  ret += '<h2>Loopalyzer&nbsp;&nbsp;<span id="loopalyzer-dateinfo"></span></h2>';
  ret += '<span id="loopalyzer-help">' + translate('The primary purpose of Loopalyzer is to visualise how the Loop closed loop system performs. It may work with other setups as well, both closed and open loop, and non loop. However depending on which uploader you use, how frequent it is able to capture your data and upload, and how it is able to backfill missing data some graphs may have gaps or even be completely empty. Always ensure the graphs look reasonable. Best is to view one day at a time and scroll through a number of days first to see.');
  ret += '<br/><br/>' + translate('Loopalyzer includes a time shift feature. If you for example have breakfast at 07:00 one day and at 08:00 the day after your average blood glucose curve these two days will most likely look flattened and not show the actual response after a breakfast. Time shift will compute the average time these meals were eaten and then shift all data (carbs, insulin, basal etc.) during both days the corresponding time difference so that both meals align with the average meal start time.');
  ret += '<br/>' + translate('In this example all data from first day is pushed 30 minutes forward in time and all data from second day 30 minutes backward in time so it appears as if you had had breakfast at 07:30 both days. This allows you to see your actual average blood glucose response from a meal.');
  ret += '<br/></br>' + translate('Time shift highlights the period after the average meal start time in gray, for the duration of the DIA (Duration of Insulin Action). As all data points the entire day are shifted the curves outside the gray area may not be accurate.');
  ret += '<br/></br>' + translate('Note that time shift is available only when viewing multiple days.');
  ret += '<br/><br/><b>';
  ret += translate('To see this report, press SHOW while in this view');
  ret += '</b></span>';
  ret += '<span id="loopalyzer-notenoughdata" class="is-hidden"><b>' + translate('Please select a maximum of two weeks duration and click Show again.') + '</b><br/><br/></span>';
  ret += '<div id="loopalyzer-buttons" class="is-hidden">';
  ret += '<input type="checkbox" id="rp_loopalyzerprofiles">' + translate('Show profiles table') + '&nbsp;&nbsp;&nbsp;&nbsp;';
  ret += '<input type="checkbox" id="rp_loopalyzerpredictions">' + translate('Show predictions');
  ret += '<br/>';
  ret += '<span id="rp_loopalyzertimeshiftinput">';
  ret += '<input type="checkbox" id="rp_loopalyzertimeshift">';

  let numberInput = '<input type="number" value="10" id="rp_loopalyzermincarbs">';

  function genTimePicker (id) {
    let timerPicker = ' <select id="' + id + '">';
    for (let i = 0; i < 24; i++) {
      const H = (i < 10 ? '0' : '') + i;
      timerPicker += '  <option t1="' + H + ':00"' + (i === 6 ? ' selected' : '') + '>' + H + ':00</option>';
      timerPicker += '  <option t1="' + H + ':30">' + H + ':30</option>';
    }
    timerPicker += '</select>';
    return timerPicker;
  }

  ret += translate('Timeshift on meals larger than %1 g carbs consumed between %2 and %3', numberInput, genTimePicker('rp_loopalyzert1'), genTimePicker('rp_loopalyzert2'));

  ret += '</span>'; /* timeShift */
  ret += '<br/><br/>';
  ret += '<input type="button" onclick="loopalyzerMoreBackward();" value="&lt;&lt;&lt;&nbsp;' + translate('Previous') + '">';
  ret += '<input type="button" onclick="loopalyzerBackward();" value="&lt;&nbsp;' + translate('Previous day') + '">';
  ret += '<input type="button" onclick="loopalyzerForward();" value="' + translate('Next day') + '&nbsp;&gt;">';
  ret += '<input type="button" onclick="loopalyzerMoreForward();" value="' + translate('Next') + '&nbsp;&gt;&gt;&gt;">';
  ret += '</div>'; /* loopalyzer-button */
  ret += '<div id="loopalyzer-charts">';
  ret += '  <div class="chart loopalyzer-chart" id="loopalyzer-basal"></div>';
  ret += '  <div class="chart loopalyzer-chart" id="loopalyzer-bg"></div>';
  ret += '  <div class="chart loopalyzer-chart" id="loopalyzer-tempbasal"></div>';
  ret += '  <div class="chart loopalyzer-chart" id="loopalyzer-iob"></div>';
  ret += '  <div class="chart loopalyzer-chart" id="loopalyzer-cob"></div>';
  ret += '</div>';
  ret += '<div id="loopalyzer-profiles">';
  ret += '</div>';
  return ret;
};

loopalyzer.css =
  '#loopalyzer-charts, #loopalyzer-profiles { padding: 20px; } ' +
  '#loopalyzer-basal, #loopalyzer-bg, #loopalyzer-tempbasal, #loopalyzer-iob, #loopalyzer-cob, #loopalyzer-profiles {' +
  '  width: 100%;' +
  '}' +
  '#loopalyzer-profiles-table table { margin: 0 10px; border-collapse: collapse; border: 0px; }' +
  '#loopalyzer-profiles-table td { vertical-align: top; }' +
  '#loopalyzer-profiles-table td table { margin: 0 10px; border-collapse: collapse; border: 0px; }' +
  '#loopalyzer-profiles-table td caption { text-align: left; font-weight: bold; }' +
  '#loopalyzer-profiles-table td th { background-color: var(--report-accent); color: var(--report-accent-text); }' +
  '#loopalyzer-profiles-table td td { text-align: right; vertical-align: top; padding: 0 1px; }' +
  '#loopalyzer-profiles-table td td td { padding: 1px 8px; }';

loopalyzer.prepareHtml = function loopalyzerPrepareHtml () {
  //  $('#loopalyzer-charts').append($('<table><tr><td><div id="loopalyzerchart"></div></td><td><div id="loopalyzerstatchart"></td></tr></table>'));
};

loopalyzer.drawChart = function drawChart (selector, config) {
  const container = document.querySelector(selector);
  if (!container) return;

  const containerStyle = window.getComputedStyle(container);
  const width = container.clientWidth || parseFloat(containerStyle.width) || 800;
  const height = container.clientHeight || parseFloat(containerStyle.height) || config.height || 150;
  const margin = { top: 8, right: 12, bottom: config.showXAxis ? 25 : 5, left: 42 };
  const innerWidth = Math.max(100, width - margin.left - margin.right);
  const innerHeight = Math.max(20, height - margin.top - margin.bottom);
  const series = config.series || [];
  const markings = config.markings || [];
  const values = [];

  series.forEach(function(item) {
    item.data.forEach(function(point) {
      if (isFinite(point[1])) values.push(Number(point[1]));
    });
  });
  markings.forEach(function(marking) {
    if (marking.yaxis) {
      if (isFinite(marking.yaxis.from)) values.push(Number(marking.yaxis.from));
      if (isFinite(marking.yaxis.to)) values.push(Number(marking.yaxis.to));
    }
  });
  if (config.includeZero !== false) values.push(0);

  let yDomain = config.yDomain || d3.extent(values);
  if (!isFinite(yDomain[0]) || !isFinite(yDomain[1])) yDomain = [0, 1];
  if (yDomain[0] === yDomain[1]) {
    yDomain = yDomain[0] === 0 ? [0, 1] : [Math.min(0, yDomain[0]), yDomain[1] * 1.1];
  }

  const xScale = d3.scaleTime().domain(config.xDomain).range([0, innerWidth]);
  const yScale = d3.scaleLinear().domain(yDomain).nice().range([innerHeight, 0]);
  const xTicks = xScale.ticks(d3.timeHour.every(1));
  const yTicks = yScale.ticks(Math.max(2, Math.floor(innerHeight / 30)));
  const axisColor = config.axisColor;

  const svg = d3.select(container)
    .html('')
    .append('svg')
    .attr('class', 'loopalyzer-chart-svg')
    .attr('width', '100%')
    .attr('height', '100%')
    .attr('viewBox', '0 0 ' + width + ' ' + height)
    .attr('preserveAspectRatio', 'none');
  const chart = svg.append('g')
    .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  markings.forEach(function(marking) {
    const x1 = marking.xaxis ? xScale(new Date(marking.xaxis.from)) : 0;
    const x2 = marking.xaxis ? xScale(new Date(marking.xaxis.to)) : innerWidth;
    const y1 = marking.yaxis ? yScale(marking.yaxis.from) : 0;
    const y2 = marking.yaxis ? yScale(marking.yaxis.to) : innerHeight;
    const markingClass = 'loopalyzer-marking';
    if (marking.yaxis && marking.yaxis.from === marking.yaxis.to) {
      chart.append('line')
        .attr('class', markingClass)
        .attr('x2', innerWidth)
        .attr('y1', y1)
        .attr('y2', y1)
        .attr('stroke', marking.color)
        .attr('stroke-width', marking.lineWidth || 1);
    } else {
      chart.append('rect')
        .attr('class', markingClass)
        .attr('x', Math.min(x1, x2))
        .attr('y', Math.min(y1, y2))
        .attr('width', Math.abs(x2 - x1))
        .attr('height', Math.abs(y2 - y1))
        .attr('fill', marking.color);
    }
  });

  const grid = chart.append('g').attr('class', 'loopalyzer-grid');
  grid.selectAll('line.loopalyzer-grid-y')
    .data(yTicks)
    .enter()
    .append('line')
    .attr('class', 'loopalyzer-grid-y')
    .attr('x2', innerWidth)
    .attr('y1', function(tick) { return yScale(tick); })
    .attr('y2', function(tick) { return yScale(tick); })
    .attr('stroke', config.gridColor);
  grid.selectAll('line.loopalyzer-grid-x')
    .data(xTicks)
    .enter()
    .append('line')
    .attr('class', 'loopalyzer-grid-x')
    .attr('x1', function(tick) { return xScale(tick); })
    .attr('x2', function(tick) { return xScale(tick); })
    .attr('y2', innerHeight)
    .attr('stroke', config.gridColor);

  chart.append('rect')
    .attr('class', 'loopalyzer-chart-border')
    .attr('width', innerWidth)
    .attr('height', innerHeight)
    .attr('fill', 'none')
    .attr('stroke', config.gridColor);

  const yAxis = d3.axisLeft(yScale)
    .tickValues(yTicks)
    .tickFormat(function(value) {
      const domain = yScale.domain();
      return value <= domain[0] || value >= domain[1] ? '' : value;
    });
  chart.append('g')
    .attr('class', 'loopalyzer-axis loopalyzer-axis-y')
    .attr('color', axisColor)
    .call(yAxis);

  if (config.showXAxis) {
    chart.append('g')
      .attr('class', 'loopalyzer-axis loopalyzer-axis-x')
      .attr('transform', 'translate(0,' + innerHeight + ')')
      .attr('color', axisColor)
      .call(d3.axisBottom(xScale).tickValues(xTicks).tickFormat(d3.timeFormat('%H:%M')));
  }

  series.forEach(function(item) {
    if (item.type === 'line') {
      const line = d3.line()
        .defined(function(point) {
          return isFinite(point[1]);
        })
        .x(function(point) {
          return xScale(new Date(point[0]));
        })
        .y(function(point) {
          return yScale(point[1]);
        });
      chart.append('path')
        .datum(item.data)
        .attr('class', 'loopalyzer-series loopalyzer-series-' + item.id)
        .attr('fill', 'none')
        .attr('stroke', item.color)
        .attr('d', line);
    }
    if (item.type === 'points') {
      chart.append('g')
        .attr('class', 'loopalyzer-series loopalyzer-series-' + item.id)
        .selectAll('circle')
        .data(item.data.filter(function(point) { return isFinite(point[1]); }))
        .enter()
        .append('circle')
        .attr('cx', function(point) { return xScale(new Date(point[0])); })
        .attr('cy', function(point) { return yScale(point[1]); })
        .attr('r', 1)
        .attr('fill', item.color);
    }
    if (item.type === 'bars') {
      const zero = yScale(0);
      const barWidth = Math.max(1, xScale(new Date(config.xDomain[0].getTime() + config.barWidth)) - xScale(config.xDomain[0]));
      chart.append('g')
        .attr('class', 'loopalyzer-series loopalyzer-series-' + item.id)
        .selectAll('rect')
        .data(item.data.filter(function(point) { return isFinite(point[1]); }))
        .enter()
        .append('rect')
        .attr('x', function(point) { return xScale(new Date(point[0])); })
        .attr('y', function(point) { return Math.min(zero, yScale(point[1])); })
        .attr('width', barWidth)
        .attr('height', function(point) { return Math.abs(zero - yScale(point[1])); })
        .attr('fill', item.color);
    }
  });

  const legend = chart.append('g')
    .attr('class', 'loopalyzer-legend')
    .attr('transform', 'translate(' + Math.max(0, innerWidth - 130) + ',4)');
  series.forEach(function(item, index) {
    legend.append('rect')
      .attr('x', 0)
      .attr('y', index * 14)
      .attr('width', 10)
      .attr('height', 3)
      .attr('fill', item.color);
    legend.append('text')
      .attr('x', 14)
      .attr('y', index * 14 + 5)
      .attr('fill', axisColor)
      .attr('font-size', 10)
      .text(item.label);
  });
};

// loopalyzer.ss = require('simple-statistics');

//
// Functions to pull data from datastorage and prepare in bins
//
loopalyzer.getSGVs = function(datastorage, daysToShow, profile) {
  const data = datastorage.allstatsrecords;
  const bins = loopalyzer.getEmptyBins();

  // Loop thru the days to show, for each day find the matching SGVs and insert into the bins entry array
  daysToShow.forEach(function(day) {
    const entries = []; // Array with all SGVs for this day, we'll fill this and then insert into the bins later
    for (let i = 0; i < 288; i++) entries.push(NaN); // Fill the array with NaNs so we have something in case we don't find an SGV
    const fromDate = profile.parseInTimezone(day);
    const toDate = profile.parseInTimezone(day);
    fromDate.set({ 'hours': 0, 'minutes': 0, 'seconds': 0, 'milliseconds': 0 });
    toDate.set({ 'hours': 0, 'minutes': 5, 'seconds': 0, 'milliseconds': 0 }); // toDate is 5 mins ahead
    for (let i = 0; i < 288; i++) {
      let found = false;
      data.some(function(record) {
        const recDate = profile.applyTimezone(moment(record.displayTime));
        if (!found && recDate.isAfter(fromDate) && recDate.isBefore(toDate)) {
          entries[i] = record.sgv;
          found = true;
        }
        return found; // Breaks .some loop if found is true
      })
      fromDate.add(5, 'minutes');
      toDate.add(5, 'minutes');
    }
    loopalyzer.addArrayToBins(bins, entries);
  });
  return bins;
}

loopalyzer.getBasals = function(datastorage, daysToShow, profile) {
  const bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    const dayStart = profile.parseInTimezone(day);
    const dayEnd = profile.parseInTimezone(day).endOf('day');
    const basals = [];
    for (let i = 0; i < 288; i++) basals.push(NaN); // Clear the basals by filling with NaNs

    let index = 0;
    for (const dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
      const basal = profile.getTempBasal(dt.toDate());
      if (basal)
        basals[index++] = basal.basal;
    }
    if (laDebug) console.log('getBasals ' + day, basals);
    loopalyzer.addArrayToBins(bins, basals);
  });
  return bins;
}

loopalyzer.getTempBasalDeltas = function(datastorage, daysToShow, profile) {
  const bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    const dayStart = profile.parseInTimezone(day);
    const dayEnd = profile.parseInTimezone(day).endOf('day');
    const temps = [];
    for (let i = 0; i < 288; i++) temps.push(NaN); // Clear the basals by filling with NaNs

    let index = 0;
    for (const dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
      const basal = profile.getTempBasal(dt.toDate());
      if (basal)
        temps[index++] = basal.tempbasal - basal.basal;
    }
    if (laDebug) console.log('getTempBasalDeltas ' + day, temps);
    loopalyzer.addArrayToBins(bins, temps);
  });
  return bins;
}

loopalyzer.getIOBs = function(datastorage, daysToShow, profile, client, treatments) {
  const iobStatusAvailable = client.plugins('iob').isDeviceStatusAvailable(datastorage.devicestatus);
  if (laDebug) console.log('getIOBs iobStatusAvailable=' + iobStatusAvailable);

  const bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    const dayStart = profile.parseInTimezone(day);
    const dayEnd = profile.parseInTimezone(day).endOf('day');
    const iobs = [];
    if (iobStatusAvailable) {
      // var dayStartMills = dayStart.milliseconds();
      for (let i = 0; i < 288; i++) iobs.push(NaN); // Clear the IOBs by filling with NaNs
      const iobArray = client.plugins('iob').IOBDeviceStatusesInTimeRange(datastorage.devicestatus, dayStart.valueOf(), dayEnd.valueOf());
      if (laDebug) console.log('getIOBs iobArray', iobArray);
      iobArray.forEach(function(entry) {
        const index = Math.floor(profile.applyTimezone(moment(entry.mills)).diff(dayStart, 'minutes') / 5);
        iobs[index] = entry.iob;
      });

      if (daysToShow.length === 1) loopalyzer.fillNanWithTreatments(iobs, treatments, profile);

      // Loop thru these entries and where no IOB has been found, interpolate between nearby to get a continuous array
      let startIndex = 0
        , stopIndex = 0;
      while (startIndex < iobs.length && isNaN(iobs[startIndex])) {
        startIndex++; // Advance start to the first real number
      }
      if (startIndex < iobs.length) {
        stopIndex = startIndex + 1;
        while (stopIndex < iobs.length) {
          while (stopIndex < iobs.length && isNaN(iobs[stopIndex])) {
            stopIndex++; // Advance stop to the first real number after start
          }
          if (stopIndex < iobs.length) {
            // Now we have real numbers at start and stop and NaNs in between
            // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
            // Only interpolate on decreasing or steady, or on increasing if the gap is less than interpolationGap
            // if (stopIndex-startIndex<interpolationGap && (iobs[stopIndex] <= iobs[startIndex]*interpolationRatio || (stopIndex-startIndex<interpolationGap && iobs[startIndex]!==0))) {
            if (loopalyzer.canInterpolate(iobs, startIndex, stopIndex)) {
              const k = (iobs[stopIndex] - iobs[startIndex]) / (stopIndex - startIndex);
              const m = iobs[startIndex];
              for (let x = 0; x < (stopIndex - startIndex); x++) {
                iobs[x + startIndex] = k * x + m;
              }
            }
            startIndex = stopIndex;
            stopIndex++;
          }
        }
      }
    } else {
      for (const dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
        const iob = client.plugins('iob').calcTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).iob;
        iobs.push(iob);
      }
    }
    if (laDebug) console.log('getIOBs ' + day, iobs);
    loopalyzer.addArrayToBins(bins, iobs);
  });
  return bins;
}

loopalyzer.getCOBs = function(datastorage, daysToShow, profile, client, treatments) {
  const cobStatusAvailable = client.plugins('cob').isDeviceStatusAvailable(datastorage.devicestatus);
  if (laDebug) console.log('getCOBs cobStatusAvailable=' + cobStatusAvailable);

  const bins = loopalyzer.getEmptyBins();

  daysToShow.forEach(function(day) {
    const dayStart = profile.parseInTimezone(day);
    const dayEnd = profile.parseInTimezone(day).endOf('day');
    const cobs = [];
    if (cobStatusAvailable) {
      // var dayStartMills = dayStart.milliseconds();
      for (let i = 0; i < 288; i++) cobs.push(NaN); // Clear the COBs by filling with NaNs
      const cobArray = client.plugins('cob').COBDeviceStatusesInTimeRange(datastorage.devicestatus, dayStart.valueOf(), dayEnd.valueOf());
      if (laDebug) console.log('getCOBs cobArray', cobArray);
      cobArray.forEach(function(entry) {
        const index = Math.floor(profile.applyTimezone(moment(entry.mills)).diff(dayStart, 'minutes') / 5);
        cobs[index] = entry.cob;
      });

      if (daysToShow.length === 1) loopalyzer.fillNanWithTreatments(cobs, treatments, profile);

      // Loop thru these entries and where no COB has been found, interpolate between nearby to get a continuous array
      let startIndex = 0
        , stopIndex = 0
        , k = 0
        , m = 0;

      while (startIndex < cobs.length && isNaN(cobs[startIndex])) {
        startIndex++; // Advance start to the first real number
      }
      if (startIndex < cobs.length) {
        stopIndex = startIndex + 1;
        while (stopIndex < cobs.length) {
          while (stopIndex < cobs.length && isNaN(cobs[stopIndex])) {
            stopIndex++; // Advance stop to the first real number after start
          }
          if (stopIndex < cobs.length) {
            // Now we have real numbers at start and stop and NaNs in between
            // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
            // Only interpolate on decreasing or steady, or on increasing if the gap is less than interpolationGap
            // if (stopIndex-startIndex<interpolationGap && (cobs[stopIndex] <= cobs[startIndex]*interpolationRatio || (stopIndex-startIndex<interpolationGap && cobs[startIndex]!==0))) {
            if (loopalyzer.canInterpolate(cobs, startIndex, stopIndex)) {
              k = (cobs[stopIndex] - cobs[startIndex]) / (stopIndex - startIndex);
              m = cobs[startIndex];
              for (let x = 0; x < (stopIndex - startIndex); x++) {
                cobs[x + startIndex] = k * x + m;
                if (cobs[x + startIndex] < 0) {
                  cobs[x + startIndex] = 0;
                }
              }
            }
            startIndex = stopIndex;
            stopIndex++;
          }
        }
      }
    } else {
      for (const dt = dayStart; dt < dayEnd; dt.add(5, 'minutes')) {
        const cob = client.plugins('cob').cobTotal(datastorage.treatments, datastorage.devicestatus, profile, dt.toDate()).cob;
        cobs.push(cob);
      }
    }
    if (laDebug) console.log('getCOBs ' + day, cobs);
    loopalyzer.addArrayToBins(bins, cobs);
  });
  return bins;
}

/* Fills NaN gaps with treatments if treatments are available and value at start is less than value at stop */
loopalyzer.fillNanWithTreatments = function(array, treatments, profile) {
  treatments.forEach(function(treatment) {
    const treatmentDate = profile.applyTimezone(moment(treatment.date));
    const dayStart = treatmentDate.clone().startOf('day');
    const minutesAfterMidnight = treatmentDate.diff(dayStart, 'minutes');
    const index = Math.floor(minutesAfterMidnight / 5);
    if (isNaN(array[index])) {
      let start = index;
      let stop = index;

      // Now move left and right until we find real numbers, so not NaN
      while (start >= 0 && isNaN(array[start])) {
        start--;
      }
      while (stop < array.length && isNaN(array[stop])) {
        stop++;
      }
      // var gap = stop - start;
      // if (isNaN(array[start]) || isNaN(array[stop]) || gap > interpolationGap || (gap < interpolationGap && array[start]<array[stop])) {
      // if ( isNaN(array[start]) || isNaN(array[stop]) || (array[start] < array[stop] && (gap >= interpolationGap || array[start]==0)) ) {
      const interpolate = (isNaN(array[start]) || isNaN(array[stop]) ? true : loopalyzer.canInterpolate(array, start, stop));
      if (!interpolate) {
        array[index] = treatment.amount;
      }
    }
  })
}

/* Returns true if we can interpolate between this start and end */
loopalyzer.canInterpolate = function(array, start, stop) {
  let interpolate = false;
  if (array[stop] <= array[start] * interpolationRatio) {
    // Falling
    if (stop - start < fallingInterpolationGap) interpolate = true;
  } else {
    // Rising
    if (stop - start < risingInterpolationGap && array[start] !== 0) interpolate = true;
  }
  return interpolate;
}

/* Returns the carbs treatments array as [date, amount] */
loopalyzer.getCarbTreatments = function(datastorage, daysToShow, profile) {
  const treatments = []; // Holds the treatments [date, amount]
  const startDate = profile.parseInTimezone(daysToShow[0]);
  const endDate = profile.parseInTimezone(daysToShow[daysToShow.length - 1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment) { return treatment.carbs && treatment.carbs > 0 }).forEach(function(treatment) {
    if (profile.applyTimezone(moment(treatment.created_at)).isBetween(startDate, endDate)) {
      treatments.push({ date: treatment.created_at, amount: treatment.carbs });
    }
  })
  if (laDebug) console.log('Carb treatments', treatments);
  return treatments;
}

/* Returns the insulin treatments array as [date, amount] */
loopalyzer.getInsulinTreatments = function(datastorage, daysToShow, profile) {
  const treatments = []; // Holds the treatments [date, amount]
  const startDate = profile.parseInTimezone(daysToShow[0]);
  const endDate = profile.parseInTimezone(daysToShow[daysToShow.length - 1]).add(1, 'days');

  datastorage.treatments.filter(function(treatment) { return treatment.insulin && treatment.insulin > 0 }).forEach(function(treatment) {
    if (profile.applyTimezone(moment(treatment.created_at)).isBetween(startDate, endDate)) {
      treatments.push({ date: treatment.created_at, amount: treatment.insulin });
    }
  })
  if (laDebug) console.log('Insulin treatments', treatments);
  return treatments;
}

// PREDICTIONS START
//
loopalyzer.getAllTreatmentTimestampsForADay = function(datastorage, day, profile) {
  const timestamps = [];
  const dayStart = profile.parseInTimezone(day);
  const carbTreatments = loopalyzer.getCarbTreatments(datastorage, [day], profile);
  const insulinTreatments = loopalyzer.getInsulinTreatments(datastorage, [day], profile);
  carbTreatments.forEach(function(entry) { timestamps.push(entry.date) });
  insulinTreatments.forEach(function(entry) { timestamps.push(entry.date) });
  timestamps.sort(function(a, b) { return (a < b ? -1 : 1) });
  timestamps.splice(0, 0, dayStart.toDate()); // Insert a fake timestamp at midnight so we can show predictions during night
  return timestamps;
}

loopalyzer.getAllPredictionsForADay = function(datastorage, day, profile) {
  const predictions = [];
  const dayStart = profile.parseInTimezone(day);
  for (let i = datastorage.devicestatus.length - 1; i >= 0; i--) {
    if (datastorage.devicestatus[i].loop && datastorage.devicestatus[i].loop.predicted) {
      const predicted = datastorage.devicestatus[i].loop.predicted;
      if (profile.applyTimezone(moment(predicted.startDate)).isSame(dayStart, 'day'))
        predictions.push(datastorage.devicestatus[i].loop.predicted);
    } else if (datastorage.devicestatus[i].openaps && datastorage.devicestatus[i].openaps.suggested && datastorage.devicestatus[i].openaps.suggested.predBGs) {
      const entry = {};
      entry.startDate = datastorage.devicestatus[i].openaps.suggested.timestamp;
      // For OpenAPS/AndroidAPS we fall back from COB if present, to UAM, then IOB
      if (datastorage.devicestatus[i].openaps.suggested.predBGs.COB) {
        entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.COB;
      } else if (datastorage.devicestatus[i].openaps.suggested.predBGs.UAM) {
        entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.UAM;
      } else entry.values = datastorage.devicestatus[i].openaps.suggested.predBGs.IOB;
      predictions.push(entry);
    }
  }
  // Remove duplicates before we're done
  const p = [];
  predictions.forEach(function(prediction) {
    if (p.length === 0 || prediction.startDate !== p[p.length - 1].startDate)
      p.push(prediction);
  })
  return p;
}

/* Find the earliest new predicted instance that has a timestamp equal to or larger than timestamp */
/* (so if we have bolused or eaten we want to find the prediction that Loop has estimated just after that) */
/* Returns the index into the predictions array that is the predicted we are looking for */
loopalyzer.findPredicted = function(predictions, timestamp, offset) {
  const ts = moment(timestamp).add(offset, 'minutes');
  let predicted = null;
  if (offset && offset < 0) { // If offset is negative, start searching from first prediction going forward
    for (let i = 0; i < predictions.length; i++) {
      if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) <= ts) {
        predicted = i;
      }
    }
  } else { // If offset is positive or zero, start searching from last prediction going backward
    for (let i = predictions.length - 1; i > 0; i--) {
      if (predictions[i] && predictions[i].startDate && moment(predictions[i].startDate) >= ts) {
        predicted = i;
      }
    }
  }
  return predicted;
}

loopalyzer.getPredictions = function(datastorage, daysToShow, client, profile) {

  if (!datastorage.devicestatus)
    return [];

  const predictedOffset = 0;
  const truncatePredictions = true;

  // Fill the bins array with the timestamp, one per 5 minutes
  const bins = [];
  const date = moment();
  date.set({ 'hours': 0, 'minutes': 0, 'seconds': 0, 'milliseconds': 0 });
  for (let i = 0; i < 288; i++) {
    bins.push([date.toDate(), []]);
    date.add(5, 'minutes');
  }

  daysToShow.forEach(function(day) {
    const p = []; // Array with all prediction SGVs for this day, we'll fill this and then insert into the bins later
    for (let i = 0; i < 288; i++) p.push(NaN);
    const treatmentTimestamps = loopalyzer.getAllTreatmentTimestampsForADay(datastorage, day, profile);
    const predictions = loopalyzer.getAllPredictionsForADay(datastorage, day, profile);

    if (predictions.length > 0 && treatmentTimestamps.length > 0) {

      // Iterate over all treatments, find the predictions for each and add them to the entries array p, aligned on timestamp
      for (let treatmentsIndex = 0; treatmentsIndex < treatmentTimestamps.length; treatmentsIndex++) {
        const timestamp = treatmentTimestamps[treatmentsIndex];
        const predictedIndex = loopalyzer.findPredicted(predictions, timestamp, predictedOffset); // Find predictions offset before or after timestamp

        if (predictedIndex != null) {
          const entry = predictions[predictedIndex]; // Start entry
          const d = profile.applyTimezone(moment(entry.startDate));
          let end = profile.parseInTimezone(day).endOf('day'); // Default to stop and end of the day
          if (truncatePredictions) {
            if (predictedOffset >= 0) {
              // But if we are looking forward we want to stop at the next treatment
              if (treatmentsIndex < treatmentTimestamps.length - 1) {
                end = moment(treatmentTimestamps[treatmentsIndex + 1]);
              }
            } else {
              // And if we are looking backward then we want to stop at "this" treatment
              end = moment(treatmentTimestamps[treatmentsIndex]);
            }
          }
          for (let entryIndex in entry.values) {
            if (!d.isAfter(end)) {
              const dayStart = d.clone().startOf('day');
              const minutesAfterMidnight = d.diff(dayStart, 'minutes');
              const index = Math.floor(minutesAfterMidnight / 5);
              p[index] = client.utils.scaleMgdl(entry.values[entryIndex]);
              d.add(5, 'minutes');
            }
          }
        }
      }
    }
    for (let i = 0; i < 288; i++) {
      bins[i][1].push(p[i]);
    }
  })
  return bins;
}
//
// PREDICTIONS ENDS

// VARIOUS UTILITY FUNCTIONS //

/* Create an empty bins array with date stamps for today */
loopalyzer.getEmptyBins = function() {
  const bins = [];
  const todayStart = moment().startOf('day');
  const todayEnd = moment().endOf('day');
  for (const dt = todayStart; dt < todayEnd; dt.add(5, 'minutes')) {
    bins.push([dt.toDate(), []]);
  }
  return bins;
}

/* Takes an array of 288 values and adds to the bins */
loopalyzer.addArrayToBins = function(bins, values) {
  if (bins && bins.length === 288 && values && values.length === 288) {
    values.forEach(function(value, index) {
      bins[index][1].push(value);
    });
  } else
    console.log('addArrayToBins - array must have 288 items', values);
}

/* Fill all NaNs in an array by interpolating between adjacent values */
loopalyzer.interpolateArray = function(values, allowNegative) {
  let startIndex = 0
    , stopIndex = 0
    , k = 0
    , m = 0;

  while (isNaN(values[startIndex])) {
    startIndex++; // Advance start to the first real number
  }
  stopIndex = startIndex + 1;
  while (stopIndex < values.length) {
    while (stopIndex < values.length && isNaN(values[stopIndex])) {
      stopIndex++; // Advance stop to the first real number after start
    }
    if (stopIndex < values.length) {
      // Now we have real numbers at start and stop and NaNs in between
      // Compute the y=k*x+m = (y2-y1)/(x2-x1)*x+y1
      // Only interpolate if decreasing or steady, newer on increasing
      if (values[stopIndex] <= values[startIndex]) {
        k = (values[stopIndex] - values[startIndex]) / (stopIndex - startIndex);
        m = values[startIndex];
      }
      for (let x = 0; x < (stopIndex - startIndex); x++) {
        values[x + startIndex] = k * x + m;
        if (!allowNegative && values[x + startIndex] < 0) {
          values[x + startIndex] = 0;
        }
      }
      startIndex = stopIndex;
      stopIndex++;
    }
  }
}

/* Compute min value in bins */
loopalyzer.min = function(xBins) {
  let min = xBins[0][1];
  for (let i = 0; i < xBins.length; i++) {
    if (isNaN(min) || min === null) min = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1] < min) min = xBins[i][1];
  }
  return min;
}

/* Compute max value in bins */
loopalyzer.max = function(xBins) {
  let max = xBins[0][1];
  for (let i = 0; i < xBins.length; i++) {
    if (isNaN(max) || max === null) max = xBins[i][1];
    if (!isNaN(xBins[i][1]) && xBins[i][1] > max) max = xBins[i][1];
  }
  return max;
}

/* Compute avg value in bins */
loopalyzer.avg = function(xBins) {
  const out = [];
  xBins.forEach(function(entry) {
    let sum = 0;
    let count = 0;
    entry[1].forEach(function(value) {
      if (value && !isNaN(value)) {
        sum += value;
        count++;
      }
    })
    const avg = sum / count;
    out.push([entry[0], avg]);
  })
  return out;
}

// Timeshifts a bins array with subarrays for multiple days
loopalyzer.timeShiftBins = function(bins, timeShift) {
  if (bins && bins.length > 0) {
    timeShift.forEach(function(minutes, dayIndex) {
      if (minutes !== 0) {
        const tempBin = [];
        bins.forEach(function() {
          tempBin.push(NaN); // Fill tempBin with NaNs
        })
        const minutesBy5 = Math.floor(minutes / 5);
        if (minutesBy5 > 0) {
          let count = 288 - minutesBy5;
          // If minutes>0 it means we should shift forward in time
          // Example: Shift by 15 mins = 3 buckets
          // bin    :  0   1   2  3 4 5 6 7 8 9 10
          // tempBin: NaN NaN NaN 0 1 2 3 4 5 6  7
          for (let i = 0; i < count; i++) {
            tempBin[i + minutesBy5] = bins[i][1][dayIndex];
          }
        }
        if (minutesBy5 < 0) {
          let count = 288 + minutesBy5;
          // If minutes<0 it means we should shift backward in time
          // Example: Shift by 15 mins = 3 buckets
          // bin    : 0 1 2 3 4 5 6  7  8   9   10
          // tempBin: 3 4 5 6 7 8 9 10 NaN NaN NaN
          for (let i = 0; i < count; i++) {
            tempBin[i] = bins[i - minutesBy5][1][dayIndex];
          }
        }
        // Put the shifted data back into original bins variable (pass by pointer)
        for (let i = 0; i < 288; i++) {
          bins[i][1][dayIndex] = tempBin[i];
        }
      }
    });
  }
}

// Modifies the timestamp in the bin by timeShift minutes, for each day
loopalyzer.timeShiftSingleBin = function(bin, daysToShow, timeShift, profile) {
  if (bin && bin.length > 0) {
    daysToShow.forEach(function(day, dayIndex) {
      const minutesToAdd = timeShift[dayIndex];
      const date = profile.parseInTimezone(day);
      bin.forEach(function(entry, entryIndex) {
        const entryDate = profile.applyTimezone(moment(entry.date));
        if (entryDate.isSame(date, 'day')) {
          entryDate.add(minutesToAdd, 'minutes');
          bin[entryIndex].date = entryDate.toDate();
        }
      })
    })
  }
}

/* Returns true if the profile values in a is identical to values in b, false otherwise */
loopalyzer.isSameProfileValues = function(a, b) {
  // Because the order of the keys are random when stringifying we do our own custom stringify ourselves
  let aString = '';
  let bString = '';
  if (a.basal) {
    aString += 'basal:';
    a.basal.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (a.carbratio) {
    aString += 'carbratio:';
    a.carbratio.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (a.sens) {
    aString += 'sens:';
    a.sens.forEach(function(entry) {
      aString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.basal) {
    bString += 'basal:';
    b.basal.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.carbratio) {
    bString += 'carbratio:';
    b.carbratio.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  if (b.sens) {
    bString += 'sens:';
    b.sens.forEach(function(entry) {
      bString += 's' + entry.timeAsSeconds + 't' + entry.time + 'v' + entry.value;
    })
  }
  return (aString === bString);
}

loopalyzer.renderProfilesTable = function(datastoreProfiles, daysToShow, client) {
  const profile = client.sbx.data.profile;

  // Loop thru the daysToShow and get the timestamp of the first day displayed
  let beginningOfFirstDay = null;
  let endOfLastDay = null;
  daysToShow.forEach(function(day) {
    const dayStart = profile.parseInTimezone(day);
    const dayEnd = profile.parseInTimezone(day).endOf('day');
    if (!beginningOfFirstDay || dayStart < beginningOfFirstDay)
      beginningOfFirstDay = dayStart;
    if (!endOfLastDay || dayEnd > endOfLastDay)
      endOfLastDay = dayEnd;
  });

  // Now some profile juggling... We want to display only the profiles relevant to the days we are showing.
  // This includes the last profile created before the first display date, and the profiles created on the display dates.
  // However we don't want to show duplicate profiles and we also don't want to show more than just a few if there are many.

  // First, extract the profiles that have a startDate less than the endOfLastDay as only these are relevant, and sort
  // these on ascending startDate (create a clone array so we don't modify the Store array). And only save the profiles
  // that have basal, carbratio, or sens.
  const profilesArray1 = [];
  datastoreProfiles.forEach(function(entry) {
    const newEntry = {};
    newEntry.startDate = entry.startDate;
    const store = entry.store;
    if (store) {
      for (let key in store) {
        if (laDebug) console.log('profile ' + key);
        if (Object.prototype.hasOwnProperty.call(store, key)) {
          const defaultProfile = store[key];
          newEntry.profileName = key;
          if (defaultProfile.basal) newEntry.basal = defaultProfile.basal;
          if (defaultProfile.carbratio) newEntry.carbratio = defaultProfile.carbratio;
          if (defaultProfile.sens) newEntry.sens = defaultProfile.sens;
          if ((newEntry.basal || newEntry.carbratio || newEntry.sens) && profile.applyTimezone(moment(entry.startDate)).isBefore(endOfLastDay))
            profilesArray1.push(newEntry);
        }
      }
    }
  })
  profilesArray1.sort(function(a, b) { return (a.startDate > b.startDate ? 1 : -1) }); // Ascending
  if (laDebug) {
    profilesArray1.forEach(function(entry) {
      console.log('profilesArray1 - ' + entry.startDate);
    })
  }
  if (laDebug) console.log('profilesArray1 has ' + profilesArray1.length + ' profiles');

  // Second, the deduplication - remove all duplicates which have a later startDate but identical data
  const profilesArray2 = [];
  let profileToCompareWith = profilesArray1[0];
  profilesArray2.push(profileToCompareWith); // Push the first profile, which should always be included.
  profilesArray1.forEach(function(entry) {
    if (laDebug) {
      console.log('Comparing ' + JSON.stringify(profileToCompareWith.startDate) + ' to ' + JSON.stringify(entry.startDate));
      console.log(profileToCompareWith, entry);
    }
    if (!loopalyzer.isSameProfileValues(profileToCompareWith, entry)) {
      profilesArray2.push(entry);
      profileToCompareWith = entry;
      if (laDebug)
        console.log('ADDING IT');
    } else {
      // Do NOT push the entry to profilesArray2, and keep comparing with the same (olders unique) profile
      if (laDebug)
        console.log('SKIPPING IT');
    }
  })
  if (laDebug) console.log('profilesArray2 has ' + profilesArray2.length + ' profiles');

  // Sort the newest Profile first
  profilesArray2.sort(function(a, b) { return (a.startDate > b.startDate ? 1 : -1) }); // Ascending

  // Third, find the latest profile with a startDate before beginningOfFirstDay
  let latestProfile = profilesArray2[0]; // This is the oldest one
  profilesArray2.forEach(function(entry) {
    if (laDebug)
      console.log(entry.startDate + ' isBefore ' + beginningOfFirstDay + ' = ' + profile.applyTimezone(moment(entry.startDate)).isBefore(beginningOfFirstDay));
    if (profile.applyTimezone(moment(entry.startDate)).isBefore(beginningOfFirstDay))
      latestProfile = entry;
  });
  if (laDebug) console.log('latest profile is ' + latestProfile.startDate);

  // Now create a final array with the latest profile found above and add all
  // the other profiles with a startDate between beginningOfFirstDay and endOfLastDay
  const profiles = [];
  profiles.push(latestProfile); // Add the latest one
  profilesArray2.forEach(function(entry) {
    if (laDebug)
      console.log(entry.startDate + ' isAfter ' + beginningOfFirstDay + ' = ' + profile.applyTimezone(moment(entry.startDate)).isAfter(beginningOfFirstDay));
    if (profile.applyTimezone(moment(entry.startDate)).isAfter(beginningOfFirstDay))
      profiles.push(entry); // Add the profile if it's between beginning and end of show dates
  });

  // Now we have an array of all the profiles that are relevant for the days we are displaying.
  if (laDebug) {
    profiles.forEach(function(entry) {
      console.log('profiles - ' + entry.startDate);
    })
  }
  if (laDebug) console.log('profiles has ' + profiles.length + ' profiles');

  const translate = client.translate;
  let tableHtml = '<table id="loopalyzer-profiles-table"><tbody><tr>';

  profiles.forEach(function(theProfile, index) {

    if (index < 3) {
      tableHtml += '<td><table>';
      tableHtml += '<caption>' + textAsHtml(theProfile.profileName) + ' (' + profile.applyTimezone(moment(theProfile.startDate)).format('L LT') + ')</caption>';
      tableHtml += '<thead><tr><th>' + translate('Basal') + '</th><th>' + translate('Carb ratio') + '</th><th>' + translate('Sensitivity') + '</th></tr></thead>';
      tableHtml += '<tbody><tr>';

      // Add Basal as a table in the first td
      tableHtml += '<td><table>';
      if (theProfile.basal) {
        theProfile.basal.forEach(function(entry) {
          tableHtml += '<tr><td>' + textAsHtml(entry.time) + '</td><td>' + parseFloat(entry.value).toFixed(3) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Add Carb Ratio as a table in the second td
      tableHtml += '<td><table>';
      if (theProfile.carbratio) {
        theProfile.carbratio.forEach(function(entry) {
          tableHtml += '<tr><td>' + textAsHtml(entry.time) + '</td><td>' + parseFloat(entry.value).toFixed(1) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Add Sensitivity as a table in the third td
      tableHtml += '<td><table>';
      if (theProfile.sens) {
        theProfile.sens.forEach(function(entry) {
          tableHtml += '<tr><td>' + textAsHtml(entry.time) + '</td><td>' + parseFloat(entry.value).toFixed(1) + '</td></tr>'
        });
      }
      tableHtml += '</table></td>';

      // Close theProfile table
      tableHtml += '</tr></tbody></table></td>';

    } else
    if (index === 3) {
      // Add ellipsis if too many profiles to display, but only one ellipsis even if there are more profiles
      tableHtml += '<td><table><caption>.....</caption></table></td>';
    }
  });

  // Close the entire table
  tableHtml += '</tr></tbody></table>';

  // And add our HTML to the view
  $("#loopalyzer-profiles").html(tableHtml);

};

// Main method
loopalyzer.report = function(datastorage, sorteddaystoshow, options) {
  if (laDebug) console.log('Loopalyzer ' + laVersion);
  const profile = window.Nightscout.client.sbx.data.profile;

  // Copy the sorteddaystoshow into new array (clone) and re-sort ascending (so we don't mess with original array)
  const daysToShow = [];
  sorteddaystoshow.forEach(function(day) { daysToShow.push(day) });
  daysToShow.sort(function(a, b) { return (a < b ? -1 : 1) }); // We always want them chronological order

  const firstDay = profile.parseInTimezone(daysToShow[0]);
  const lastDay = profile.parseInTimezone(daysToShow[daysToShow.length - 1]);
  const days = lastDay.diff(firstDay, 'day') + 1;
  if (laDebug) console.log('Loopalyzer ' + firstDay.format() + ' - ' + lastDay.format() + ' is ' + days + ' days');
  if (days <= 14) {
    $("#loopalyzer-notenoughdata").addClass('is-hidden');
    $("#loopalyzer-dateinfo").show();
    $("#loopalyzer-buttons").removeClass('is-hidden');
    $("#loopalyzer-charts").show();
    $("#loopalyzer-profiles-table").show();
    $("#loopalyzer-help").hide();
    loopalyzer.generateReport(datastorage, daysToShow, options);
  } else {
    $("#loopalyzer-notenoughdata").removeClass('is-hidden');
    $("#loopalyzer-dateinfo").hide();
    $("#loopalyzer-buttons").addClass('is-hidden');
    $("#loopalyzer-charts").hide();
    $("#loopalyzer-profiles-table").hide();
    $("#loopalyzer-help").hide();
  }
}

loopalyzer.generateReport = function(datastorage, daysToShow, options) {
  const Nightscout = window.Nightscout;
  const client = Nightscout.client;
  const translate = client.translate;
  const profile = client.sbx.data.profile;
  const report_plugins = Nightscout.report_plugins;
  // var scaledTreatmentBG = report_plugins.utils.scaledTreatmentBG;

  const today = new Date();
  const todayJSON = { 'year': today.getFullYear(), 'month': today.getMonth(), 'date': today.getDate() };

  let dateInfo = report_plugins.utils.localeDate(daysToShow[0]);
  if (daysToShow.length > 1) dateInfo += ' - ' + report_plugins.utils.localeDate(daysToShow[daysToShow.length - 1]);
  $("#loopalyzer-dateinfo").html(dateInfo);

  loopalyzer.prepareHtml();
  $("#loopalyzer-buttons").removeClass('is-hidden');
  if (daysToShow.length === 1) {
    // Disable and gray out timeShift if only a single day
    $("#rp_loopalyzertimeshift").prop('checked', false);
    $("#rp_loopalyzertimeshift").attr("disabled", true);
    $("#rp_loopalyzermincarbs").attr("disabled", true);
    $("#rp_loopalyzert1").attr("disabled", true);
    $("#rp_loopalyzert2").attr("disabled", true);
    $("#rp_loopalyzertimeshiftinput").addClass('is-disabled');
  } else {
    // Enable and turn the timeShift black if multiple days
    $("#rp_loopalyzertimeshift").removeAttr("disabled");
    $("#rp_loopalyzermincarbs").removeAttr("disabled");
    $("#rp_loopalyzert1").removeAttr("disabled");
    $("#rp_loopalyzert2").removeAttr("disabled");
    $("#rp_loopalyzertimeshiftinput").removeClass('is-disabled');
  }
  // Check if there is data in the profiles and render the profiles table if there is
  if ($("#rp_loopalyzerprofiles").is(":checked") && (datastorage.profiles && datastorage.profiles.length > 0)) {
    $("#loopalyzer-profiles-table").show();
    loopalyzer.renderProfilesTable(datastorage.profiles, daysToShow, client);
  } else
    $("#loopalyzer-profiles-table").hide();

  // Pull all necessary treatment information
  profile.updateTreatments(datastorage.profileSwitchTreatments, datastorage.tempbasalTreatments, datastorage.combobolusTreatments);

  const carbTreatments = loopalyzer.getCarbTreatments(datastorage, daysToShow, profile);
  const insulinTreatments = loopalyzer.getInsulinTreatments(datastorage, daysToShow, profile);
  const sgvBin = loopalyzer.getSGVs(datastorage, daysToShow, profile);
  const basalsBin = loopalyzer.getBasals(datastorage, daysToShow, profile);
  const tempBasalsBin = loopalyzer.getTempBasalDeltas(datastorage, daysToShow, profile);
  const iobBin = loopalyzer.getIOBs(datastorage, daysToShow, profile, client, insulinTreatments);
  const cobBin = loopalyzer.getCOBs(datastorage, daysToShow, profile, client, carbTreatments);
  let predictionsBin = [];

  if ($("#rp_loopalyzerpredictions").is(":checked")) {
    predictionsBin = loopalyzer.getPredictions(datastorage, daysToShow, client, profile);
  }

  // Prepare an array with the minutes to timeShift each day (0 as default since timeShift is off by default)
  const timeShifts = [];
  const firstCarbs = [];
  let timeShiftStartTime = null; // If timeShifting this is the average time the meals were eaten
  let timeShiftStopTime = null; // and this is the start + DIA according to profile
  let doTimeShift = false;
  daysToShow.forEach(function() {
    timeShifts.push(0);
    firstCarbs.push(NaN)
  });

  // Check to see if we are doing timeShift or not
  if ($("#rp_loopalyzertimeshift").is(":checked") && daysToShow.length > 1) {
    const mealMinCarbs = $("#rp_loopalyzermincarbs").val();
    const t1 = $("#rp_loopalyzert1").val();
    const t2 = $("#rp_loopalyzert2").val();

    if (t2 > t1) {
      const h1 = t1.split(':')[0];
      const m1 = t1.split(':')[1];
      const h2 = t2.split(':')[0];
      const m2 = t2.split(':')[1];

      const timeShiftBegin = moment();
      timeShiftBegin.set({ 'hours': h1, 'minutes': m1, 'seconds': 0 });

      const timeShiftEnd = moment();
      timeShiftEnd.set({ 'hours': h2, 'minutes': m2, 'seconds': 0 });

      //Loop through the carb treatments and find the first meal each day
      daysToShow.forEach(function(day, dayIndex) {
        const timeShiftBegin = profile.parseInTimezone(day);
        const timeShiftEnd = profile.parseInTimezone(day);
        timeShiftBegin.set({ 'hours': h1, 'minutes': m1, 'seconds': 0 });
        timeShiftEnd.set({ 'hours': h2, 'minutes': m2, 'seconds': 0 });

        let found = false;
        carbTreatments.forEach(function(entry) {
          if (!found && entry.amount >= mealMinCarbs) {
            const date = profile.applyTimezone(moment(entry.date));
            if ((date.isSame(timeShiftBegin, 'minute') || date.isAfter(timeShiftBegin, 'minute')) &&
              (date.isSame(timeShiftEnd, 'minute') || date.isBefore(timeShiftEnd, 'minute'))) {
              const startOfDay = profile.applyTimezone(moment(entry.date));
              startOfDay.set({ 'hours': 0, 'minutes': 0, 'seconds': 0 });
              firstCarbs[dayIndex] = date.diff(startOfDay, 'minutes');
              found = true;
              doTimeShift = true;
            }
          }
        })
      })

      // Calculate the average starting time, in minutes after midnight
      let sum = 0
        , count = 0;

      firstCarbs.forEach(function(minutesAfterMidnight) {
        if (minutesAfterMidnight) { // Avoid NaN
          sum += minutesAfterMidnight;
          count++;
        }
      });

      const averageMinutesAfterMidnight = Math.round(sum / count);

      let dia = profile.getDIA();
      if (!dia || dia <= 0)
        dia = 6; // Default to 6h if DIA not set in profile
      timeShiftStartTime = moment(todayJSON);
      timeShiftStartTime.minutes(averageMinutesAfterMidnight);
      timeShiftStopTime = moment(todayJSON);
      if (averageMinutesAfterMidnight + dia * 60 < 24 * 60)
        timeShiftStopTime.minutes(averageMinutesAfterMidnight + dia * 60); // If not beyond midnight, stop at end of DIA
      else
        timeShiftStopTime.minutes(24 * 60 - 1); // If beyond midnight, stop at midnight

      // Compute the timeShift (+ / -) that we should add to each entry (sgv, iob, carbs, etc) for each day
      firstCarbs.forEach(function(minutesAfterMidnight, index) {
        if (minutesAfterMidnight) { // Avoid NaN
          const delta = Math.round(averageMinutesAfterMidnight - minutesAfterMidnight);
          timeShifts[index] = delta;
        }
      });

      if (doTimeShift) {
        loopalyzer.timeShiftBins(sgvBin, timeShifts);
        loopalyzer.timeShiftBins(basalsBin, timeShifts);
        loopalyzer.timeShiftBins(tempBasalsBin, timeShifts);
        loopalyzer.timeShiftBins(iobBin, timeShifts);
        loopalyzer.timeShiftBins(cobBin, timeShifts);
        loopalyzer.timeShiftBins(predictionsBin, timeShifts);
        loopalyzer.timeShiftSingleBin(carbTreatments, daysToShow, timeShifts, profile);
        loopalyzer.timeShiftSingleBin(insulinTreatments, daysToShow, timeShifts, profile);
      }
    } else {
      console.log('Loopalyzer - Timeshift end must be later than beginning.');
    }
  }

  // After timeShift code block, get the average values
  const sgvAvg = loopalyzer.avg(sgvBin);
  const basalsAvg = loopalyzer.avg(basalsBin);
  const tempBasalsAvg = loopalyzer.avg(tempBasalsBin);
  const iobAvg = loopalyzer.avg(iobBin);
  const cobAvg = loopalyzer.avg(cobBin);
  const predictionsAvg = loopalyzer.avg(predictionsBin);

  const high = options.targetHigh;
  const low = options.targetLow;

  const reportStyle = window.getComputedStyle(document.documentElement);

  function themeColor (name, fallback) {
    return reportStyle.getPropertyValue(name).trim() || fallback;
  }

  const tickColor = themeColor('--report-grid', '#DDDDDD');
  const basalColor = themeColor('--loop-basal', '#33A0FF');
  const glucoseColor = themeColor('--loop-glucose', '#33AA33');
  const predictionsColor = themeColor('--loop-predictions', '#8E1578');
  const glucoseRangeColor = themeColor('--loop-target-range', '#D6FFD6');
  const insulinColor = themeColor('--loop-insulin', '#FF7000');
  const carbColor = themeColor('--loop-carbs', '#23D820');
  const timeShiftBackgroundColor = themeColor('--loop-timeshift', '#F3F3F3');
  const axisColor = themeColor('--report-text', '#111111');
  const barWidth = (24 * 60 * 60 * 1000 / 288);
  const xDomain = basalsAvg.length > 0 ?
    [new Date(basalsAvg[0][0]), new Date(basalsAvg[basalsAvg.length - 1][0].getTime() + barWidth)] :
    [moment(todayJSON).toDate(), moment(todayJSON).add(1, 'day').toDate()];

  // For drawing the carbs and insulin treatments
  let markings = [];
  const markingColor = themeColor('--loop-marking', '#000000');

  // Chart 1: Basal
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  loopalyzer.drawChart('#loopalyzer-basal', {
    series: [{ data: basalsAvg, label: translate('Basal Profile'), id: 'basals', color: basalColor, type: 'bars' }]
    , markings: markings
    , xDomain: xDomain
    , gridColor: tickColor
    , axisColor: axisColor
    , barWidth: barWidth
    , height: 100
  });

  // Chart 2: Blood Glucose
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  markings.push({ yaxis: { from: low, to: high }, color: glucoseRangeColor });

  const chartBGData = [{
    data: sgvAvg
    , label: translate('Blood Glucose')
    , id: 'glucose'
    , color: glucoseColor
    , type: 'line'
  }];
  if (predictionsAvg && predictionsAvg.length > 0) {
    chartBGData.push({
      label: translate('Predictions')
      , data: predictionsAvg
      , id: 'predictions'
      , color: predictionsColor
      , type: 'points'
    });
  }
  loopalyzer.drawChart('#loopalyzer-bg', {
    series: chartBGData
    , markings: markings
    , xDomain: xDomain
    , yDomain: [0, options.units === 'mmol' ? 20 : 400]
    , gridColor: tickColor
    , axisColor: axisColor
    , barWidth: barWidth
    , height: 200
  });

  // Chart 3: Delta temp basals
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  markings.push({ yaxis: { from: 0, to: 0 }, color: insulinColor, lineWidth: 2 });

  loopalyzer.drawChart('#loopalyzer-tempbasal', {
    series: [{ data: tempBasalsAvg, label: translate('Temp basal delta'), id: 'tempBasals', color: insulinColor, type: 'bars' }]
    , markings: markings
    , xDomain: xDomain
    , gridColor: tickColor
    , axisColor: axisColor
    , barWidth: barWidth
    , height: 150
  });

  // Chart 4: IOB
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  insulinTreatments.forEach(function(treatment) {
    const treatmentDate = profile.applyTimezone(moment(treatment.date));
    const startDate = moment(todayJSON);
    startDate.set({ 'hours': treatmentDate.hour(), 'minutes': treatmentDate.minute(), 'seconds': treatmentDate.second(), 'milliseconds': treatmentDate.millisecond() });
    const endDate = startDate.clone().add(5, 'minutes');
    markings.push({ xaxis: { from: startDate.toDate(), to: endDate.toDate() }, yaxis: { from: 0, to: treatment.amount }, color: markingColor });
  })

  loopalyzer.drawChart('#loopalyzer-iob', {
    series: [{ data: iobAvg, label: translate('IOB'), id: 'iobs', color: insulinColor, type: 'bars' }]
    , markings: markings
    , xDomain: xDomain
    , gridColor: tickColor
    , axisColor: axisColor
    , barWidth: barWidth
    , height: 150
  });

  // Chart 5: COB
  markings = [];
  if (doTimeShift)
    markings.push({ xaxis: { from: timeShiftStartTime.toDate(), to: timeShiftStopTime.toDate() }, color: timeShiftBackgroundColor });
  carbTreatments.forEach(function(treatment) {
    const treatmentDate = profile.applyTimezone(moment(treatment.date));
    const startDate = moment(todayJSON);
    startDate.set({ 'hours': treatmentDate.hour(), 'minutes': treatmentDate.minute(), 'seconds': treatmentDate.second(), 'milliseconds': treatmentDate.millisecond() });
    const endDate = startDate.clone().add(5, 'minutes');
    markings.push({ xaxis: { from: startDate.toDate(), to: endDate.toDate() }, yaxis: { from: 0, to: treatment.amount }, color: markingColor });
  })
  loopalyzer.drawChart('#loopalyzer-cob', {
    series: [{ data: cobAvg, label: translate('COB'), id: 'cobs', color: carbColor, type: 'bars' }]
    , markings: markings
    , xDomain: xDomain
    , gridColor: tickColor
    , axisColor: axisColor
    , barWidth: barWidth
    , height: 150
    , showXAxis: true
  });

};
