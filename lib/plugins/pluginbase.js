'use strict';

var toTextContent = require('../utils/html').toTextContent;

var TOOLTIP_WIDTH = 275;  //min-width + padding

function renderTooltipInfo (tooltipNode, info) {
  while (tooltipNode.firstChild) {
    tooltipNode.removeChild(tooltipNode.firstChild);
  }

  info.forEach(function appendInfo (item, index) {
    if (index > 0) {
      tooltipNode.appendChild(tooltipNode.ownerDocument.createElement('br'));
    }

    var label = tooltipNode.ownerDocument.createElement('strong');
    label.textContent = toTextContent(item.label);
    tooltipNode.appendChild(label);
    tooltipNode.appendChild(tooltipNode.ownerDocument.createTextNode(' ' + toTextContent(item.value)));
  });
}

function init (majorPills, minorPills, statusPills, bgStatus, tooltip) {

  var pluginBase = { };

  pluginBase.forecastInfos = [];
  pluginBase.forecastPoints = {};

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

    if (options.directText) {
      pill.text(toTextContent(options.label));
    } else {
      pill.find('label').attr('class', options.labelClass).text(toTextContent(options.label));
      pill.find('em')
        .attr('class', options.valueClass)
        .toggle(options.value != null)
        .text(toTextContent(options.value))
      ;
    }

    if (options.info  && options.info.length) {
      pill.mouseover(function pillMouseover (event) {
        tooltip.style('display', 'block');

        var windowWidth = $(tooltip.node()).parent().parent().width();
        var left = event.pageX + TOOLTIP_WIDTH < windowWidth ? event.pageX : windowWidth - TOOLTIP_WIDTH - 10;
        renderTooltipInfo(tooltip.node(), options.info);
        tooltip.style('left', left + 'px')
          .style('top', (event.pageY + 15) + 'px');
      });

      pill.mouseout(function pillMouseout ( ) {
        tooltip.style('display', 'none');
      });
    } else {
      pill.off('mouseover');
    }
  };
  pluginBase.addForecastPoints = function addForecastPoints (points, info) {
    points.forEach(function eachPoint (point) {
      point.type = 'forecast';
      point.info = info;
      if (point.mgdl < 13) {
        point.color = 'transparent';
      }
    });

    pluginBase.forecastInfos.push(info);
    pluginBase.forecastPoints[info.type] = points;
  };

  return pluginBase;
}

module.exports = init;
