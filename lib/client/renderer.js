'use strict';

var _ = require('lodash');
var times = require('../times');

var DEFAULT_FOCUS = times.hours(3).msecs
  , WIDTH_SMALL_DOTS = 420
  , WIDTH_BIG_DOTS = 800
  , TOOLTIP_TRANS_MS = 200 // milliseconds
  , TOOLTIP_WIDTH = 150 //min-width + padding
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

  function tooltipLeft ( ) {
    var windowWidth = $(client.tooltip).parent().parent().width();
    var left = d3.event.pageX + TOOLTIP_WIDTH < windowWidth ? d3.event.pageX : windowWidth - TOOLTIP_WIDTH - 10;
    return left + 'px';
  }

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

  renderer.addFocusCircles = function addFocusCircles ( ) {
    // get slice of data so that concatenation of predictions do not interfere with subsequent updates
    var focusData = client.entries.slice();

    if (client.sbx.pluginBase.forecastPoints) {
      var shownForecastPoints = _.filter(client.sbx.pluginBase.forecastPoints, function isShown(point) {
        return client.settings.showForecast.indexOf(point.info.type) > -1;
      });
      var maxForecastMills = _.max(_.map(shownForecastPoints, function (point) {return point.mills}));
      client.forecastTime = maxForecastMills > 0 ? maxForecastMills - client.sbx.lastSGVMills() : 0;
      focusData = focusData.concat(shownForecastPoints);
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
          return d.noFade ? 100 : chart().futureOpacity(d.mills - client.latestSGV.mills);
        })
        .attr('stroke-width', function (d) {
          return d.type === 'mbg' ? 2 : d.type === 'forecast' ? 1 : 0;
        })
        .attr('stroke', function (d) {
          return (d.type === 'mbg' ? 'white' : d.color);
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

      function getRawbgInfo ( ) {
        var info = { };
        if (d.type === 'sgv') {
          info.noise = client.rawbg.noiseCodeToDisplay(d.mgdl, d.noise);
          if (client.rawbg.showRawBGs(d.mgdl, d.noise, client.ddata.cal, client.sbx)) {
            info.value = utils.scaleMgdl(client.rawbg.calc(d, client.ddata.cal, client.sbx));
          }
        }
        return info;
      }

      var rawbgInfo = getRawbgInfo();

      client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
      client.tooltip.html('<strong>' + translate('BG')+ ':</strong> ' + client.sbx.scaleEntry( d ) +
        (d.type === 'mbg' ? '<br/><strong>' + translate('Device') + ': </strong>' + d.device : '') +
        (rawbgInfo.value ? '<br/><strong>' + translate('Raw BG') + ':</strong> ' + rawbgInfo.value : '') +
        (rawbgInfo.noise ? '<br/><strong>' + translate('Noise') + ':</strong> ' + rawbgInfo.noise : '') +
        '<br/><strong>' + translate('Time') + ':</strong> ' + client.formatTime(new Date(d.mills)))
        .style('left', tooltipLeft())
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
        (d.eventType ? '<strong>'+translate('Treatment type')+':</strong> ' + translate(client.careportal.resolveEventName(d.eventType)) + '<br/>' : '') +
        (d.reason ? '<strong>'+translate('Reason')+':</strong> ' + translate(d.reason) + '<br/>' : '') +
        (d.glucose ? '<strong>'+translate('BG')+':</strong> ' + d.glucose + (d.glucoseType ? ' (' + translate(d.glucoseType) + ')': '') + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered By')+':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.targetTop ? '<strong>'+translate('Target Top')+':</strong> ' + d.targetTop + '<br/>' : '') +
        (d.targetBottom ? '<strong>'+translate('Target Bottom')+':</strong> ' + d.targetBottom + '<br/>' : '') +
        (d.duration ? '<strong>'+translate('Duration')+':</strong> ' + Math.round(d.duration) + ' min<br/>' : '') +
        (d.notes ? '<strong>'+translate('Notes')+':</strong> ' + d.notes : '');
    }

    function announcementTooltip (d) {
      return '<strong>'+translate('Time')+':</strong> ' + client.formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Announcement')+'</strong><br/>' : '') +
        (d.notes && d.notes.length > 1 ? '<strong>'+translate('Message')+':</strong> ' + d.notes + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered By')+':</strong> ' + d.enteredBy + '<br/>' : '');
    }

    //TODO: filter in oref0 instead of here and after most people upgrade take this out
    var openAPSSpam = ['BasalProfileStart', 'ResultDailyTotal', 'BGReceived'];

    //NOTE: treatments with insulin or carbs are drawn by drawTreatment()
    // bind up the focus chart data to an array of circles
    var treatCircles = chart().focus.selectAll('treatment-dot').data(client.ddata.treatments.filter(function(treatment) {

      var notCarbsOrInsulin = !treatment.carbs && !treatment.insulin;
      var notTempOrProfile = ! _.includes(['Temp Basal', 'Profile Switch', 'Combo Bolus', 'Temporary Target'], treatment.eventType);

      var notes = treatment.notes || '';
      var enteredBy = treatment.enteredBy || '';

      var notOpenAPSSpam = enteredBy.indexOf('openaps://') === -1 || _.isUndefined(_.find(openAPSSpam, function startsWith (spam) {
        return notes.indexOf(spam) === 0;
      }));

      return notCarbsOrInsulin && !treatment.duration && notTempOrProfile && notOpenAPSSpam;
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
          .style('left', tooltipLeft())
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    treatCircles.attr('clip-path', 'url(#clip)');

    var durationTreatments = client.ddata.treatments.filter(function(treatment) {
      return !treatment.carbs && !treatment.insulin && treatment.duration &&
        ! _.includes(['Temp Basal', 'Profile Switch', 'Combo Bolus', 'Temporary Target'], treatment.eventType);
    });

    //use the processed temp target so there are no overlaps
    durationTreatments = durationTreatments.concat(client.ddata.tempTargetTreatments);

    // treatments with duration
    var treatRects = chart().focus.selectAll('.g-duration').data(durationTreatments);

    function fillColor(d) {
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
      return 'translate(' + chart().xScale(new Date(d.mills)) + ',' + chart().yScale(utils.scaleMgdl(top)) + ')';
    }
    // if already existing then transition each rect to its new position
    treatRects.transition()
      .attr('transform', rectTranslate);

    chart().focus.selectAll('.g-duration-rect').transition()
      .attr('width', function (d) {
        return chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(new Date(d.mills));
      });

    chart().focus.selectAll('.g-duration-text').transition()
      .attr('transform', function (d) {
        return 'translate(' + (chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(new Date(d.mills)))/2 + ',' + 10 + ')';
      });

    // if new rect then just display
    var gs = treatRects.enter().append('g')
      .attr('class','g-duration')
      .attr('transform', rectTranslate)
      .on('mouseover', function (d) {
        client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
        client.tooltip.html(d.isAnnouncement ? announcementTooltip(d) : treatmentTooltip(d))
          .style('left', tooltipLeft())
          .style('top', (d3.event.pageY + 15) + 'px');
      })
      .on('mouseout', hideTooltip);

    gs.append('rect')
      .attr('class', 'g-duration-rect')
      .attr('width', function (d) {
        return chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(new Date(d.mills));
      })
      .attr('height', rectHeight)
      .attr('rx', 5)
      .attr('ry', 5)
      .attr('opacity', .2)
      .attr('fill', fillColor);

    gs.append('text')
      .attr('class', 'g-duration-text')
      .style('font-size', 15)
      .attr('fill', 'white')
      .attr('text-anchor', 'middle')
      .attr('dy', '.35em')
      .attr('transform', function (d) {
        return 'translate(' + (chart().xScale(new Date(d.mills + times.mins(d.duration).msecs)) - chart().xScale(new Date(d.mills)))/2 + ',' + 10 + ')';
      })
      .text(function (d) {
        if (d.eventType === 'Temporary Target') {
          return '';
        }
        return d.notes || d.eventType;
      });

    
    treatRects.attr('clip-path', 'url(#clip)');
  };

  renderer.addContextCircles = function addContextCircles ( ) {
    // bind up the context chart data to an array of circles
    var contextCircles = chart().context.selectAll('circle').data(client.entries);

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
      , R4 = R2 + 25 / opts.scale
      ;

    return {
      R1: R1
      , R2: R2
      , R3: R3
      , R4: R4
      , isNaN: isNaN(R1) || isNaN(R3) || isNaN(R3)
    };
  }

  function prepareArc(treatment, radius) {
    var arc_data = [
      { 'element': '', 'color': 'white', 'start': -1.5708, 'end': 1.5708, 'inner': 0, 'outer': radius.R1 },
      { 'element': '', 'color': 'transparent', 'start': -1.5708, 'end': 1.5708, 'inner': radius.R2, 'outer': radius.R3 },
      { 'element': '', 'color': '#0099ff', 'start': 1.5708, 'end': 4.7124, 'inner': 0, 'outer': radius.R1 },
      { 'element': '', 'color': 'transparent', 'start': 1.5708, 'end': 4.7124, 'inner': radius.R2, 'outer': radius.R3 },
      { 'element': '', 'color': 'transparent', 'start': 1.5708, 'end': 4.7124, 'inner': radius.R2, 'outer': radius.R4 }
    ];

    arc_data[0].outlineOnly = !treatment.carbs;
    arc_data[2].outlineOnly = !treatment.insulin;

    if (treatment.carbs > 0) {
      arc_data[1].element = Math.round(treatment.carbs) + ' g';
    }

    if (treatment.insulin > 0) {
      arc_data[3].element = Math.round(treatment.insulin * 100) / 100 + ' U';
    }

    if (treatment.status) {
      arc_data[4].element = translate(treatment.status);
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

  function isInRect(x,y,rect) {
    return !(x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height);
  }
  
  function appendTreatments(treatment, arc) {
    
    function boluscalcTooltip (treatment) {
      if (!treatment.boluscalc) {
        return '';
      }
      var html = '<hr>';
      html += (treatment.boluscalc.othercorrection ? '<strong>'+translate('Other correction')+':</strong> ' + parseFloat(treatment.boluscalc.othercorrection).toFixed(2) + 'U<br/>' : '');
      html += (treatment.boluscalc.profile ? '<strong>'+translate('Profile used')+':</strong> ' + treatment.boluscalc.profile + '<br/>' : '');
      if (treatment.boluscalc.foods && treatment.boluscalc.foods.length) {
        html += '<table><tr><td><strong>' + translate('Food') + '</strong></td></tr>';
        for (var fi=0; fi<treatment.boluscalc.foods.length; fi++) {
          var f = treatment.boluscalc.foods[fi];
          html += '<tr>';
          html += '<td>'+ f.name + '</td>';
          html += '<td>'+ (f.portion*f.portions).toFixed(1) + ' ' + f.unit + '</td>';
          html += '<td>('+ (f.carbs*f.portions).toFixed(1) + ' g)</td>';
          html += '</tr>';
        }
        html += '</table>';
      }
      return html;
    }
    
    function treatmentTooltip() {
      client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
      client.tooltip.html('<strong>' + translate('Time') + ':</strong> ' + client.formatTime(new Date(treatment.mills)) + '<br/>' + '<strong>' + translate('Treatment type') + ':</strong> ' + translate(client.careportal.resolveEventName(treatment.eventType)) + '<br/>' +
        (treatment.carbs ? '<strong>' + translate('Carbs') + ':</strong> ' + treatment.carbs + '<br/>' : '') +
        (treatment.insulin ? '<strong>' + translate('Insulin') + ':</strong> ' + treatment.insulin + '<br/>' : '') +
        (treatment.enteredinsulin ? '<strong>' + translate('Combo Bolus') + ':</strong> ' + treatment.enteredinsulin + 'U, ' + treatment.splitNow + '% : ' + treatment.splitExt + '%, ' + translate('Duration') + ': ' + treatment.duration + '<br/>' : '') +
        (treatment.glucose ? '<strong>' + translate('BG') + ':</strong> ' + treatment.glucose + (treatment.glucoseType ? ' (' + translate(treatment.glucoseType) + ')' : '') + '<br/>' : '') +
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
    renderer.drag = d3.behavior.drag()  
      .on('dragstart', function() { 
        //console.log(treatment); 
        var windowWidth = $(client.tooltip).parent().parent().width();
        var left = d3.event.x + TOOLTIP_WIDTH < windowWidth ? d3.event.x : windowWidth - TOOLTIP_WIDTH - 10;
        client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9)
          .style('left', left + 'px')
          .style('top', (d3.event.pageY ? d3.event.pageY + 15 : 40)  + 'px');

        deleteRect = {
          x: 0,
          y: 0,
          width: 50,
          height: chart().yScale(chart().yScale.domain()[0])
        };
        chart().drag.append('rect')
          .attr({
            class:'drag-droparea',
            x: deleteRect.x,
            y: deleteRect.y,
            width: deleteRect.width,
            height: deleteRect.height,
            fill: 'red',
            opacity: 0.4,
            rx: 10,
            ry: 10
          });
        chart().drag.append('text')
          .attr({
            class:'drag-droparea',
            x: deleteRect.x + deleteRect.width / 2,
            y: deleteRect.y + deleteRect.height / 2,
            'font-size': 15,
            'font-weight': 'bold',
            fill: 'red',
            'text-anchor': 'middle',
            dy: '.35em',
            transform: 'rotate(-90 ' + (deleteRect.x + deleteRect.width / 2) + ',' + (deleteRect.y + deleteRect.height / 2) + ')'
          })
          .text(translate('Remove'));

        if (treatment.insulin && treatment.carbs) {
          carbsRect = {
            x: 0,
            y: 0,
            width: chart().charts.attr('width'),
            height: 50
          };
          insulinRect = {
            x: 0,
            y: chart().yScale(chart().yScale.domain()[0]) - 50,
            width: chart().charts.attr('width'),
            height: 50
          };
          chart().drag.append('rect')
            .attr({
              class:'drag-droparea',
              x: carbsRect.x,
              y: carbsRect.y,
              width: carbsRect.width,
              height: carbsRect.height,
              fill: 'white',
              opacity: 0.4,
              rx: 10,
              ry: 10
            });
          chart().drag.append('text')
            .attr({
              class:'drag-droparea',
              x: carbsRect.x + carbsRect.width / 2,
              y: carbsRect.y + carbsRect.height / 2,
              'font-size': 15,
              'font-weight': 'bold',
              fill: 'white',
              'text-anchor': 'middle',
              dy: '.35em'
            })
            .text(translate('Move carbs'));
          chart().drag.append('rect')
            .attr({
              class:'drag-droparea',
              x: insulinRect.x,
              y: insulinRect.y,
              width: insulinRect.width,
              height: insulinRect.height,
              fill: '#0099ff',
              opacity: 0.4,
              rx: 10,
              ry: 10
            });
          chart().drag.append('text')
            .attr({
              class:'drag-droparea',
              x: insulinRect.x + insulinRect.width / 2,
              y: insulinRect.y + insulinRect.height / 2,
              'font-size': 15,
              'font-weight': 'bold',
              fill: '#0099ff',
              'text-anchor': 'middle',
              dy: '.35em'
            })
            .text(translate('Move insulin'));
        }
          
        chart().basals.attr('display','none');
          
        operation = 'Move';
      })
      .on('drag', function() { 
        //console.log(d3.event);
        client.tooltip.transition().style('opacity', .9);
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
          '<b>' + translate('Operation') + ':</b> ' + translate(operation) + '<br>' 
          + '<b>' + translate('New time') + ':</b> ' + newTime.toLocaleTimeString() + '<br>' 
          + '<b>' + translate('Difference') + ':</b> ' +  (minDiff > 0 ? '+' : '') + minDiff + ' ' + translate('mins')
          );

        chart().drag.selectAll('.arrow').remove();
        chart().drag.append('line')
          .attr({
            'class':'arrow',
            'marker-end':'url(#arrow)',
            'x1': chart().xScale(new Date(treatment.mills)),
            'y1': chart().yScale(client.sbx.scaleEntry(treatment)),
            'x2': x,
            'y2': y,
            'stroke-width': 2,
            'stroke': 'white'
          });
          
      })
      .on('dragend', function() { 
        var newTreatment;
        chart().drag.selectAll('.drag-droparea').remove();
        hideTooltip();
        switch (operation) {
          case 'Move':
            if (window.confirm(translate('Change treatment time to %1 ?', { params: [newTime.toLocaleTimeString()] } ))) {
              client.socket.emit(
                'dbUpdate', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id,
                  data: { created_at: newTime.toISOString() } 
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove insulin':
            if (window.confirm(translate('Remove insulin from treatment ?'))) {
              client.socket.emit(
                'dbUpdateUnset', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id,
                  data: { insulin: 1 } 
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove carbs':
            if (window.confirm(translate('Remove carbs from treatment ?'))) {
              client.socket.emit(
                'dbUpdateUnset', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id,
                  data: { carbs: 1 } 
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Remove':
            if (window.confirm(translate('Remove treatment ?'))) {
              client.socket.emit(
                'dbRemove', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Move insulin':
            if (window.confirm(translate('Change insulin time to %1 ?', { params: [newTime.toLocaleTimeString()] } ))) {
              client.socket.emit(
                'dbUpdateUnset', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id,
                  data: { insulin: 1 } 
                }
              );
              newTreatment = _.cloneDeep(treatment);
              delete newTreatment._id;
              delete newTreatment.NSCLIENT_ID;
              delete newTreatment.carbs;
              newTreatment.created_at = newTime.toISOString();
              client.socket.emit(
                'dbAdd', 
                { 
                  collection: 'treatments', 
                  data: newTreatment 
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
          case 'Move carbs':
            if (window.confirm(translate('Change carbs time to %1 ?', { params: [newTime.toLocaleTimeString()] } ))) {
              client.socket.emit(
                'dbUpdateUnset', 
                { 
                  collection: 'treatments', 
                  _id: treatment._id,
                  data: { carbs: 1 } 
                }
              );
              newTreatment = _.cloneDeep(treatment);
              delete newTreatment._id;
              delete newTreatment.NSCLIENT_ID;
              delete newTreatment.insulin;
              newTreatment.created_at = newTime.toISOString();
              client.socket.emit(
                'dbAdd', 
                { 
                  collection: 'treatments', 
                  data: newTreatment 
                },
                function callback(result) { 
                  console.log(result); 
                  chart().drag.selectAll('.arrow').transition().duration(5000).style('opacity', 0).remove();
                }
              );
            } else {
              chart().drag.selectAll('.arrow').remove();
            }
            break;
        }
        chart().basals.attr('display','');
      });

    var treatmentDots = chart().focus.selectAll('treatment-insulincarbs')
      .data(arc.data)
      .enter()
      .append('g')
      .attr('class', 'draggable-treatment')
      .attr('transform', 'translate(' + chart().xScale(new Date(treatment.mills)) + ', ' + chart().yScale(client.sbx.scaleEntry(treatment)) + ')')
      .on('mouseover', treatmentTooltip)
      .on('mouseout', hideTooltip);
    if (client.editMode) {
      treatmentDots
        .style('cursor', 'move')
        .call(renderer.drag);
    }

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

  renderer.drawTreatments = function drawTreatments(client) {
    // add treatment bubbles
    _.forEach(client.ddata.treatments, function eachTreatment (d) {
      renderer.drawTreatment(d, {
        scale: renderer.bubbleScale()
        , showLabels: true
      });
    });
  };
  
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

  renderer.addBasals = function addBasals (client) {

    var mode = client.settings.extendedSettings.basal.render;
    var profile = client.sbx.data.profile;
    var linedata = [];
    var notemplinedata = [];
    var basalareadata = [];
    var tempbasalareadata = [];
    var comboareadata = [];
    var from = chart().brush.extent()[0].getTime();
    var to = Math.max(chart().brush.extent()[1].getTime(), client.sbx.time) + client.forecastTime;
    
    var date = from;
    var lastbasal = 0;
    
    if (!profile.activeProfileToTime(from)) {
      window.alert(translate('Wrong profile setting.\nNo profile defined to displayed time.\nRedirecting to profile editor to create new profile.'));
      window.location.href = '/profile';
      return;
    }

    while (date <= to) {
      var basalvalue = profile.getTempBasal(date);
      if (!_.isEqual(lastbasal, basalvalue)) {
        linedata.push( { d: date, b: basalvalue.totalbasal } );
        notemplinedata.push( { d: date, b: basalvalue.basal } );
        if (basalvalue.combobolustreatment && basalvalue.combobolustreatment.relative) {
          tempbasalareadata.push( { d: date, b: basalvalue.tempbasal } );
          basalareadata.push( { d: date, b: 0 } );
          comboareadata.push( { d: date, b: basalvalue.totalbasal } );
        } else if (basalvalue.treatment) {
          tempbasalareadata.push( { d: date, b: basalvalue.totalbasal } );
          basalareadata.push( { d: date, b: 0 } );
          comboareadata.push( { d: date, b: 0 } );
        } else {
          tempbasalareadata.push( { d: date, b: 0 } );
          basalareadata.push( { d: date, b: basalvalue.totalbasal } );
          comboareadata.push( { d: date, b: 0 } );
        }
      }
      lastbasal = basalvalue;
      date += times.mins(1).msecs;
    }

    var toTempBasal = profile.getTempBasal(to);

    linedata.push( { d: to, b: toTempBasal.totalbasal } );
    notemplinedata.push( { d: to, b: toTempBasal.basal } );
    basalareadata.push( { d: to, b: toTempBasal.basal } );
    tempbasalareadata.push( { d: to, b: toTempBasal.totalbasal } );
    comboareadata.push( { d: to, b: toTempBasal.totalbasal } );

    var max_linedata = d3.max(linedata, function (d) { return d.b; });
    var max_notemplinedata = d3.max(notemplinedata, function (d) { return d.b; });
    var max = Math.max(max_linedata, max_notemplinedata) * ('icicle' === mode ? 1 : 1.1 );
    chart().maxBasalValue = max;
    chart().yScaleBasals.domain('icicle' === mode ? [0, max] : [max, 0]);

    chart().basals.selectAll('g').remove();
    chart().basals.selectAll('.basalline').remove().data(linedata);
    chart().basals.selectAll('.notempline').remove().data(notemplinedata);
    chart().basals.selectAll('.basalarea').remove().data(basalareadata);
    chart().basals.selectAll('.tempbasalarea').remove().data(tempbasalareadata);
    chart().basals.selectAll('.comboarea').remove().data(comboareadata);

    var valueline = d3.svg.line()
      .interpolate('step-after')
      .x(function(d) { return chart().xScaleBasals(d.d); })
      .y(function(d) { return chart().yScaleBasals(d.b); });

    var area = d3.svg.area()
      .interpolate('step-after')
      .x(function(d) { return chart().xScaleBasals(d.d); })
      .y0(chart().yScaleBasals(0))
      .y1(function(d) { return chart().yScaleBasals(d.b); });
      
    var g = chart().basals.append('g');

    g.append('path')
      .attr('class', 'line basalline')
      .attr('stroke', '#0099ff')
      .attr('stroke-width', 1)
      .attr('fill', 'none')
      .attr('d', valueline(linedata))
      .attr('clip-path', 'url(#clip)');

    g.append('path')
      .attr('class', 'line notempline')
      .attr('stroke', '#0099ff')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', ('3, 3'))
      .attr('fill', 'none')
      .attr('d', valueline(notemplinedata))
      .attr('clip-path', 'url(#clip)');

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
          .attr('x', chart().xScaleBasals((Math.max(t.mills, from) + Math.min(t.mills + times.mins(t.duration).msecs, to))/2))
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
      return '<strong>'+translate('Time')+':</strong> ' + client.formatTime(new Date(d.mills)) + '<br/>' +
        (d.eventType ? '<strong>'+translate('Treatment type')+':</strong> ' + translate(client.careportal.resolveEventName(d.eventType)) + '<br/>' : '') +
        (d.endprofile ? '<strong>'+translate('End of profile')+':</strong> ' + d.endprofile + '<br/>' : '') +
        (d.profile ? '<strong>'+translate('Profile')+':</strong> ' + d.profile + '<br/>' : '') +
        (d.duration ? '<strong>'+translate('Duration')+':</strong> ' + d.duration + translate('mins') + '<br/>' : '') +
        (d.enteredBy ? '<strong>'+translate('Entered By')+':</strong> ' + d.enteredBy + '<br/>' : '') +
        (d.notes ? '<strong>'+translate('Notes')+':</strong> ' + d.notes : '');
    }

    // calculate position of profile on left side
    var from = chart().brush.extent()[0].getTime();
    var to = chart().brush.extent()[1].getTime();
    var mult = (to-from) / times.hours(24).msecs;
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

    var generateText = function (t) {
        var sign = t.first ? '▲▲▲' : '▬▬▬';
        var ret;
        if (t.cutting) {
            ret = sign + '    ' + t.cutting + '    ' + '►►►' + '    ' + t.profile + '    ' + sign;
        } else  {
            ret = sign + '    ' + t.profile + '    ' + sign;
        }
        return ret;
    };

    treatProfiles.transition().duration(0)
      .attr('transform', function (t) {
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
      .attr('transform', function (t) {
        return 'rotate(-90 ' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ') ' +
          'translate(' + chart().xScale(t.mills) + ',' + chart().yScaleBasals(topOfText) + ')';
      })
      .text(generateText)
      .on('mouseover', function (d) {
        client.tooltip.transition().duration(TOOLTIP_TRANS_MS).style('opacity', .9);
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
