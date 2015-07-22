'use strict';

require('should');

describe('pluginbase', function ( ) {

  var jsdom = require('jsdom').jsdom;
  var doc = jsdom('<body></body>');
  var window = doc.parentWindow;


  global.$ = global.jQuery = require('jquery')(window);

  function div (clazz) {
    return $('<div class="' + clazz + '"></div>');
  }

  var container = div('container')
    , bgStatus = div('bgStatus').appendTo(container)
    , majorPills = div('majorPills').appendTo(bgStatus)
    , minorPills = div('minorPills').appendTo(bgStatus)
    , statusPills = div('statusPills').appendTo(bgStatus)
    , tooltip = div('tooltip').appendTo(container)
    ;

  var fake = {
    name: 'fake'
    , label: 'Insulin-on-Board'
    , pluginType: 'pill-major'
  };

  it('does stuff', function() {
    var pluginbase = require('../lib/plugins/pluginbase')(majorPills, minorPills, statusPills, bgStatus, tooltip);

    pluginbase.updatePillText(fake, {
      value: '123'
      , label: 'TEST'
      , info: [{label: 'Label', value: 'Value'}]
    });

    majorPills.length.should.equal(1);
  });

});