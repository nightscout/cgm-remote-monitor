'use strict';

require('should');

var FIVE_MINS = 300000;

describe('Delta', function ( ) {
  var delta = require('../lib/plugins/delta')();
  var sandbox = require('../lib/sandbox')();

  var pluginBase = {};
  var now = Date.now();
  var before = now - FIVE_MINS;
  var app = { };

  it('should calculate BG Delta', function (done) {
    var clientSettings = { units: 'mg/dl' };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.mgdl.should.equal(5);
      result.scaled.should.equal(5);
      result.display.should.equal('+5');
      done();
    };

    delta.setProperties(sbx);
  });

  it('should calculate BG Delta by interpolating when more than 5mins apart', function (done) {
    var clientSettings = { units: 'mg/dl' };
    var data = {sgvs: [{mills: before - FIVE_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();

      //2.5 is rounded to 3
      result.mgdl.should.equal(3);
      result.scaled.should.equal(3);
      result.display.should.equal('+3');
      done();
    };

    delta.setProperties(sbx);

  });

  it('should calculate BG Delta in mmol', function (done) {
    var clientSettings = { units: 'mmol' };
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.mgdl.should.equal(5);
      result.scaled.should.equal(0.3);
      result.display.should.equal('+0.3');
      done();
    };

    delta.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol by interpolating when more than 5mins apart', function (done) {
    var clientSettings = { units: 'mmol' };
    var data = {sgvs: [{mills: before - FIVE_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.mgdl.should.equal(3);
      result.scaled.should.equal(0.2);
      result.display.should.equal('+0.2');
      done();
    };

    delta.setProperties(sbx);
  });

});
