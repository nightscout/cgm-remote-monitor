'use strict';

var _ = require('lodash');

function init (majorPills, minorPills, tooltip) {

  function pluginBase ( ) {
    return pluginBase;
  }

  pluginBase.updatePillText = function updatePillText (plugin, updatedText, label, info) {

    var pillName = "span.pill." + plugin.name;

    var container = plugin.pluginType == 'pill-major' ? majorPills : minorPills;

    var pill = container.find(pillName);

    if (!pill || pill.length == 0) {
      pill = $('<span class="pill ' + plugin.name + '"><label>' + label + '</label><em></em></span>');
      container.append(pill);
    }

    pill.find('em').text(updatedText);

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
