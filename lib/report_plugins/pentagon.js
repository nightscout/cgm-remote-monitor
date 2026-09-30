'use strict';

// Report is based on following whitepaper:
// The Comprehensive Glucose Pentagon: A Glucose-Centric Composite Metric for Assessing Glycemic Control in Persons With Diabetes
// Robert A. Vigersky et al.
// doi: 10.1177/1932296817718561
// https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5761978
// Access date: 13.02.2022

// I did my best to implement all the metric as descibed in above mentioned paper but I don't gurantee corectness.
// You are using this code on your own risk, you shall not make any medical decisions based on this code output.
// Note that averaging results for multiple day periods was not described in the paper, so I simply averaged daily results.

let _ = require('lodash');
let moment = window.moment;
let d3 = (global && global.d3) || require('d3');
let units = require('../units')();

let pentagon = {
  name: 'pentagon'
  , label: 'Comprehensive Glucose Pentagon'
  , pluginType: 'report'
};

function init () {
  return pentagon;
}

module.exports = init;

function mgdlToMmolHighPrecision(mgdl, decimalDigits=1) {
  return _.round(mgdl/18.02, decimalDigits);
}

pentagon.html = function html (client) {
  let translate = client.translate;
  let ret =
    '<h2>' + translate('Comprehensive Glucose Pentagon') + '</h2>' +
    '<b>' + translate('To see this report, press SHOW while in this view') + '</b><br>' +
    translate('Time span') + ': ' +
    '<input type="radio" name="timeSpan" id="ts1d" value="1" checked>' +
    translate('1d') +
    '<input type="radio" name="timeSpan" id="ts7d" value="7">' +
    translate('7d') +
    '<input type="radio" name="timeSpan" id="ts30d" value="30">' +
    translate('30d') +
    '<input type="radio" name="timeSpan" id="tsAll">' +
    translate('All time') + '<br>' +
    translate('Chart scaling:') + ' <input type="number" id="pentagonScaleFactor" value="4">' + '<br>' +
    '<div id="pentagoncharts">' +
    '</div>';
  return ret;
};

pentagon.prepareHtml = function pentagonPrepareHtml (timeSpanToShow, options) {
  $('#pentagoncharts').html('');

  let unitLabel = options.units;
  let convertUnitCallback = unitLabel.toLowerCase().startsWith("mmol") ? mgdlToMmolHighPrecision : x => x;

  let legend = '<div><span><br>Prognostic glycemic risk <b>PGR</b> interpretation: <br>' +
  'PGR ≤ 2.0, the patient has a very low risk for diabetes short- and/or long-term complications <br>' +
  '2.0 < PGR ≤ 3.0 low risk <br>' +
  '3.0 < PGR ≤ 4.0 moderate risk <br>' +
  '4.0 < PGR ≤ 4.5 high risk <br>' +
  'PGR > 4.5 extremely high risk <br>' +
  '<br>' +
  `Target high glucose was hardcoded to ${convertUnitCallback(180)} ${unitLabel}<br>` +
  `Target low glucose was hardcoded to ${convertUnitCallback(70)} ${unitLabel}<br>` +
  '</span></div>';

  $('#pentagoncharts').append($(legend));
  timeSpanToShow.forEach(function eachTimeSpan (d) {
    $('#pentagoncharts').append($('<table><tr><td><div id="cgp_pentagon-' + d[0] + '-' + d[d.length - 1] + '"></div></td><td><div id="cgp_pentagon_score-' + d[0] + '-' + d[d.length - 1] + '"></td></tr></table>'));
  });
};

pentagon.report = function report_pentagon (datastorage, sorteddaystoshow, options) {
  let Nightscout = window.Nightscout;
  let report_plugins = Nightscout.report_plugins;
  let timeSpanToShow = [];

  function getTimeSpan() {
    let radioOptions = document.getElementsByName('timeSpan');

    for(const option of radioOptions) {
        if(option.checked)
          return option.id == "tsAll" ? moment($('#rp_to').val()).diff($('#rp_from').val(), "days")+1 : option.value;
    }
  }

  let startDay = moment(sorteddaystoshow[0] + ' 00:00:00');

  sorteddaystoshow.forEach(function eachDay (day) {
    let timeSpanNum = Math.floor(Math.abs(moment(day + ' 00:00:00').diff(startDay, 'days')) / getTimeSpan());

    if (typeof timeSpanToShow[timeSpanNum] === 'undefined') {
      timeSpanToShow[timeSpanNum] = [];
    }

    timeSpanToShow[timeSpanNum].push(day);
  });

  timeSpanToShow = timeSpanToShow.map(function orderDay (day) {
    return _.sortBy(day);
  });

  pentagon.prepareHtml(timeSpanToShow, options);

  timeSpanToShow.forEach(function eachTimeSpan (timeSpan) {
    let sgvData = [];

    timeSpan.forEach(function eachDay (day) {
      datastorage[day].sgv.forEach(function eachSgv (sgv) {
        if(sgv.type == "sgv"){
            sgvData.push({
              'date': sgv.date
              , 'mills': sgv.mills
              // Pentagon's formulas are defined for mg/dl format so let's convert data here.
              , 'sgv': options.units.toLowerCase().startsWith("mmol") ? units.mmolToMgdl(sgv.sgv) : sgv.sgv
              // , 'y': sgv.y
          });
          // TODO: what's the difference between sgv.sgv and sgv.y?
        }
      });
    });

    drawPentagon(timeSpan, sgvData, options);
  });

  function drawPentagon (week, sgvData, options) {
    let charts, context;

    charts = d3.select('#cgp_pentagon-' + week[0] + '-' + week[week.length - 1]).html(
      '<b>' +
      report_plugins.utils.localeDate(week[0]) +
      '-' +
      report_plugins.utils.localeDate(week[week.length - 1]) +
      '</b><br>'
    ).append('svg');

    context = charts.append('g');

    // All caluclations are defined of mg/dl, mmol will be only displayed on UI
    let unitLabel = options.units;
    let isMmol = unitLabel.toLowerCase().startsWith("mmol");

    const axesOrder = ["ToR","CV","Hypo","Hyper","Mean",];
    let axes = new Map([
      ["ToR", {
        ticks: [0,300,480,720,900,1080,1200,1440],
        angle: 180+0,
        formula: function(timeOutOfRange) {
          // ToR axes: × [mm] = (ToR[min] × 0.00614)^1.581 + 14
          return (((timeOutOfRange) * 0.00614)**1.581 + 14) * SCALE_FACTOR;
        },
        label: "1440 min - Time in Range [min/d]",
        label_anchor: "middle"
      }],
      ["CV", {
        ticks: [16.7, 20, 30, 40, 50, 60, 70, 80],
        angle: 180+72,
        formula: function(x) {
          // CV axes: × [mm] = (CV[%] − 17) × 0.92 + 14
          return ((x - 17)*0.92 + 14) * SCALE_FACTOR;
        },
        label: "CV_glucose [%]",
        label_anchor: "begin"
      }],
      ["Hypo", {
        ticks: [0,2,3,4,5,6,7,7.2],
        angle: 180+144,
        formula: function(x) {
          // IntHypo: × [mm] = (e^(IntHypo[mg/dL] × 0.00057) + 13)/1000
          return ((Math.E**(x * 0.00057)) + 13) * SCALE_FACTOR;
        },
        label: `Intensity Hypo\n[${isMmol? mgdlToMmolHighPrecision(1000) : 1000} x ${unitLabel} x min^2]`,
        label_anchor: "begin"
      }],
      ["Hyper", {
        ticks: [0,20,40,50,60,70,80,90,100,110,120,130],
        angle: 180+216,
        formula: function(x) {
          // IntHyper: × [mm] = ((IntHyper[mg/dL] × 0.000115)^1.51 + 14)/1000
          return (((x * 0.000115)**1.51) + 14) * SCALE_FACTOR;
        },
        label: `Intensity Hyper\n[${isMmol? mgdlToMmolHighPrecision(1000) : 1000} x ${unitLabel} x min^2]`,
        label_anchor: "end"
      }],
      ["Mean", {
        ticks: [130,160,190,220,250,280,310],
        angle: 180+288,
        formula: function(meanGlucose) {
          // Mean axes: × [mm] = [(Mean glucose[mg/dl] − 90) × 0.0217]^2.63 + 14
          return (((meanGlucose - 90) * 0.0217)**2.63 + 14) * SCALE_FACTOR;
        },
        label: `Mean glucose\n[${unitLabel}]`,
        label_anchor: "end"
      }],
    ])

    function displayValue(value, axisLabel){
      // Convert ticks to mmol only for selected axes.
      let decimalDigits = axisLabel.includes("Hypo") ? 2 : 1;
      return axisLabel.includes(unitLabel) && isMmol ? mgdlToMmolHighPrecision(value, decimalDigits) : value;
    }

    // Pentagram is drawed on the square canvas, so width == height
    const SCALE_FACTOR = document.getElementById('pentagonScaleFactor').value;
    const PENTAGON_ARM_LENGTH = 76; // from whitepaper, arms lenght are 76 mm
    const PENTAGON_SCALED_ARM_LENGTH = SCALE_FACTOR * PENTAGON_ARM_LENGTH;
    const PENTAGON_SCALED_ARM_WITH_LABEL_OFFSET = SCALE_FACTOR * PENTAGON_ARM_LENGTH + 20;

    const rangeHighMgdl = 180
        , rangeLowMgdl = 70;

    let chartSizeY = PENTAGON_SCALED_ARM_LENGTH + PENTAGON_SCALED_ARM_WITH_LABEL_OFFSET + 4 * 16;
    let chartSizeX = PENTAGON_SCALED_ARM_LENGTH + PENTAGON_SCALED_ARM_WITH_LABEL_OFFSET + (axes.get("CV").label.length+3) * 16;

    charts.attr('width', chartSizeX)
      .attr('height', chartSizeY);

    function meanGlucose(sgvDataSlice) {
      // It corresponds to weighted sum, some devices pull data infrequently when battery is slow i.e.
      // every 15 minutes instead of 5. In such case higher weight shuld be assigned to such result.

      let result = integralFunction(sgvDataSlice, x => x); // x is always true, so calucalte mean from all samples
      return result.areaUnderCurve/result.totalTimeMin;
    }

    function coefficientOfVariation(sgvDataSlice) {
      return d3.deviation(sgvDataSlice, x => x.sgv)/meanGlucose(sgvDataSlice)*100;
    }

    function integralFunction(sgvDataSlice, predicateCallback){
      let areaUnderCurve = 0
        , totalTimeMin = 0;
      let dbg = [];
      for (let i = 1; i < sgvDataSlice.length; ++i){
          if(predicateCallback(sgvDataSlice[i])){
            // Use integer numbers to improve precison, it may be useful when gathering statiscs for
            // long periods of time.
            let minutes = Math.round((sgvDataSlice[i].mills - sgvDataSlice[i-1].mills)/1000/60);
            dbg.push((sgvDataSlice[i].mills - sgvDataSlice[i-1].mills)/1000/60);
            let avgSgv = Math.round((sgvDataSlice[i].sgv + sgvDataSlice[i-1].sgv)/2);
            areaUnderCurve += avgSgv * minutes;
            totalTimeMin += minutes;
        }
      }

      return {areaUnderCurve, totalTimeMin};
    }

    function normalizedAreaUnderCurve(sgvDataSlice, predicateCallback){
      let result = integralFunction(sgvDataSlice, predicateCallback);
      return Math.sqrt(result.areaUnderCurve**2 + result.totalTimeMin**2);
    }

    function drawAxis(name, axis){
      let lane = d3.line()([[0,0], [0, PENTAGON_SCALED_ARM_LENGTH]]);

      let g = context.append('g')
        .attr('class', `${name} axis`)
        .style('stroke', 'black')
        .attr('transform', `translate(${chartSizeX / 2}, ${chartSizeY / 2}) rotate(${axis.angle})`);

      g.append('path')
        .attr('d', lane);

      let angleMod = axis.angle % 360;
      // Flip text only for axes in 3th and 4th quadrant.
      // It will be latter rotated with whole axis so our text won't be upside down.
      // It also affects ticks' anchor.
      let flipText = (angleMod < 90 || angleMod > 270) ? true : false;

      for(let x of axis.ticks){
        // Workaround to keep short tick names on x1000 mg/dl scales
        let y = axis.formula(x * (axis.label.startsWith("Intensity") ? 1000 : 1));

        let tick = d3.line()([[-5, y], [5, y]]);

        g.append('path')
          .attr('d', tick);
        g.append("text")
          .attr('transform', `translate(-10, ${y + (flipText ? 3 : -3)}) ${flipText? "" : "rotate(180)"}`)
          .attr("text-anchor", flipText ? "end" : "begin")
          .attr("font-size", "85%")
          .text(displayValue(x, axis.label));
      }
    }

    function drawPentagonBoarder(){
      let pentagonNodes = [];
      for (let i = 0; i < axes.size; ++i) {
        pentagonNodes.push(
          [
            PENTAGON_SCALED_ARM_LENGTH * Math.sin(i * 360/axes.size * Math.PI/180),
            PENTAGON_SCALED_ARM_LENGTH * Math.cos(i * 360/axes.size * Math.PI/180),
          ]
        );
      }
      pentagonNodes.push(pentagonNodes[0])
      let pentagonLine = d3.line()(pentagonNodes);

      context.append('path')
      .attr("d", pentagonLine)
      .attr('transform', `translate(${chartSizeX / 2}, ${chartSizeY / 2}) rotate(180)`)
      .attr('stroke', 'black')
      .style('fill', 'none');
    }

    function drawPentagonFromResults(results, fill, opacity, id){
      let pentagonNodes = new Array(axes.size+1);
      let axesLengths = new Array(axes.size);

      for(let idx = 0; idx < axesOrder.length; ++idx){
        let axisName = axesOrder[idx];
        axesLengths[idx] = axes.get(axisName).formula(results.get(axisName));
        pentagonNodes[idx] = [
          axesLengths[idx] * Math.sin(-axes.get(axisName).angle * Math.PI/180),
          axesLengths[idx] * Math.cos(axes.get(axisName).angle * Math.PI/180),
        ];
      }

      pentagonNodes[5] = pentagonNodes[0];
      let pentagonLine = d3.line()(pentagonNodes);

      context.append('path')
      .attr("d", pentagonLine)
      .attr("id", id)
      .attr('transform', `translate(${chartSizeX / 2}, ${chartSizeY / 2})`)
      .attr('stroke', 'black')
      .style('fill', fill)
      .style('fill-opacity', opacity);

      return pentagonArea(axesLengths);
    }

    function drawLabel(name, axis){
      let x = chartSizeX / 2 + PENTAGON_SCALED_ARM_WITH_LABEL_OFFSET * Math.sin(-axis.angle * Math.PI/180);
      let y = chartSizeY / 2 + PENTAGON_SCALED_ARM_WITH_LABEL_OFFSET * Math.cos(axis.angle * Math.PI/180);

      let labelLines = axis.label.split('\n');

      let g = context.append('g')
        .attr('class', name + ' label')
        .attr('transform', `translate(${x}, ${y})`)
        .style("text-anchor", axis.label_anchor);
      for(let i = 0; i < labelLines.length; ++i){
        g.append("text")
          .attr("dy", `${i}em`)
          .text(labelLines[i]);
      }
    }

    function pentagonArea(axesLengths){
      // Input is 5 axes lengths

      // ACGP = AToR-CV + ACV-IntHYPO + AIntHYPO-IntHYPER + AIntHYPER-Mean glucose + AMean glucose-ToR, where:
      // area_xy = ½ a × b × sin γ (γ = angle between the axes, each 72°;
      // a, b = length of each axis; A = area of triangle; and,
      // x-y = length of axis for each area).

      let totalArea = axesLengths[0] * axesLengths[4];
      for(let i = 1; i < axesLengths.length; ++i){
        totalArea += axesLengths[i] * axesLengths[i-1];
      }

      return totalArea * 0.5 * Math.sin(2*Math.PI/axes.size);
    }

    let refResult = new Map([
      ["ToR", 0],
      ["CV", 16.7],
      ["Hypo", 0],
      ["Hyper", 0],
      ["Mean", 90],
    ]);

    drawPentagonBoarder();
    let refResultArea = drawPentagonFromResults(refResult, "rgb(50, 255, 50)", 1, "refResult");

    let patientResult = new function(){
      // I will average day results to create summary for timespan > 1d, to do it I need to know
      // indices of sgvData for different dates.
      let dayIndices = [0];
      for(let i = 1, prevDate = sgvData[0].date.toDateString(); i < sgvData.length; ++i){
        let currDate = sgvData[i].date.toDateString();

        if(prevDate != currDate){
          dayIndices.push(i);
          prevDate = currDate;
        }
      }
      dayIndices.push(sgvData.length);

      let dayResults = new Map([
        ["ToR", []],
        ["CV", []],
        ["Hypo", []],
        ["Hyper", []],
        ["Mean", []],
      ]);
      for(let i = 0; i < dayIndices.length-1; ++i){
        let sgvDataSlice = sgvData.slice(dayIndices[i], dayIndices[i+1]);
        dayResults.get("ToR").push(1440-integralFunction(sgvDataSlice, x => x.sgv >= rangeLowMgdl && x.sgv <= rangeHighMgdl).totalTimeMin);
        dayResults.get("CV").push(coefficientOfVariation(sgvDataSlice));
        dayResults.get("Hypo").push(normalizedAreaUnderCurve(sgvDataSlice, x => x.sgv < rangeLowMgdl));
        dayResults.get("Hyper").push(normalizedAreaUnderCurve(sgvDataSlice, x => x.sgv > rangeHighMgdl));
        dayResults.get("Mean").push(meanGlucose(sgvDataSlice));
      }

      console.assert(getTimeSpan() == dayIndices.length - 1, "Incositent sgvData with time span selection")

      let result = new Map();
      for (const [key, arr] of dayResults.entries())
        result.set(key, d3.mean(arr));

      return result;
    };
    let patientResultArea = drawPentagonFromResults(patientResult, "rgb(220, 220, 0)", 0.7, "patientResult");
    for (const [key, value] of axes.entries()) {
      drawAxis(key, value);
      drawLabel(key, value);
    }

    let summary = `<b>PGR score: ${_.round(patientResultArea/refResultArea, 1)}</b><br><br>`;
    patientResult.forEach((val,key)=>{
      val = displayValue(val, axes.get(key).label);
      summary += `${key}: ${_.round(val, 1)}<br>`;
    })

    d3.select('#cgp_pentagon_score-' + week[0] + '-' + week[week.length - 1]).html(summary);
  }
};
