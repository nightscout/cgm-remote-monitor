'use strict';

var _ = require('lodash');

function init(ctx) {
  var consts = {
        SCALE_LINEAR: 0
      , SCALE_LOG: 1
      , ORDER_OLDESTONTOP: 0
      , ORDER_NEWESTONTOP: 1
      }
    , allPlugins = [
        require('./daytoday')(ctx)
      , require('./weektoweek')(ctx)
      , require('./dailystats')(ctx)
      , require('./glucosedistribution')(ctx)
      , require('./hourlystats')(ctx)
      , require('./percentile')(ctx)
      , require('./success')(ctx)
      , require('./calibrations')(ctx)
      , require('./treatments')(ctx)
      , require('./profiles')(ctx)
      , require('./loopalyzer')(ctx)
    ];

  consts.scaleYFromSettings = function scaleYFromSettings (client) {
    return client.settings.scaleY === 'linear' ? consts.SCALE_LINEAR : consts.SCALE_LOG;
  };

  function plugins(name) {
    if (name) {
      return _.find(allPlugins, {name: name});
    } else {
      return plugins;
    }
  }

  plugins.eachPlugin = function eachPlugin(f) {
    _.each(allPlugins, f);
  };

  plugins.consts = consts;

  plugins.utils = require('./utils')({
    //TODO: refactor so all this happens after init somehow
    //  until then use some defaults so things don't blow up
    language: ctx.language
    , settings: {}
  });

  plugins.addHtmlFromPlugins = function addHtmlFromPlugins(client) {
    plugins.eachPlugin(function addHtml(p) {
      // add main plugin html
      if (p.html && ! $('#' + p.name + '-placeholder').length) {
        $('#pluginchartplaceholders').append($('<div>').attr('id',p.name + '-placeholder').addClass('tabplaceholder').css('display','none').append(p.html(client)));
      }
      // add menu item
      if (p.html && ! $('#' + p.name).length) {
        $('#tabnav').append($('<li>').attr('id',p.name).addClass('menutab').append(client.translate(p.label)));
      }
      // add css
      if (p.css) {
        $('<style>')
          .prop('type', 'text/css')
          .html(p.css)
          .appendTo('head');
      }
    });
    // select 1st tab
    $('#tabnav > li:first').addClass('selected');
    // show 1st report
    $('#pluginchartplaceholders > div:first').css('display','');
  };

  return plugins();

}

module.exports = init;
