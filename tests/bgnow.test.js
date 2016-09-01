'use strict';

require('should');
var _ =require('lodash');

var FIVE_MINS = 300000;
var SIX_MINS = 360000;

describe('BG Now', function ( ) {
  var bgnow = require('../lib/plugins/bgnow')();
  var sandbox = require('../lib/sandbox')();

  var now = Date.now();
  var before = now - FIVE_MINS;

  it('should calculate BG Delta', function (done) {
    var ctx = {
      settings: { units: 'mg/dl' }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.label.should.equal(ctx.settings.units);
          options.value.should.equal('+5');
          options.info.length.should.equal(0);
          done();
        }
      }
    };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};

    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    bgnow.setProperties(sbx);

    var prop = sbx.properties.bgnow.delta;
    prop.mgdl.should.equal(5);
    prop.interpolated.should.equal(false);
    prop.scaled.should.equal(5);
    prop.display.should.equal('+5');

    bgnow.updateVisualisation(sbx);
  });

  it('should calculate BG Delta by interpolating when more than 5mins apart', function (done) {
    var data = {sgvs: [{mills: before - SIX_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};

    var ctx = {
      settings: {
        units: 'mg/dl'
      }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText(plugin, options) {
          options.label.should.equal(ctx.settings.units);
          options.value.should.equal('+2 *');
          findInfoValue('Elapsed Time', options.info).should.equal('11 mins');
          findInfoValue('Absolute Delta', options.info).should.equal('5 mg/dl');
          findInfoValue('Interpolated', options.info).should.equal('103 mg/dl');
          done();
        }
      }
    };

    var sbx = sandbox.clientInit(ctx, now, data);

    bgnow.setProperties(sbx);

    var prop = sbx.properties.bgnow.delta;
    prop.mgdl.should.equal(2);
    prop.interpolated.should.equal(true);
    prop.scaled.should.equal(2);
    prop.display.should.equal('+2');
    bgnow.updateVisualisation(sbx);

  });

  it('should calculate BG Delta in mmol', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
    };

    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('bgnow');
      var result = setter().delta;
      result.mgdl.should.equal(5);
      result.interpolated.should.equal(false);
      result.scaled.should.equal(0.2);
      result.display.should.equal('+0.2');
      done();
    };

    bgnow.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol and not show a change because of rounding', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
    };

    var data = {sgvs: [{mills: before, mgdl: 85}, {mills: now, mgdl: 85}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('bgnow');
      var result = setter().delta;
      result.mgdl.should.equal(0);
      result.interpolated.should.equal(false);
      result.scaled.should.equal(0);
      result.display.should.equal('+0');
      done();
    };

    bgnow.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol by interpolating when more than 5mins apart', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
    };

    var data = {sgvs: [{mills: before - SIX_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('bgnow');
      var result = setter().delta;
      result.mgdl.should.equal(2);
      result.interpolated.should.equal(true);
      result.scaled.should.equal(0.1);
      result.display.should.equal('+0.1');
      done();
    };

    bgnow.setProperties(sbx);
  });

});

function findInfoValue (label, info) {
  var found = _.find(info, function checkLine (line) {
    return line.label === label;
  });
  return found && found.value;
}
