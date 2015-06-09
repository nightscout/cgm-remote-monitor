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

  pluginBase.roundInsulinForDisplayFormat = function roundInsulinForDisplayFormat (iob, sbx) {

    if (iob == 0) return 0;

    if (sbx.properties.roundingStyle == 'medtronic') {
      var denominator = 0.1;
      var digits = 1;
      if (iob > 0.5 && iob < 1) {
        denominator = 0.05;
        digits = 2;
      }
      if (iob <= 0.5) {
        denominator = 0.025;
        digits = 3;
      }
      return (Math.floor(iob / denominator) * denominator).toFixed(digits);
    }

    return (Math.floor(iob / 0.01) * 0.01).toFixed(2);

  };

  pluginBase.getBGUnits = function getBGUnits (sbx) {
    if (sbx.units == 'mmol') return 'mmol/L';
    return "mg/dl";
  };

  pluginBase.roundBGToDisplayFormat = function roundBGToDisplayFormat (bg, sbx) {
    if (sbx.units == 'mmol') {
      return Math.round(bg * 10) / 10;
    }
    return Math.round(bg);
  };

  pluginBase.scaleBg = function scaleBg (bg, sbx) {
    if (sbx.units == 'mmol') {
      return Nightscout.units.mgdlToMMOL(bg);
    } else {
      return bg;
    }
  };

  return pluginBase();
}

module.exports = init;
