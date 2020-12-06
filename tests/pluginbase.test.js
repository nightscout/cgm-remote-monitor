'use strict';

require('should');
var benv = require('benv');

describe('pluginbase', function ( ) {

  before(function (done) {
    benv.setup(function() {
      benv.expose({
        $: require('jquery')
        , jQuery: require('jquery')
      });
      done();
    });
  });

  after(function (done) {
    benv.teardown();
    done();
  });

  it('does stuff', function() {

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

    var pluginbase = require('../lib/plugins/pluginbase')(majorPills, minorPills, statusPills, bgStatus, tooltip);

    pluginbase.updatePillText(fake, {
      value: '123'
      , label: 'TEST'
      , info: [{label: 'Label', value: 'Value'}]
    });

    majorPills.length.should.equal(1);
  });

});