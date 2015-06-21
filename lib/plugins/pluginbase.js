'use strict';

var _ = require('lodash');

function init (majorPills, minorPills, tooltip) {

  function pluginBase ( ) {
    return pluginBase;
  }

  function findOrCreatePill (plugin, label) {
    var container = plugin.pluginType == 'pill-major' ? majorPills : minorPills;
    var pillName = "span.pill." + plugin.name;
    var pill = container.find(pillName);

    if (!pill || pill.length == 0) {
      pill = $('<span class="pill ' + plugin.name + '">');
      var pillLabel = $('<label>' + label + '</label>');
      var pillValue = $('<em></em>');
      if (plugin.pillFlip) {
        pill.append(pillValue);
        pill.append(pillLabel);
      } else {
        pill.append(pillLabel);
        pill.append(pillValue);
      }

      container.append(pill);
    }

    return pill;
  }

  pluginBase.updatePillText = function updatePillText (plugin, updatedText, label, info) {

    var pill = findOrCreatePill(plugin, label);

    pill.find('em').toggle(updatedText != null).text(updatedText);

    if (info) {
      var html = _.map(info, function mapInfo (i) {
        return '<strong>' + i.label + '</strong> ' + i.value;
      }).join('<br/>\n');

      pill.mouseover(function pillMouseover (event) {
        tooltip.transition().duration(200).style('opacity', .9);
        tooltip.html(html)
          .style('left', (event.pageX) + 'px')
          .style('top', (event.pageY + 15) + 'px');
      });

      pill.mouseout(function pillMouseout ( ) {
        tooltip.transition()
          .duration(200)
          .style('opacity', 0);
      });
    }
  };

  return pluginBase();
}

module.exports = init;
