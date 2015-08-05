'use strict';

require('should');
var _ =require('lodash');

var FIVE_MINS = 300000;
var SIX_MINS = 360000;

describe('Delta', function ( ) {
  var delta = require('../lib/plugins/delta')();
  var sandbox = require('../lib/sandbox')();

  var pluginBase = {};
  var now = Date.now();
  var before = now - FIVE_MINS;

  it('should calculate BG Delta', function (done) {
    var clientSettings = { units: 'mg/dl' };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};

    var callbackPluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.label.should.equal(clientSettings.units);
        options.value.should.equal('+5');
        options.info.length.should.equal(0);
        done();
      }
    };

    var sbx = sandbox.clientInit(clientSettings, Date.now(), callbackPluginBase, data);

    delta.setProperties(sbx);

    var prop = sbx.properties.delta;
    prop.mgdl.should.equal(5);
    prop.interpolated.should.equal(false);
    prop.scaled.should.equal(5);
    prop.display.should.equal('+5');

    delta.updateVisualisation(sbx);
  });

  it('should calculate BG Delta by interpolating when more than 5mins apart', function (done) {
    var clientSettings = { units: 'mg/dl' };
    var data = {sgvs: [{mills: before - SIX_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};

    var callbackPluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.label.should.equal(clientSettings.units);
        options.value.should.equal('+2 *');
        findInfoValue('Elapsed Time', options.info).should.equal('11 mins');
        findInfoValue('Absolute Delta', options.info).should.equal('5 mg/dl');
        findInfoValue('Interpolated', options.info).should.equal('103 mg/dl');
        done();
      }
    };

    var sbx = sandbox.clientInit(clientSettings, Date.now(), callbackPluginBase, data);

    delta.setProperties(sbx);

    var prop = sbx.properties.delta;
    prop.mgdl.should.equal(2);
    prop.interpolated.should.equal(true);
    prop.scaled.should.equal(2);
    prop.display.should.equal('+2');
    delta.updateVisualisation(sbx);

  });

  it('should calculate BG Delta in mmol', function (done) {
    var clientSettings = { units: 'mmol' };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.mgdl.should.equal(5);
      result.interpolated.should.equal(false);
      result.scaled.should.equal(0.3);
      result.display.should.equal('+0.3');
      done();
    };

    delta.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol by interpolating when more than 5mins apart', function (done) {
    var clientSettings = { units: 'mmol' };
    var data = {sgvs: [{mills: before - SIX_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.mgdl.should.equal(2);
      result.interpolated.should.equal(true);
      result.scaled.should.equal(0.1);
      result.display.should.equal('+0.1');
      done();
    };

    delta.setProperties(sbx);
  });

});

function findInfoValue (label, info) {
  var found = _.find(info, function checkLine (line) {
    return line.label === label;
  });
  return found && found.value;
}
