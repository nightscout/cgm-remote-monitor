'use strict';

var _ = require('lodash');

function setEnv(env) {
  this.profile = env.profile;
  this.majorPills = env.majorPills;
  this.minorPills = env.minorPills;
  this.iob = env.iob;

  // TODO: clean!
  this.env = env;
}

function updatePillText(updatedText, label, info, major) {

  var self = this;

  var pillName = "span.pill." + this.name;

  var container = this.pluginType == 'major-pill' ? this.majorPills : this.minorPills;

  var pill = container.find(pillName);

  if (!pill || pill.length == 0) {
    pill = $('<span class="pill '+ this.name+ '"><label>'+ label + '</label><em></em></span>');
    container.append(pill);
  }

  pill.find('em').text(updatedText);

  if (info) {

    var html = _.map(info, function mapInfo(i) {
      return '<strong>' + i.label + '</strong> ' + i.value;
    }).join('<br/>\n');

    pill.mouseover(function pillMouseover(event) {
      self.env.tooltip.transition().duration(200).style('opacity', .9);
      self.env.tooltip.html(html)
        .style('left', (event.pageX) + 'px')
        .style('top', (event.pageY + 15) + 'px');
    });

    pill.mouseout(function pillMouseout() {
      self.env.tooltip.transition()
        .duration(200)
        .style('opacity', 0);
    });
  }
}

function scaleBg(bg) {
  if (browserSettings.units == 'mmol') {
    return Nightscout.units.mgdlToMMOL(bg);
  } else {
    return bg;
  }
}

function PluginBase() {
  return {
    setEnv: setEnv,
    scaleBg: scaleBg,
    updatePillText: updatePillText
  };
}

module.exports = PluginBase;
