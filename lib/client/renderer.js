'use strict';

var _ = require('lodash');
var times = require('../times');
var consts = require('../constants');

var DEFAULT_FOCUS = times.hours(3).msecs
  , WIDTH_SMALL_DOTS = 420
  , WIDTH_BIG_DOTS = 800
  , TOOLTIP_WIDTH = 150 //min-width + padding
;

const zeroDate = new Date(0);

function init (client, d3) {

  var renderer = {};

  var utils = client.utils;
  var translate = client.translate;

  function getOrAddDate(entry) {
    if (entry.date) return entry.date;
    entry.date = new Date(entry.mills);
    return entry.date;
  }

  //chart isn't created till the client gets data, so can grab the var at init
  function chart () {
    return client.chart;
  }

  function focusRangeAdjustment () {
    return client.focusRangeMS === DEFAULT_FOCUS ? 1 : 1 + ((client.focusRangeMS - DEFAULT_FOCUS) / DEFAULT_FOCUS / 8);
  }

  var dotRadius = function(type) {
    var radius = chart().prevChartWidth > WIDTH_BIG_DOTS ? 4 : (chart().prevChartWidth < WIDTH_SMALL_DOTS ? 2 : 3);
    if (type === 'mbg') {
      radius *= 2;
    } else if (type === 'forecast') {
      radius = Math.min(3, radius - 1);
    } else if (type === 'rawbg') {
      radius = Math.min(2, radius - 1);
    }

    return radius / focusRangeAdjustment();
  };

  function tooltipLeft () {
    var windowWidth = $(client.tooltip.node()).parent().parent().width();
    var left = d3.event.pageX + TOOLTIP_WIDTH < windowWidth ? d3.event.pageX : windowWidth - TOOLTIP_WIDTH - 10;
    return left + 'px';
  }

  function hideTooltip () {
    client.tooltip.style('opacity', 0);
  }

  // get the desired opacity for context chart based on the brush extent
  renderer.highlightBrushPoints = function highlightBrushPoints (data, from, to) {
    if (client.latestSGV && data.mills >= from && data.mills <= to) {
      return chart().futureOpacity(data.mills - client.latestSGV.mills);
    } else {
      return 0.5;
    }
  };

  renderer.bubbleScale = function bubbleScale () {
    // a higher bubbleScale will produce smaller bubbles (it's not a radius like focusDotRadius)
    return (chart().prevChartWidth < WIDTH_SMALL_DOTS ? 4 : (chart().prevChartWidth < WIDTH_BIG_DOTS ? 3 : 2)) * focusRangeAdjustment();
  };

  renderer.addFocusCircles = function addFocusCircles () {

    function updateFocusCircles (sel) {
      var badData = [];
      sel.attr('cx', function(d) {
          if (!d) {
            console.error('Bad data', d);
            return chart().xScale(zeroDate);
          } else if (!d.mills) {
            console.error('Bad data, no mills', d);
            return chart().xScale(zeroDate);
          } else {
            return chart().xScale(getOrAddDate(d));
          }
        })
        .attr('cy', function(d) {
          var scaled = client.sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return chart().yScale(utils.scaleMgdl(450));
          } else {
            return chart().yScale(scaled);
          }
        })
        .attr('opacity', function(d) {
          if (d.noFade) {
            return null;
          } else {
            return !client.latestSGV ? 1 : chart().futureOpacity(d.mills - client.latestSGV.mills);
          }
        })
        .attr('r', function(d) {
          return dotRadius(d.type);
        });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    function prepareFocusCircles (sel) {
      updateFocusCircles(sel)
        .attr('fill', function(d) {
          return d.type === 'forecast' ? 'none' : d.color;
        })
        .attr('stroke-width', function(d) {
          return d.type === 'mbg' ? 2 : d.type === 'forecast' ? 2 : 0;
        })
        .attr('stroke', function(d) {
          return (d.type === 'mbg' ? 'white' : d.color);
        });

      return sel;
    }

    function focusCircleTooltip (d) {
      if (d.type !== 'sgv' && d.type !== 'mbg' && d.type !== 'forecast') {
        return;
      }

      function getRawbgInfo () {
        var info = {};
        var sbx = client.sbx.withExtendedSettings(client.rawbg);
        if (d.type === 'sgv') {
          info.noise = client.rawbg.noiseCodeToDisplay(d.mgdl, d.noise);
          if (client.rawbg.showRawBGs(d.mgdl, d.noise, client.ddata.cal, sbx)) {
            info.value = utils.scaleMgdl(client.rawbg.calc(d, client.ddata.cal, sbx));
          }
        }
        return info;
      }

      var rawbgInfo = getRawbgInfo();

      client.tooltip.style('opacity', .9);
      client.tooltip.html('<strong>' + translate('BG') + ':</strong> ' + client.sbx.scaleEntry(d) +
          (d.type === 'mbg' ? '<br/><strong>' + translate('Device') + ': </strong>' + d.device : '') +
          (d.type === 'forecast' && d.forecastType ? '<br/><strong>' + translate('Forecast Type') + ': </strong>' + d.forecastType : '') +
          (rawbgInfo.value ? '<br/><strong>' + translate('Raw BG') + ':</strong> ' + rawbgInfo.value : '') +
          (rawbgInfo.noise ? '<br/><strong>' + translate('Noise') + ':</strong> ' + rawbgInfo.noise : '') +
          '<br/><strong>' + translate('Time') + ':</strong> ' + client.formatTime(getOrAddDate(d)))
        .style('left', tooltipLeft())
        .style('top', (d3.event.pageY + 15) + 'px');
    }

    // CGM data

    var focusData = client.entries;

    // bind up the focus chart data to an array of circles
    // selects all our data into data and uses date function to get current max date
    var focusCircles = chart().focus.selectAll('circle.entry-dot').data(focusData, function genKey (d) {
      return "cgmreading." + d.mills;
    });

    // if already existing then transition each circle to its new position
    updateFocusCircles(focusCircles);

    // if new circle then just display
    prepareFocusCircles(focusCircles.enter().append('circle'))
      .attr('class', 'entry-dot')
      .on('mouseover', focusCircleTooltip)
      .on('mouseout', hideTooltip);

    focusCircles.exit().remove();

    // Forecasts

    var shownForecastPoints = client.chart.getForecastData();

    // bind up the focus chart data to an array of circles
    // selects all our data into data and uses date function to get current max date

    var forecastCircles = chart().focus.selectAll('circle.forecast-dot').data(shownForecastPoints, function genKey (d) {
      return d.forecastType + d.mills;
    });

    forecastCircles.exit().remove();

    prepareFocusCircles(forecastCircles.enter().append('circle'))
    .attr('class', 'forecast-dot')
    .on('mouseover', focusCircleTooltip)
    .on('mouseout', hideTooltip);

    updateFocusCircles(forecastCircles);

  };

  renderer.addTreatmentCircles = function addTreatmentCircles (nowDate) {
    function treatmentTooltip (d) {
      var targetBottom = d.targetBottom;
      var targetTop = d.targetTop;

      if (client.settings.units === 'mmol') {
        targetBottom = Math.round(targetBottom / consts.MMOL_TO_MGDL * 10) / 10;
        targetTop = Math.round(targetTop / consts.MMOL_TO_MGDL * 10) / 10;
      }

      var correctionRangeText;
      if (d.correctionRange) {
        var min = d.correctionRange[0];
        var max = d.correctionRange[1];

        if (client.settings.units === 'mmol') {
          max = client.sbx.roundBGToDisplayFormat(client.sbx.scaleMgdl(max));
          min = client.sbx.roundBGToDisplayFormat(client.sbx.scaleMgdl(min));
        }

        if (d.correctionRange[0] === d.correctionRange[1]) {
          correctionRangeText = '' + min;
        } else {
          correctionRangeText = '' + min + ' - ' + max;
        }
      }

      var durationText;
      if (d.durationType === "indefinite") {
        durationText = translate("Indefinite");
      } else if (d.duration) {
        var durationMinutes = Math.round(d.duration);
        if (durationMinutes > 0 && durationMinutes % 60 == 0) {
          var durationHours = durationMinutes / 60;
          if (durationHours > 1) {
            durationText = durationHours + ' hours';
          } else {
            durationText = durationHours + ' hour';
          }
        } else {
          durationText = durationMinutes + ' min';
        }
      }

      return '<strong>' + translate('Time') + ':</strong> ' + client.formatTime(getOrAddDate(d)) + '<br/>' +
        (d.eventType ? '<strong>' + translate('Treatment type') + ':</strong> ' + translate(client.careportal.resolveEventName(d.eventType)) + '<br/>' : '') +
        (d.reason ? '<strong>' + translate('Reason') + ':</strong> ' + translate(d.reason) + '<br/>' : '') +
        (d.glucose ? '<strong>' + translate('BG') + ':</strong> ' + d.glucose + (d.glucoseType ? ' (' + translate(d.glucoseType) + ')' : '') + '<br/>' : '') +
        (d.enteredBy ? '<strong>' + translate('Entered By') + ':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.targetTop ? '<strong>' + translate('Target Top') + ':</strong> ' + targetTop + '<br/>' : '') +
        (d.targetBottom ? '<strong>' + translate('Target Bottom') + ':</strong> ' + targetBottom + '<br/>' : '') +
        (durationText ? '<strong>' + translate('Duration') + ':</strong> ' + durationText + '<br/>' : '') +
        (d.insulinNeedsScaleFactor ? '<strong>' + translate('Insulin Scale Factor') + ':</strong> ' + d.insulinNeedsScaleFactor * 100 + '%<br/>' : '') +
        (correctionRangeText ? '<strong>' + translate('Correction Range') + ':</strong> ' + correctionRangeText + '<br/>' : '') +
        (d.notes ? '<strong>' + translate('Notes') + ':</strong> ' + d.notes : '');
    }

    function announcementTooltip (d) {
      return '<strong>' + translate('Time') + ':</strong> ' + client.formatTime(getOrAddDate(d)) + '<br/>' +
        (d.eventType ? '<strong>' + translate('Announcement') + '</strong><br/>' : '') +
        (d.notes && d.notes.length > 1 ? '<strong>' + translate('Message') + ':</strong> ' + d.notes + '<br/>' : '') +
        (d.enteredBy ? '<strong>' + translate('Entered By') + ':</strong> ' + d.enteredBy + '<br/>' : '');
    }

    //TODO: filter in oref0 instead of here and after most people upgrade take this out
    var openAPSSpam = ['BasalProfileStart', 'ResultDailyTotal', 'BGReceived'];

    //NOTE: treatments with insulin or carbs are drawn by drawTreatment()
    // bind up the focus chart data to an array of circles
    var treatCircles = chart().focus.selectAll('.treatment-dot').data(client.ddata.treatments.filter(function(treatment) {

      var notCarbsOrInsulin = !treatment.carbs && !treatment.insulin;
      var notTempOrProfile = !_.includes(['Temp Basal', 'Profile Switch', 'Combo Bolus', 'Temporary Target'], treatment.eventType);

      var notes = treatment.notes || '';
      var enteredBy = treatment.enteredBy || '';

      var notOpenAPSSpam = enteredBy.indexOf('openaps://') === -1 || _.isUndefined(_.find(openAPSSpam, function startsWith (spam) {
        return notes.indexOf(spam) === 0;
      }));

      return notCarbsOrInsulin && !treatment.duration && treatment.durationType !== 'indefinite' && notTempOrProfile && notOpenAPSSpam;
    }), function (d) { return d._id; });

    function updateTreatCircles (sel) {

      sel.attr('cx', function(d) {
          return chart().xScale(getOrAddDate(d));
        })
        .attr('cy', function(d) {
          return chart().yScale(client.sbx.scaleEntry(d));
        })
        .attr('r', function() {
          return dotRadius('mbg');
        });

      return sel;
    }

    function prepareTreatCircles (sel) {
      function strokeColor (d) {
        var color = 'white';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'grey';
        }
        return color;
      }

      function fillColor (d) {
        var color = 'grey';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'red';
        }
        return color;
      }

      updateTreatCircles(sel)
        .attr('stroke-width', 2)
        .attr('stroke', strokeColor)
        .attr('fill', fillColor);

      return sel;
    }

    // if already existing then transition each circle to its new position
    updateTreatCircles(treatCircles);

    // if new circle then just display
    prepareTreatCircles(treatCircles.enter().append('circle'))
      .attr('class', 'treatment-dot')
      .on('mouseover', function(d) {
        client.tooltip.style('opacity', .9);
        client.tooltip.html(d.isAnnouncement ? announcementTooltip(d) : treatmentTooltip(d))
          .style('left', tooltipLeft())
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    treatCircles.exit().remove();

    var durationTreatments = client.ddata.treatments.filter(function(treatment) {
      return !treatment.carbs && !treatment.insulin && (treatment.duration || treatment.durationType !== undefined) &&
        !_.includes(['Temp Basal', 'Profile Switch', 'Combo Bolus', 'Temporary Target'], treatment.eventType);
    });

    //use the processed temp target so there are no overlaps
    durationTreatments = durationTreatments.concat(client.ddata.tempTargetTreatments);

    // treatments with duration
    var treatRects = chart().focus.selectAll('.g-duration').data(durationTreatments);

    function fillColor (d) {
      // this is going to be updated by Event Type
      var color = 'grey';
      if (d.eventType === 'Exercise') {
        color = 'Violet';
      } else if (d.eventType === 'Note') {
        color = 'Salmon';
      } else if (d.eventType === 'Temporary Target') {
        color = 'lightgray';
      }
      return color;
    }

    function rectHeight (d) {
      var height = 20;
      if (d.targetTop && d.targetTop > 0 && d.targetBottom && d.targetBottom > 0) {
        height = Math.max(5, d.targetTop - d.targetBottom);
      }
      return height;
    }

    function rectTranslate (d) {
      var top = 50;
      if (d.eventType === 'Temporary Target') {
        top = d.targetTop === d.targetBottom ? d.targetTop + rectHeight(d) : d.targetTop;
      }
      return 'translate(' + chart().xScale(getOrAddDate(d)) + ',' + chart().yScale(utils.scaleMgdl(top)) + ')';
    }

    function treatmentRectWidth (d) {
      if (d.durationType === "indefinite") {
        return chart().xScale(chart().xScale.domain()[1].getTime()) - chart().xScale(getOrAddDate(d));
      } else {
        return chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(getOrAddDate(d));
      }
    }

    function treatmentTextTransform (d) {
      if (d.durationType === "indefinite") {
        var offset = 0;
        if (chart().xScale(getOrAddDate(d)) < chart().xScale(chart().xScale.domain()[0].getTime())) {
          offset = chart().xScale(nowDate) - chart().xScale(getOrAddDate(d));
        }
        return 'translate(' + offset + ',' + 10 + ')';
      } else {
        return 'translate(' + (chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(getOrAddDate(d))) / 2 + ',' + 10 + ')';
      }
    }

    function treatmentText (d) {
      if (d.eventType === 'Temporary Target') {
        return '';
      }
      return d.notes || d.reason || d.eventType;
    }

    function treatmentTextAnchor (d) {
      return d.durationType === "indefinite" ? 'left' : 'middle';
    }

    // if transitioning, update rect text, position, and width
    var rectUpdates = treatRects;
    rectUpdates.attr('transform', rectTranslate);

    rectUpdates.select('text')
      .text(treatmentText)
      .attr('text-anchor', treatmentTextAnchor)
      .attr('transform', treatmentTextTransform);

    rectUpdates.select('rect')
      .attr('width', treatmentRectWidth)

    // if new rect then create new elements
    var newRects = treatRects.enter().append('g')
      .attr('class', 'g-duration')
      .attr('transform', rectTranslate)
      .on('mouseover', function(d) {
        client.tooltip.style('opacity', .9);
        client.tooltip.html(d.isAnnouncement ? announcementTooltip(d) : treatmentTooltip(d))
          .style('left', tooltipLeft())
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    newRects.append('rect')
      .attr('class', 'g-duration-rect')
      .attr('width', treatmentRectWidth)
      .attr('height', rectHeight)
      .attr('rx', 5)
      .attr('ry', 5)
      .attr('opacity', .2)
      .attr('fill', fillColor);

    newRects.append('text')
      .attr('class', 'g-duration-text')
      .style('font-size', 15)
      .attr('fill', 'white')
      .attr('text-anchor', treatmentTextAnchor)
      .attr('dy', '.35em')
      .attr('transform', treatmentTextTransform)
      .text(treatmentText);

    // Remove any rects no longer needed
    treatRects.exit().remove();
  };



  renderer.addContextCircles = function addContextCircles () {
    // bind up the context chart data to an array of circles
    var contextCircles = chart().context.selectAll('circle').data(client.entries);

    function prepareContextCircles (sel) {
      var badData = [];
      sel.attr('cx', function(d) { return chart().xScale2(getOrAddDate(d)); })
        .attr('cy', function(d) {
          var scaled = client.sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return chart().yScale2(utils.scaleMgdl(450));
          } else {
            return chart().yScale2(scaled);
          }
        })
        .attr('fill', function(d) { return d.color; })
        //.style('opacity', function(d) { return renderer.highlightBrushPoints(d) })
        .attr('stroke-width', function(d) { return d.type === 'mbg' ? 2 : 0; })
        .attr('stroke', function() { return 'white'; })
        .attr('r', function(d) { return d.type === 'mbg' ? 4 : 2; });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    // if already existing then transition each circle to its new position
    prepareContextCircles(contextCircles);

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit().remove();
  };

  function calcTreatmentRadius (treatment, opts, carbratio) {
    var CR = treatment.CR || carbratio || 20;
    var carbsOrInsulin = CR;
    if (treatment.carbs) {
      carbsOrInsulin = treatment.carbs;
    } else if (treatment.insulin) {
      carbsOrInsulin = treatment.insulin * CR;
    }

    // R1 determines the size of the treatment dot
    var R1 = Math.sqrt(carbsOrInsulin) / opts.scale
      , R2 = R1
      // R3/R4 determine how far from the treatment dot the labels are placed
      , R3 = R1 + 8 / opts.scale
      , R4 = R1 + 25 / opts.scale;

    return {
      R1: R1
      , R2: R2
      , R3: R3
      , R4: R4
      , isNaN: isNaN(R1) || isNaN(R3) || isNaN(R3)
    };
  }

  function prepareArc (treatment, radius, renderBasal) {
    var arc_data = [
      // white carb half-circle on top
      { 'element': '', 'color': 'white', 'start': -1.5708, 'end': 1.5708, 'inner': 0, 'outer': radius.R1 }
      , { 'element': '', 'color': 'transparent', 'start': -1.5708, 'end': 1.5708, 'inner': radius.R2, 'outer': radius.R3 },
      // blue insulin half-circle on bottom
      { 'element': '', 'color': '#0099ff', 'start': 1.5708, 'end': 4.7124, 'inner': 0, 'outer': radius.R1 },
      // these form a very short transparent arc along the bottom of an insulin treatment to position the label
      // these used to be semicircles from 1.5708 to 4.7124, but that made the tooltip target too big
      { 'element': '', 'color': 'transparent', 'start': 3.1400, 'end': 3.1432, 'inner': radius.R2, 'outer': radius.R3 }
      , { 'element': '', 'color': 'transparent', 'start': 3.1400, 'end': 3.1432, 'inner': radius.R2, 'outer': radius.R4 }
    ]
      , arc_data_1_elements = [];

    arc_data[0].outlineOnly = !treatment.carbs;
    arc_data[2].outlineOnly = !treatment.insulin;

    if (treatment.carbs > 0) {
      arc_data_1_elements.push(Math.round(treatment.carbs) + ' g');
    }

    if (treatment.protein > 0) {
      arc_data_1_elements.push(Math.round(treatment.protein) + ' g');
    }

    if (treatment.fat > 0) {
      arc_data_1_elements.push(Math.round(treatment.fat) + ' g');
    }

    arc_data[1].element = arc_data_1_elements.join(' / ');

    if (treatment.foodType) {
      arc_data[1].element = arc_data[1].element + " " + treatment.foodType;
    }

    if (treatment.insulin > 0) {
      var dosage_units = '' + Math.round(treatment.insulin * 100) / 100;
      
      if (renderBasal === 'all-remove-zero-u') {
        dosage_units = (dosage_units + "").replace(/^0/, "");
      }

      var unit_of_measurement = (renderBasal === 'all-remove-zero-u' ? '' : ' U'); // One international unit of insulin (1 IU) is shown as '1 U'
      
      arc_data[3].element = dosage_units + unit_of_measurement;
    }

    if (treatment.status) {
      arc_data[4].element = translate(treatment.status);
    }

    var arc = d3.arc()
      .innerRadius(function(d) {
        return 5 * d.inner;
      })
      .outerRadius(function(d) {
        return 5 * d.outer;
      })
      .endAngle(function(d) {
        return d.start;
      })
      .startAngle(function(d) {
        return d.end;
      });

    return {
      data: arc_data
      , svg: arc
    };
  }

  function isInRect (x, y, rect) {
    return !(x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height);
  }

  function appendTreatments (treatment, arc) {

    function boluscalcTooltip (treatment) {
      if (!treatment.boluscalc) {
        return '';
      }
      var html = '<hr>';
      html += (treatment.boluscalc.othercorrection ? '<strong>' + translate('Other correction') + ':</strong> ' + parseFloat(treatment.boluscalc.othercorrection).toFixed(2) + 'U<br/>' : '');
      html += (treatment.boluscalc.profile ? '<strong>' + translate('Profile used') + ':</strong> ' + treatment.boluscalc.profile + '<br/>' : '');
      if (treatment.boluscalc.foods && treatment.boluscalc.foods.length) {
        html += '<table><tr><td><strong>' + translate('Food') + '</strong></td></tr>';
        for (var fi = 0; fi < treatment.boluscalc.foods.length; fi++) {
          var f = treatment.boluscalc.foods[fi];
          html += '<tr>';
          html += '<td>' + f.name + '</td>';
          html += '<td>' + (f.portion * f.portions).toFixed(1) + ' ' + f.unit + '</td>';
          html += '<td>(' + (f.carbs * f.portions).toFixed(1) + ' g)</td>';
          html += '</tr>';
        }
        html += '</table>';
      }
      return html;
    }

    function treatmentTooltip () {
      var glucose = treatment.glucose;
      if (client.settings.units != client.ddata.profile.getUnits()) {
        glucose *= (client.settings.units === 'mmol' ? (1 / consts.MMOL_TO_MGDL) : consts.MMOL_TO_MGDL);
        var decimals = (client.settings.units === 'mmol' ? 10 : 1);

        glucose = Math.round(glucose * decimals) / decimals;
      }

      client.tooltip.style('opacity', .9);
      client.tooltip.html('<strong>' + translate('Time') + ':</strong> ' + client.formatTime(getOrAddDate(treatment)) + '<br/>' + '<strong>' + translate('Treatment type') + ':</strong> ' + translate(client.careportal.resolveEventName(treatment.eventType)) + '<br/>' +
          (treatment.carbs ? '<strong>' + translate('Carbs') + ':</strong> ' + treatment.carbs + '<br/>' : '') +
          (treatment.protein ? '<strong>' + translate('Protein') + ':</strong> ' + treatment.protein + '<br/>' : '') +
          (treatment.fat ? '<strong>' + translate('Fat') + ':</strong> ' + treatment.fat + '<br/>' : '') +
          (treatment.absorptionTime > 0 ? '<strong>' + translate('Absorption Time') + ':</strong> ' + (Math.round(treatment.absorptionTime / 60.0 * 10) / 10) + 'h' + '<br/>' : '') +
          (treatment.insulin ? '<strong>' + translate('Insulin') + ':</strong> ' + treatment.insulin + '<br/>' : '') +
          (treatment.enteredinsulin ? '<strong>' + translate('Combo Bolus') + ':</strong> ' + treatment.enteredinsulin + 'U, ' + treatment.splitNow + '% : ' + treatment.splitExt + '%, ' + translate('Duration') + ': ' + treatment.duration + '<br/>' : '') +
          (treatment.glucose ? '<strong>' + translate('BG') + ':</strong> ' + glucose + (treatment.glucoseType ? ' (' + translate(treatment.glucoseType) + ')' : '') + '<br/>' : '') +
          (treatment.enteredBy ? '<strong>' + translate('Entered By') + ':</strong> ' + treatment.enteredBy + '<br/>' : '') +
          (treatment.notes ? '<strong>' + translate('Notes') + ':</strong> ' + treatment.notes : '') +
          boluscalcTooltip(treatment)
        )
        .style('left', tooltipLeft())
        .style('top', (d3.event.pageY + 15) + 'px');
    }

    var newTime;
    var deleteRect = { x: 0, y: 0, width: 0, height: 0 };
    var insulinRect = { x: 0, y: 0, width: 0, height: 0 };
    var carbsRect = { x: 0, y: 0, width: 0, height: 0 };
    var operation;
    renderer.drag = d3.drag()
      .on('start', function() {
        //console.log(treatment);
        var windowWidth = $(client.tooltip.node()).parent().parent().width();
        var left = d3.event.x + TOOLTIP_WIDTH < windowWidth ? d3.event.x : windowWidth - TOOLTIP_WIDTH - 10;
        client.tooltip.style('opacity', .9)
          .style('left', left + 'px')
          .style('top', (d3.event.pageY ? d3.event.pageY + 15 : 40) + 'px');

        deleteRect = {
          x: 0
          , y: 0
          , width: 50
          , height: chart().yScale(chart().yScale.domain()[0])
        };
        chart().drag.append('rect')
          .attr('class', 'drag-droparea')
          .attr('x', deleteRect.x)
          .attr('y', deleteRect.y)
          .attr('width', deleteRect.width)
          .attr('height', deleteRect.height)
          .attr('fill', 'red')
          .attr('opacity', 0.4)
          .attr('rx', 10)
          .attr('ry', 10);
        chart().drag.append('text')
          .attr('class', 'drag-droparea')
          .attr('x', deleteRect.x + deleteRect.width / 2)
          .attr('y', deleteRect.y + deleteRect.height / 2)
          .attr('font-size', 15)
          .attr('font-weight', 'bold')
          .attr('fill', 'red')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('transform', 'rotate(-90 ' + (deleteRect.x + deleteRect.width / 2) + ',' + (deleteRect.y + deleteRect.height / 2) + ')')
          .text(translate('Remove'));

        if (treatment.insulin && treatment.carbs) {
          carbsRect = {
            x: 0
            , y: 0
            , width: chart().charts.attr('width')
            , height: 50
          };
          insulinRect = {
            x: 0
            , y: chart().yScale(chart().yScale.domain()[0]) - 50
            , width: chart().charts.attr('width')
            , height: 50
          };
          chart().drag.append('rect')
            .attr('class', 'drag-droparea')
            .attr('x', carbsRect.x)
            .attr('y', carbsRect.y)
            .attr('width', carbsRect.width)
            .attr('height', carbsRect.height)
            .attr('fill', 'white')
            .attr('opacitys', 0.4)
            .attr('rx', 10)
            .attr('ry', 10);
          chart().drag.append('text')
            .attr('class', 'drag-droparea')
            .attr('x', carbsRect.x + carbsRect.width / 2)
            .attr('y', carbsRect.y + carbsRect.height / 2)
            .attr('font-size', 15)
            .attr('font-weight', 'bold')
            .attr('fill', 'white')
            .attr('text-anchor', 'middle')
            .attr('dy', '.35em')
            .text(translate('Move carbs'));
          chart().drag.append('rect')
            .attr('class', 'drag-droparea')
            .attr('x', insulinRect.x)
            .attr('y', insulinRect.y)
            .attr('width', insulinRect.width)
            .attr('height', insulinRect.height)
            .attr('fill', '#0099ff')
            .attr('opacity', 0.4)
            .attr('rx', 10)
            .attr('ry', 10);
          chart().drag.append('text')
            .attr('class', 'drag-droparea')
            .attr('x', insulinRect.x + insulinRect.width / 2)
            .attr('y', insulinRect.y + insulinRect.height / 2)
            .attr('font-size', 15)
            .attr('font-weight', 'bold')
            .attr('fill', '#0099ff')
            .attr('text-anchor', 'middle')
            .attr('dy', '.35em')
            .text(translate('Move insulin'));
        }

        chart().basals.attr('display', 'none');

        operation = 'Move';
      })
      .on('drag', function() {
        //console.log(d3.event);
        client.tooltip.style('opacity', .9);
        var x = Math.min(Math.max(0, d3.event.x), chart().charts.attr('width'));
        var y = Math.min(Math.max(0, d3.event.y), chart().focusHeight);

        operation = 'Move';
        if (isInRect(x, y, deleteRect) && isInRect(x, y, insulinRect)) {
          operation = 'Remove insulin';
        } else if (isInRect(x, y, deleteRect) && isInRect(x, y, carbsRect)) {
          operation = 'Remove carbs';
        } else if (isInRect(x, y, deleteRect)) {
          operation = 'Remove';
        } else if (isInRect(x, y, insulinRect)) {
          operation = 'Move insulin';
        } else if (isInRect(x, y, carbsRect)) {
          operation = 'Move carbs';
        }

        newTime = new Date(chart().xScale.invert(x));
        var minDiff = times.msecs(newTime.getTime() - treatment.mills).mins.toFixed(0);
        client.tooltip.html(
          '<b>' + translate('Operation') + ':</b> ' + translate(operation) + '<br>' +
          '<b>' + translate('New time') + ':</b> ' + newTime.toLocaleTimeString() + '<br>' +
          '<b>' + translate('Difference') + ':</b> ' + (minDiff > 0 ? '+' : '') + minDiff + ' ' + translate('mins')
        );

        chart().drag.selectAll('.arrow').remove();
        chart().drag.append('line')
          .attr('class', 'arrow')
          .attr('marker-end', 'url(#arrow)')
          .attr('x1', chart().xScale(getOrAddDate(treatment)))
          .attr('y1', chart().yScale(client.sbx.scaleEntry(treatment)))
          .attr('x2', x)
          .attr('y2', y)
          .attr('stroke-width', 2)
          .attr('stroke', 'white');
      })
      .on('end', function() {
        var newTreatment;
        chart().drag.selectAll('.drag-droparea').remove();
        hideTooltip();
        switch (operation) {
          case 'Move':
            if (window.confirm(translate('Change treatment time to %1 ?', { params: [newTime.toLocaleTimeString()] }))) {
              client.socket.emit(
                'dbUpdate', {
                  collection: 'treatments'
                  , _id: treatment._id
                  , data: { created_at: newTime.toISOString() }
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove insulin':
            if (window.confirm(translate('Remove insulin from treatment ?'))) {
              client.socket.emit(
                'dbUpdateUnset', {
                  collection: 'treatments'
                  , _id: treatment._id
                  , data: { insulin: 1 }
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove carbs':
            if (window.confirm(translate('Remove carbs from treatment ?'))) {
              client.socket.emit(
                'dbUpdateUnset', {
                  collection: 'treatments'
                  , _id: treatment._id
                  , data: { carbs: 1 }
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove':
            if (window.confirm(translate('Remove treatment ?'))) {
              client.socket.emit(
                'dbRemove', {
                  collection: 'treatments'
                  , _id: treatment._id
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Move insulin':
            if (window.confirm(translate('Change insulin time to %1 ?', { params: [newTime.toLocaleTimeString()] }))) {
              client.socket.emit(
                'dbUpdateUnset', {
                  collection: 'treatments'
                  , _id: treatment._id
                  , data: { insulin: 1 }
                }
              );
              newTreatment = _.cloneDeep(treatment);
              delete newTreatment._id;
              delete newTreatment.NSCLIENT_ID;
              delete newTreatment.carbs;
              newTreatment.created_at = newTime.toISOString();
              client.socket.emit(
                'dbAdd', {
                  collection: 'treatments'
                  , data: newTreatment
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Move carbs':
            if (window.confirm(translate('Change carbs time to %1 ?', { params: [newTime.toLocaleTimeString()] }))) {
              client.socket.emit(
                'dbUpdateUnset', {
                  collection: 'treatments'
                  , _id: treatment._id
                  , data: { carbs: 1 }
                }
              );
              newTreatment = _.cloneDeep(treatment);
              delete newTreatment._id;
              delete newTreatment.NSCLIENT_ID;
              delete newTreatment.insulin;
              newTreatment.created_at = newTime.toISOString();
              client.socket.emit(
                'dbAdd', {
                  collection: 'treatments'
                  , data: newTreatment
                }
                , function callback (result) {
                  console.log(result);
                  chart().drag.selectAll('.arrow').style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
        }
        chart().basals.attr('display', '');
      });

    var treatmentDots = chart().focus.selectAll('treatment-insulincarbs')
      .data(arc.data)
      .enter()
      .append('g')
      .attr('class', 'draggable-treatment')
      .attr('transform', 'translate(' + chart().xScale(getOrAddDate(treatment)) + ', ' + chart().yScale(client.sbx.scaleEntry(treatment)) + ')')
      .on('mouseover', treatmentTooltip)
      .on('mouseout', hideTooltip);
    if (client.editMode) {
      treatmentDots
        .style('cursor', 'move')
        .call(renderer.drag);
    }

    treatmentDots.append('path')
      .attr('class', 'path')
      .attr('fill', function(d) {
        return d.outlineOnly ? 'transparent' : d.color;
      })
      .attr('stroke-width', function(d) {
        return d.outlineOnly ? 1 : 0;
      })
      .attr('stroke', function(d) {
        return d.color;
      })
      .attr('id', function(d, i) {
        return 's' + i;
      })
      .attr('d', arc.svg);

    return treatmentDots;
  }

  function appendLabels (treatmentDots, arc, opts) {
    // labels for carbs and insulin
    if (opts.showLabels) {
      var label = treatmentDots.append('g')
        .attr('class', 'path')
        .attr('id', 'label')
        .style('fill', 'white');

      label.append('text')
        .style('font-size', function(d) {
          var fontSize = ( (opts.treatments >= 30) ? 40 : 50 - Math.floor((25 - opts.treatments) / 30 * 10) ) / opts.scale;
          var elementValue = parseFloat(d.element);
          if (!isNaN(elementValue) && elementValue < 1) {
            fontSize = (25 + Math.floor(elementValue * 10)) / opts.scale;
          }
          return fontSize;
        })
        .style('text-shadow', '0px 0px 10px rgba(0, 0, 0, 1)')
        .attr('text-anchor', 'middle')
        .attr('dy', '.35em')
        .attr('transform', function(d) {
          d.outerRadius = d.outerRadius * 2.1;
          d.innerRadius = d.outerRadius * 2.1;
          return 'translate(' + arc.svg.centroid(d) + ')';
        })
        .text(function(d) {
          return d.element;
        });
    }
  }

  renderer.drawTreatments = function drawTreatments (client) {

    var treatmentCount = 0;
    var renderBasal = client.settings.extendedSettings.bolus.render;
    chart().focus.selectAll('.draggable-treatment').remove();

    _.forEach(client.ddata.treatments, function eachTreatment (d) {
      if (Number(d.insulin) > 0 || Number(d.carbs) > 0) { treatmentCount += 1; }
    });

    // add treatment bubbles
    _.forEach(client.ddata.treatments, function eachTreatment (d) {
      var showLabels =  ( !d.carbs && ( ( renderBasal == 'none') || ( renderBasal === 'over' && d.insulin < client.settings.bolusRenderOver) ) ) ? false : true;
      renderer.drawTreatment(d, {
        scale: renderer.bubbleScale()
        , showLabels: showLabels
        , treatments: treatmentCount
      }, client.sbx.data.profile.getCarbRatio(new Date()),
      renderBasal);
    });
  };

  renderer.drawTreatment = function drawTreatment (treatment, opts, carbratio, renderBasal) {
    if (!treatment.carbs && !treatment.protein && !treatment.fat && !treatment.insulin) {
      return;
    }

    //when the tests are run window isn't available
    var innerWidth = window && window.innerWidth || -1;
    // don't render the treatment if it's not visible
    if (Math.abs(chart().xScale(getOrAddDate(treatment))) > innerWidth) {
      return;
    }

    var radius = calcTreatmentRadius(treatment, opts, carbratio);
    if (radius.isNaN) {
      console.warn('Bad Data: Found isNaN value in treatment', treatment);
      return;
    }

    var arc = prepareArc(treatment, radius, renderBasal);
    var treatmentDots = appendTreatments(treatment, arc);
    appendLabels(treatmentDots, arc, opts);
  };

  renderer.addBasals = function addBasals (client) {

    if (!client.settings.isEnabled('basal')) {
      return;
    }
    var mode = client.settings.extendedSettings.basal.render;
    var profile = client.sbx.data.profile;
    var linedata = [];
    var notemplinedata = [];
    var basalareadata = [];
    var tempbasalareadata = [];
    var comboareadata = [];
    var selectedRange = chart().createAdjustedRange();
    var from = selectedRange[0].getTime();
    var to = selectedRange[1].getTime();

    var date = from;
    var lastbasal = 0;

    if (!profile.activeProfileToTime(from)) {
      window.alert(translate('Redirecting you to the Profile Editor to create a new profile.'));
      try {
        window.location.href = '/profile';
      } catch (err) {
        //doesn't work when running tests, so catch and ignore
      }
      return;
    }

    while (date <= to) {
      var basalvalue = profile.getTempBasal(date);
      if (!_.isEqual(lastbasal, basalvalue)) {
        linedata.push({ d: date, b: basalvalue.totalbasal });
        notemplinedata.push({ d: date, b: basalvalue.basal });
        if (basalvalue.combobolustreatment && basalvalue.combobolustreatment.relative) {
          tempbasalareadata.push({ d: date, b: basalvalue.tempbasal });
          basalareadata.push({ d: date, b: 0 });
          comboareadata.push({ d: date, b: basalvalue.totalbasal });
        } else if (basalvalue.treatment) {
          tempbasalareadata.push({ d: date, b: basalvalue.totalbasal });
          basalareadata.push({ d: date, b: 0 });
          comboareadata.push({ d: date, b: 0 });
        } else {
          tempbasalareadata.push({ d: date, b: 0 });
          basalareadata.push({ d: date, b: basalvalue.totalbasal });
          comboareadata.push({ d: date, b: 0 });
        }
      }
      lastbasal = basalvalue;
      date += times.mins(1).msecs;
    }

    var toTempBasal = profile.getTempBasal(to);

    linedata.push({ d: to, b: toTempBasal.totalbasal });
    notemplinedata.push({ d: to, b: toTempBasal.basal });
    basalareadata.push({ d: to, b: toTempBasal.basal });
    tempbasalareadata.push({ d: to, b: toTempBasal.totalbasal });
    comboareadata.push({ d: to, b: toTempBasal.totalbasal });

    var max_linedata = d3.max(linedata, function(d) { return d.b; });
    var max_notemplinedata = d3.max(notemplinedata, function(d) { return d.b; });
    var max = Math.max(max_linedata, max_notemplinedata) * ('icicle' === mode ? 1 : 1.1);
    chart().maxBasalValue = max;
    chart().yScaleBasals.domain('icicle' === mode ? [0, max] : [max, 0]);

    chart().basals.selectAll('g').remove();
    chart().basals.selectAll('.basalline').remove().data(linedata);
    chart().basals.selectAll('.notempline').remove().data(notemplinedata);
    chart().basals.selectAll('.basalarea').remove().data(basalareadata);
    chart().basals.selectAll('.tempbasalarea').remove().data(tempbasalareadata);
    chart().basals.selectAll('.comboarea').remove().data(comboareadata);

    var valueline = d3.line()
      .x(function(d) { return chart().xScaleBasals(d.d); })
      .y(function(d) { return chart().yScaleBasals(d.b); })
      .curve(d3.curveStepAfter);

    var area = d3.area()
      .x(function(d) { return chart().xScaleBasals(d.d); })
      .y0(chart().yScaleBasals(0))
      .y1(function(d) { return chart().yScaleBasals(d.b); })
      .curve(d3.curveStepAfter);

    var g = chart().basals.append('g');

    g.append('path')
      .attr('class', 'line basalline')
      .attr('stroke', '#0099ff')
      .attr('stroke-width', 1)
      .attr('fill', 'none')
      .attr('d', valueline(linedata));

    g.append('path')
      .attr('class', 'line notempline')
      .attr('stroke', '#0099ff')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', ('3, 3'))
      .attr('fill', 'none')
      .attr('d', valueline(notemplinedata));

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
      .attr('fill-opacity', .2)
      .attr('stroke-width', 1)
      .attr('d', area);

    g.append('path')
      .attr('class', 'area comboarea')
      .datum(comboareadata)
      .attr('fill', 'url(#hash)')
      .attr('fill-opacity', .2)
      .attr('stroke-width', 1)
      .attr('d', area);

    _.forEach(client.ddata.tempbasalTreatments, function eachTemp (t) {
      // only if basal and focus interval overlap and there is a chance to fit
      if (t.duration && t.mills < to && t.mills + times.mins(t.duration).msecs > from) {
        var text = g.append('text')
          .attr('class', 'tempbasaltext')
          .style('font-size', 15)
          .attr('fill', '#0099ff')
          .attr('text-anchor', 'middle')
          .attr('dy', '.35em')
          .attr('x', chart().xScaleBasals((Math.max(t.mills, from) + Math.min(t.mills + times.mins(t.duration).msecs, to)) / 2))
          .attr('y', 10)
          .text((t.percent ? (t.percent > 0 ? '+' : '') + t.percent + '%' : '') + (isNaN(t.absolute) ? '' : Number(t.absolute).toFixed(2) + 'U') + (t.relative ? 'C: +' + t.relative + 'U' : ''));
        // better hide if not fit
        if (text.node().getBBox().width > chart().xScaleBasals(t.mills + times.mins(t.duration).msecs) - chart().xScaleBasals(t.mills)) {
          text.attr('display', 'none');
        }
      }
    });

    client.chart.basals.attr('display', !mode || 'none' === mode ? 'none' : '');
  };

  renderer.addTreatmentProfiles = function addTreatmentProfiles (client) {
    if (client.profilefunctions.listBasalProfiles().length < 2) {
      return; // do not visualize profiles if there is only one
    }

    function profileTooltip (d) {
      return '<strong>' + translate('Time') + ':</strong> ' + client.formatTime(getOrAddDate(d)) + '<br/>' +
        (d.eventType ? '<strong>' + translate('Treatment type') + ':</strong> ' + translate(client.careportal.resolveEventName(d.eventType)) + '<br/>' : '') +
        (d.endprofile ? '<strong>' + translate('End of profile') + ':</strong> ' + d.endprofile + '<br/>' : '') +
        (d.profile ? '<strong>' + translate('Profile') + ':</strong> ' + d.profile + '<br/>' : '') +
        (d.duration ? '<strong>' + translate('Duration') + ':</strong> ' + d.duration + translate('mins') + '<br/>' : '') +
        (d.enteredBy ? '<strong>' + translate('Entered By') + ':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.notes ? '<strong>' + translate('Notes') + ':</strong> ' + d.notes : '');
    }

    // calculate position of profile on left side
    var selectedRange = chart().createAdjustedRange();
    var from = selectedRange[0].getTime();
    var to = selectedRange[1].getTime();
    var mult = (to - from) / times.hours(24).msecs;
    from += times.mins(20 * mult).msecs;

    var mode = client.settings.extendedSettings.basal.render;
    var data = client.ddata.profileTreatments.slice();
    data.push({
      //eventType: 'Profile Switch'
      profile: client.profilefunctions.activeProfileToTime(from)
      , mills: from
      , first: true
    });

    _.forEach(client.ddata.profileTreatments, function eachTreatment (d) {
      if (d.duration && !d.cuttedby) {
        data.push({
          cutting: d.profile
          , profile: client.profilefunctions.activeProfileToTime(times.mins(d.duration).msecs + d.mills + 1)
          , mills: times.mins(d.duration).msecs + d.mills
          , end: true
        });
      }
    });

    var treatProfiles = chart().basals.selectAll('.g-profile').data(data);

    var topOfText = ('icicle' === mode ? chart().maxBasalValue + 0.05 : -0.05);

    var generateText = function(t) {
      var sign = t.first ? '▲▲▲' : '▬▬▬';
      var ret;
      if (t.cutting) {
        ret = sign + '    ' + t.cutting + '    ' + '►►►' + '    ' + t.profile + '    ' + sign;
      } else {
        ret = sign + '    ' + t.profile + '    ' + sign;
      }
      return ret;
    };

    treatProfiles.attr('transform', function(t) {
        // change text of record on left side
        return 'rotate(-90,' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ') ' +
          'translate(' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ')';
      }).
    text(generateText);

    treatProfiles.enter().append('text')
      .attr('class', 'g-profile')
      .style('font-size', 15)
      .style('font-weight', 'bold')
      .attr('fill', '#0099ff')
      .attr('text-anchor', 'end')
      .attr('dy', '.35em')
      .attr('transform', function(t) {
        return 'rotate(-90 ' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ') ' +
          'translate(' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ')';
      })
      .text(generateText)
      .on('mouseover', function(d) {
        client.tooltip.style('opacity', .9);
        client.tooltip.html(profileTooltip(d))
          .style('left', (d3.event.pageX) + 'px')
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    treatProfiles.exit().remove();
  };

  return renderer;
}

module.exports = init;
