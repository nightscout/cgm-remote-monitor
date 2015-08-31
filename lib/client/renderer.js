'use strict';

var times = require('../times');

var DEFAULT_FOCUS = times.hours(3).msecs
  , WIDTH_SMALL_DOTS = 420
  , WIDTH_BIG_DOTS = 800
  , TOOLTIP_TRANS_MS = 200 // milliseconds
  ;

function init (client, d3) {

  var renderer = { };

  var utils = client.utils;
  var translate = client.translate;

  //chart isn't created till the client gets data, so can grab the var at init
  function chart() {
    return client.chart;
  }

  function focusRangeAdjustment ( ) {
    return client.foucusRangeMS === DEFAULT_FOCUS ? 1 : 1 + ((client.foucusRangeMS - DEFAULT_FOCUS) / DEFAULT_FOCUS / 8);
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

  function hideTooltip ( ) {
    client.tooltip.transition()
      .duration(TOOLTIP_TRANS_MS)
      .style('opacity', 0);
  }

  // get the desired opacity for context chart based on the brush extent
  renderer.highlightBrushPoints = function highlightBrushPoints(data) {
    if (data.mills >= chart().brush.extent()[0].getTime() && data.mills <= chart().brush.extent()[1].getTime()) {
      return chart().futureOpacity(data.mills - client.latestSGV.mills);
    } else {
      return 0.5;
    }
  };

  renderer.bubbleScale = function bubbleScale ( ) {
    // a higher bubbleScale will produce smaller bubbles (it's not a radius like focusDotRadius)
    return (chart().prevChartWidth < WIDTH_SMALL_DOTS ? 4 : (chart().prevChartWidth < WIDTH_BIG_DOTS ? 3 : 2)) * focusRangeAdjustment();
  };

  function isDexcom(device) {
    return device && device.toLowerCase().indexOf('dexcom') === 0;
  }

  renderer.addFocusCircles = function addFocusCircles ( ) {
    // get slice of data so that concatenation of predictions do not interfere with subsequent updates
    var focusData = client.data.slice();

    if (client.sbx.pluginBase.forecastPoints) {
      focusData = focusData.concat(client.sbx.pluginBase.forecastPoints);
    }

    // bind up the focus chart data to an array of circles
    // selects all our data into data and uses date function to get current max date
    var focusCircles = chart().focus.selectAll('circle').data(focusData, client.entryToDate);

    function prepareFocusCircles(sel) {
      var badData = [];
      sel.attr('cx', function (d) {
        if (!d) {
          console.error('Bad data', d);
          return chart().xScale(new Date(0));
        } else if (!d.mills) {
          console.error('Bad data, no mills', d);
          return chart().xScale(new Date(0));
        } else {
          return chart().xScale(new Date(d.mills));
        }
      })
        .attr('cy', function (d) {
          var scaled = client.sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return chart().yScale(utils.scaleMgdl(450));
          } else {
            return chart().yScale(scaled);
          }
        })
        .attr('fill', function (d) {
          return d.type === 'forecast' ? 'none' : d.color;
        })
        .attr('opacity', function (d) {
          return chart().futureOpacity(d.mills - client.latestSGV.mills);
        })
        .attr('stroke-width', function (d) {
          return d.type === 'mbg' ? 2 : d.type === 'forecast' ? 1 : 0;
        })
        .attr('stroke', function (d) {
          return (isDexcom(d.device) ? 'white' : d.type === 'forecast' ? d.color : '#0099ff');
        })
        .attr('r', function (d) {
          return dotRadius(d.type);
        });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    function focusCircleTooltip (d) {
      if (d.type !== 'sgv' && d.type !== 'mbg') {
        return;
      }

      function bgType ( ) {
        return d.type === 'sgv' ? 'CGM' : (isDexcom(d.device) ? 'Calibration' : 'Meter');
      }

      function getRawbgInfo ( ) {
        var info = { };
        if (d.type === 'sgv') {
          info.noise = client.rawbg.noiseCodeToDisplay(d.mgdl, d.noise);
          if (client.rawbg.showRawBGs(d.mgdl, d.noise, client.cal, client.sbx)) {
            info.value = utils.scaleMgdl(client.rawbg.calc(d, client.cal, client.sbx));
          }
        }
        return info;
      }

      var rawbgInfo = getRawbgInfo();

      client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
      client.tooltip.html('<strong>' + bgType() + translate('BG')+ ':</strong> ' + client.sbx.scaleEntry(d) +
        (d.type === 'mbg' ? '<br/><strong>' + translate('Device') + ': </strong>' + d.device : '') +
        (rawbgInfo.value ? '<br/><strong>' + translate('Raw BG') + ':</strong> ' + rawbgInfo.value : '') +
        (rawbgInfo.noise ? '<br/><strong>' + translate('Noise') + ':</strong> ' + rawbgInfo.noise : '') +
        '<br/><strong>' + translate('Time') + ':</strong> ' + client.formatTime(new Date(d.mills)))
        .style('left', (d3.event.pageX) + 'px')
        .style('top', (d3.event.pageY + 15) + 'px');
    }

    // if already existing then transition each circle to its new position
    prepareFocusCircles(focusCircles.transition());

    // if new circle then just display
    prepareFocusCircles(focusCircles.enter().append('circle'))
      .on('mouseover', focusCircleTooltip)
      .on('mouseout', hideTooltip);

    focusCircles.exit().remove();

    // add clipping path so that data stays within axis
    focusCircles.attr('clip-path', 'url(#clip)');
  };

  renderer.addTreatmentCircles = function addTreatmentCircles ( ) {
    function treatmentTooltip (d) {
      return '<strong>'+translate('Time')+':</strong> ' + client.formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Treatment type')+':</strong> ' + d.eventType + '<br/>' : '') +
        (d.glucose ? '<strong>'+translate('BG')+':</strong> ' + d.glucose + (d.glucoseType ? ' (' + translate(d.glucoseType) + ')': '') + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered by')+':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.notes ? '<strong>'+translate('Notes')+':</strong> ' + d.notes : '');
    }

    function announcementTooltip (d) {
      return '<strong>'+translate('Time')+':</strong> ' + client.formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Announcement')+'</strong><br/>' : '') +
        (d.notes && d.notes.length > 1 ? '<strong>'+translate('Message')+':</strong> ' + d.notes + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered by')+':</strong> ' + d.enteredBy + '<br/>' : '');
    }

    //NOTE: treatments with insulin or carbs are drawn by drawTreatment()
    // bind up the focus chart data to an array of circles
    var treatCircles = chart().focus.selectAll('rect').data(client.treatments.filter(function(treatment) {
      return !treatment.carbs && !treatment.insulin;
    }));

    function prepareTreatCircles(sel) {
      function strokeColor(d) {
        var color = 'white';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'grey';
        }
        return color;
      }

      function fillColor(d) {
        var color = 'grey';
        if (d.isAnnouncement) {
          color = 'orange';
        } else if (d.glucose) {
          color = 'red';
        }
        return color;
      }

      sel.attr('cx', function (d) {
        return chart().xScale(new Date(d.mills));
      })
        .attr('cy', function (d) {
          return chart().yScale(client.sbx.scaleEntry(d));
        })
        .attr('r', function () {
          return dotRadius('mbg');
        })
        .attr('stroke-width', 2)
        .attr('stroke', strokeColor)
        .attr('fill', fillColor);

      return sel;
    }

    // if already existing then transition each circle to its new position
    prepareTreatCircles(treatCircles.transition());

    // if new circle then just display
    prepareTreatCircles(treatCircles.enter().append('circle'))
      .on('mouseover', function (d) {
        client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
        client.tooltip.html(d.isAnnouncement ? announcementTooltip(d) : treatmentTooltip(d))
          .style('left', (d3.event.pageX) + 'px')
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    treatCircles.attr('clip-path', 'url(#clip)');
  };

  renderer.addContextCircles = function addContextCircles ( ) {
    // bind up the context chart data to an array of circles
    var contextCircles = chart().context.selectAll('circle').data(client.data);

    function prepareContextCircles(sel) {
      var badData = [];
      sel.attr('cx', function (d) { return chart().xScale2(new Date(d.mills)); })
        .attr('cy', function (d) {
          var scaled = client.sbx.scaleEntry(d);
          if (isNaN(scaled)) {
            badData.push(d);
            return chart().yScale2(utils.scaleMgdl(450));
          } else {
            return chart().yScale2(scaled);
          }
        })
        .attr('fill', function (d) { return d.color; })
        .style('opacity', function (d) { return renderer.highlightBrushPoints(d) })
        .attr('stroke-width', function (d) { return d.type === 'mbg' ? 2 : 0; })
        .attr('stroke', function ( ) { return 'white'; })
        .attr('r', function (d) { return d.type === 'mbg' ? 4 : 2; });

      if (badData.length > 0) {
        console.warn('Bad Data: isNaN(sgv)', badData);
      }

      return sel;
    }

    // if already existing then transition each circle to its new position
    prepareContextCircles(contextCircles.transition());

    // if new circle then just display
    prepareContextCircles(contextCircles.enter().append('circle'));

    contextCircles.exit().remove();
  };

  function calcTreatmentRadius(treatment, opts) {
    var CR = treatment.CR || 20;
    var carbs = treatment.carbs || CR;
    var insulin = treatment.insulin || 1;

    var R1 = Math.sqrt(Math.min(carbs, insulin * CR)) / opts.scale
      , R2 = Math.sqrt(Math.max(carbs, insulin * CR)) / opts.scale
      , R3 = R2 + 8 / opts.scale
      ;

    return {
      R1: R1
      , R2: R2
      , R3: R3
      , isNaN: isNaN(R1) || isNaN(R3) || isNaN(R3)
    };
  }

  function prepareArc(treatment, radius) {
    var arc_data = [
      { 'element': '', 'color': 'white', 'start': -1.5708, 'end': 1.5708, 'inner': 0, 'outer': radius.R1 },
      { 'element': '', 'color': 'transparent', 'start': -1.5708, 'end': 1.5708, 'inner': radius.R2, 'outer': radius.R3 },
      { 'element': '', 'color': '#0099ff', 'start': 1.5708, 'end': 4.7124, 'inner': 0, 'outer': radius.R1 },
      { 'element': '', 'color': 'transparent', 'start': 1.5708, 'end': 4.7124, 'inner': radius.R2, 'outer': radius.R3 }
    ];

    arc_data[0].outlineOnly = !treatment.carbs;
    arc_data[2].outlineOnly = !treatment.insulin;

    if (treatment.carbs > 0) {
      arc_data[1].element = Math.round(treatment.carbs) + ' g';
    }

    if (treatment.insulin > 0) {
      arc_data[3].element = Math.round(treatment.insulin * 100) / 100 + ' U';
    }

    var arc = d3.svg.arc()
      .innerRadius(function (d) {
        return 5 * d.inner;
      })
      .outerRadius(function (d) {
        return 5 * d.outer;
      })
      .endAngle(function (d) {
        return d.start;
      })
      .startAngle(function (d) {
        return d.end;
      });

    return {
      data: arc_data
      , svg: arc
    };
  }

  function appendTreatments(treatment, arc) {
    function treatmentTooltip() {
      client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
      client.tooltip.html('<strong>' + translate('Time') + ':</strong> ' + client.formatTime(new Date(treatment.mills)) + '<br/>' + '<strong>' + translate('Treatment type') + ':</strong> ' + translate(treatment.eventType) + '<br/>' +
        (treatment.carbs ? '<strong>' + translate('Carbs') + ':</strong> ' + treatment.carbs + '<br/>' : '') +
        (treatment.insulin ? '<strong>' + translate('Insulin') + ':</strong> ' + treatment.insulin + '<br/>' : '') +
        (treatment.glucose ? '<strong>' + translate('BG') + ':</strong> ' + treatment.glucose + (treatment.glucoseType ? ' (' + translate(treatment.glucoseType) + ')' : '') + '<br/>' : '') +
        (treatment.enteredBy ? '<strong>' + translate('Entered by') + ':</strong> ' + treatment.enteredBy + '<br/>' : '') +
        (treatment.notes ? '<strong>' + translate('Notes') + ':</strong> ' + treatment.notes : '')
      )
      .style('left', (d3.event.pageX) + 'px')
      .style('top', (d3.event.pageY + 15) + 'px');
    }

    var treatmentDots = chart().focus.selectAll('treatment-dot')
      .data(arc.data)
      .enter()
      .append('g')
      .attr('transform', 'translate(' + chart().xScale(new Date(treatment.mills)) + ', ' + chart().yScale(client.sbx.scaleEntry(treatment)) + ')')
      .on('mouseover', treatmentTooltip)
      .on('mouseout', hideTooltip);

    treatmentDots.append('path')
      .attr('class', 'path')
      .attr('fill', function (d) {
        return d.outlineOnly ? 'transparent' : d.color;
      })
      .attr('stroke-width', function (d) {
        return d.outlineOnly ? 1 : 0;
      })
      .attr('stroke', function (d) {
        return d.color;
      })
      .attr('id', function (d, i) {
        return 's' + i;
      })
      .attr('d', arc.svg);

    return treatmentDots;
  }

  function appendLabels(treatmentDots, arc, opts) {
    // labels for carbs and insulin
    if (opts.showLabels) {
      var label = treatmentDots.append('g')
        .attr('class', 'path')
        .attr('id', 'label')
        .style('fill', 'white');

      label.append('text')
        .style('font-size', 40 / opts.scale)
        .style('text-shadow', '0px 0px 10px rgba(0, 0, 0, 1)')
        .attr('text-anchor', 'middle')
        .attr('dy', '.35em')
        .attr('transform', function (d) {
          d.outerRadius = d.outerRadius * 2.1;
          d.innerRadius = d.outerRadius * 2.1;
          return 'translate(' + arc.svg.centroid(d) + ')';
        })
        .text(function (d) {
          return d.element;
        });
    }
  }

  renderer.drawTreatment = function drawTreatment(treatment, opts) {
    if (!treatment.carbs && !treatment.insulin) {
      return;
    }

    //when the tests are run window isn't available
    var innerWidth = window && window.innerWidth || -1;
    // don't render the treatment if it's not visible
    if (Math.abs(chart().xScale(new Date(treatment.mills))) > innerWidth) {
      return;
    }

    var radius = calcTreatmentRadius(treatment, opts);
    if (radius.isNaN) {
      console.warn('Bad Data: Found isNaN value in treatment', treatment);
      return;
    }

    var arc = prepareArc(treatment, radius);
    var treatmentDots = appendTreatments(treatment, arc);
    appendLabels(treatmentDots, arc, opts);
  };

  return renderer;
}

module.exports = init;
