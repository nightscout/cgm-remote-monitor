'use strict';

var should = require('should');
var _ = require('lodash');
const helper = require('./inithelper')();

var FIVE_MINS = 300000;
var SIX_MINS = 360000;

describe('BG Now', function ( ) {

  const ctx = helper.ctx;

  var bgnow = require('../lib/plugins/bgnow')(ctx);
  var sandbox = require('../lib/sandbox')(ctx);

  var now = Date.now();
  var before = now - FIVE_MINS;

  it('should calculate BG Delta', function (done) {
    var ctx = {
      settings: { units: 'mg/dl' }
      , pluginBase: {
        updatePillText: function mockedUpdatePillText (plugin, options) {
          options.label.should.equal(ctx.settings.units);
          options.value.should.equal('+5');
          should.not.exist(options.info);
          done();
        }
      , language: { translate: function(text) { return text; } }
      }
    };
    
    ctx.language = ctx.pluginBase.language;
    ctx.levels = require('../lib/levels');
   
    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};

    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    bgnow.setProperties(sbx);

    var delta = sbx.properties.delta;
    delta.mgdl.should.equal(5);
    delta.interpolated.should.equal(false);
    delta.scaled.should.equal(5);
    delta.display.should.equal('+5');

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
      , language: require('../lib/language')()
      , moment: helper.ctx.moment
    };

    var sbx = sandbox.clientInit(ctx, now, data);

    bgnow.setProperties(sbx);

    var delta = sbx.properties.delta;
    delta.mgdl.should.equal(2);
    delta.interpolated.should.equal(true);
    delta.scaled.should.equal(2);
    delta.display.should.equal('+2');
    bgnow.updateVisualisation(sbx);

  });

  it('should calculate BG Delta in mmol', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
      , language: require('../lib/language')()
      , moment: helper.ctx.moment
    };

    var data = {sgvs: [{mills: before, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    var gotbgnow = false;
    var gotdelta = false;
    var gotbuckets = false;

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      if (name === 'bgnow') {
        var bgnowProp = setter();
        bgnowProp.mean.should.equal(105);
        bgnowProp.last.should.equal(105);
        bgnowProp.mills.should.equal(now);
        gotbgnow = true;
      } else if (name === 'delta') {
        var result = setter();
        result.mgdl.should.equal(5);
        result.interpolated.should.equal(false);
        result.scaled.should.equal(0.2);
        result.display.should.equal('+0.2');
        gotdelta = true;
      } else if (name === 'buckets') {
        var buckets = setter();
        buckets[0].mean.should.equal(105);
        buckets[1].mean.should.equal(100);
        gotbuckets = true;
      }

      if (gotbgnow && gotdelta && gotbuckets) {
        done();
      }
    };

    bgnow.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol and not show a change because of rounding', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
      , language: require('../lib/language')()
      , moment: helper.ctx.moment
    };

    var data = {sgvs: [{mills: before, mgdl: 85}, {mills: now, mgdl: 85}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    var gotbgnow = false;
    var gotdelta = false;
    var gotbuckets = false;

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      if (name === 'bgnow') {
        var bgnowProp = setter();
        bgnowProp.mean.should.equal(85);
        bgnowProp.last.should.equal(85);
        bgnowProp.mills.should.equal(now);
        gotbgnow = true;
      } else if (name === 'delta') {
        var result = setter();
        result.mgdl.should.equal(0);
        result.interpolated.should.equal(false);
        result.scaled.should.equal(0);
        result.display.should.equal('+0');
        gotdelta = true;
      } else if (name === 'buckets') {
        var buckets = setter();
        buckets[0].mean.should.equal(85);
        buckets[1].mean.should.equal(85);
        gotbuckets = true;
      }

      if (gotbgnow && gotdelta && gotbuckets) {
        done();
      }

    };

    bgnow.setProperties(sbx);
  });

  it('should calculate BG Delta in mmol by interpolating when more than 5mins apart', function (done) {
    var ctx = {
      settings: {
        units: 'mmol'
      }
      , pluginBase: {}
      , language: require('../lib/language')()
      , moment: helper.ctx.moment
    };

    var data = {sgvs: [{mills: before - SIX_MINS, mgdl: 100}, {mills: now, mgdl: 105}]};
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    var gotbgnow = false;
    var gotdelta = false;
    var gotbuckets = false;

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      if (name === 'bgnow') {
        var bgnowProp = setter();
        bgnowProp.mean.should.equal(105);
        bgnowProp.last.should.equal(105);
        bgnowProp.mills.should.equal(now);
        gotbgnow = true;
      } else if (name === 'delta') {
        var result = setter();
        result.mgdl.should.equal(2);
        result.interpolated.should.equal(true);
        result.scaled.should.equal(0.1);
        result.display.should.equal('+0.1');
        gotdelta = true;
      } else if (name === 'buckets') {
        var buckets = setter();
        buckets[0].mean.should.equal(105);
        buckets[1].isEmpty.should.equal(true);
        buckets[2].mean.should.equal(100);
        gotbuckets = true;
      }

      if (gotbgnow && gotdelta && gotbuckets) {
        done();
      }
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
