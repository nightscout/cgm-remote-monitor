'use strict';

var _map = require('lodash/map');
var _each = require('lodash/each');

var TOOLTIP_WIDTH = 275;  //min-width + padding

function init (majorPills, minorPills, statusPills, bgStatus, tooltip) {

  var pluginBase = { };

  pluginBase.forecastInfos = [];
  pluginBase.forecastPoints = [];

  function findOrCreatePill (plugin) {
    var container = null;

    if (plugin.pluginType === 'pill-major') {
      container = majorPills;
    } else if (plugin.pluginType === 'pill-status') {
      container = statusPills;
    } else if (plugin.pluginType === 'bg-status') {
      container = bgStatus;
    } else {
      container = minorPills;
    }

    var pillName = 'span.pill.' + plugin.name;
    var pill = container.find(pillName);

    var classes = 'pill ' + plugin.name;

    if (!pill || pill.length === 0) {
      pill = $('<span class="' + classes + '">');
      var pillLabel = $('<label></label>');
      var pillValue = $('<em></em>');
      if (plugin.pillFlip) {
        pill.append(pillValue);
        pill.append(pillLabel);
      } else {
        pill.append(pillLabel);
        pill.append(pillValue);
      }

      container.append(pill);
    } else {
      //reset in case a pill class was added and needs to be removed
      pill.attr('class', classes);
    }

    return pill;
  }

  pluginBase.updatePillText = function updatePillText (plugin, options) {

    var pill = findOrCreatePill(plugin);

    if (options.hide) {
      pill.addClass('hidden');
    } else {
      pill.removeClass('hidden');
    }

    pill.addClass(options.pillClass);

    if (options.directHTML) {
      pill.html(options.label);
    } else {
      if (options.directText) {
        pill.text(options.label);
      } else {
        pill.find('label').attr('class', options.labelClass).text(options.label);
        pill.find('em')
          .attr('class', options.valueClass)
          .toggle(options.value != null)
          .text(options.value)
        ;
      }
    }

    if (options.info  && options.info.length) {
      var html = _map(options.info, function mapInfo (i) {
        return '<strong>' + i.label + '</strong> ' + i.value;
      }).join('<br/>\n');

      pill.mouseover(function pillMouseover (event) {
        tooltip.transition().duration(200).style('opacity', .9);

        var windowWidth = $(tooltip).parent().parent().width();
        var left = event.pageX + TOOLTIP_WIDTH < windowWidth ? event.pageX : windowWidth - TOOLTIP_WIDTH - 10;
        tooltip.html(html)
          .style('left', left + 'px')
          .style('top', (event.pageY + 15) + 'px');
      });

      pill.mouseout(function pillMouseout ( ) {
        tooltip.transition()
          .duration(200)
          .style('opacity', 0);
      });
    } else {
      pill.off('mouseover');
    }
  };

  pluginBase.addForecastPoints = function addForecastPoints (points, info) {
    _each(points, function eachPoint (point) {
      point.type = 'forecast';
      point.info = info;
      if (point.mgdl < 13) {
        point.color = 'transparent';
      }
    });

    pluginBase.forecastInfos.push(info);
    pluginBase.forecastPoints = pluginBase.forecastPoints.concat(points);
  };

  return pluginBase;
}

module.exports = init;
