'use strict';

require('should');
var fs = require('fs');
var path = require('path');
var normalizeDirection = require('../lib/direction-normalizer').normalizeDirection;

describe('BG direction', function ( ) {

  var now = Date.now();

  function setupSandbox(data, pluginBase) {
    var ctx = {
      settings: {}
      , pluginBase: pluginBase || {}
    };

    ctx.language = require('../lib/language')();

    var sandbox = require('../lib/sandbox')();
    return sandbox.clientInit(ctx, Date.now(), data);
  }

  it('set the direction property - Flat', function (done) {
    var sbx = setupSandbox({sgvs: [{mills: now, direction: 'Flat'}]});

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('direction');
      var result = setter();
      result.value.should.equal('Flat');
      result.label.should.equal('→');
      result.entity.should.equal('&#8594;');
      done();
    };

    var direction = require('../lib/plugins/direction')();
    direction.setProperties(sbx);

  });

  it('set the direction property Double Up', function (done) {
    var sbx = setupSandbox({sgvs: [{mills: now, direction: 'DoubleUp'}]});

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('direction');
      var result = setter();
      result.value.should.equal('DoubleUp');
      result.label.should.equal('⇈');
      result.entity.should.equal('&#8648;');
      done();
    };

    var direction = require('../lib/plugins/direction')();
    direction.setProperties(sbx);

  });

  it('set a pill to the direction', function (done) {
    var pluginBase = {
      updatePillText: function mockedUpdatePillText (plugin, options) {
        options.label.should.equal('→&#xfe0e;');
        done();
      }
    };

    var sbx = setupSandbox({sgvs: [{mills: now, direction: 'Flat'}]}, pluginBase);
    var direction = require('../lib/plugins/direction')();
    direction.setProperties(sbx);
    direction.updateVisualisation(sbx);
  });

  it('get the info for a direction', function () {
    var direction = require('../lib/plugins/direction')();

    direction.info({mills: now, direction: 'NONE'}).label.should.equal('⇼');
    direction.info({mills: now, direction: 'NONE'}).entity.should.equal('&#8700;');

    direction.info({mills: now, direction: 'DoubleUp'}).label.should.equal('⇈');
    direction.info({mills: now, direction: 'DoubleUp'}).entity.should.equal('&#8648;');

    direction.info({mills: now, direction: 'SingleUp'}).label.should.equal('↑');
    direction.info({mills: now, direction: 'SingleUp'}).entity.should.equal('&#8593;');

    direction.info({mills: now, direction: 'FortyFiveUp'}).label.should.equal('↗');
    direction.info({mills: now, direction: 'FortyFiveUp'}).entity.should.equal('&#8599;');

    direction.info({mills: now, direction: 'Flat'}).label.should.equal('→');
    direction.info({mills: now, direction: 'Flat'}).entity.should.equal('&#8594;');

    direction.info({mills: now, direction: 'FortyFiveDown'}).label.should.equal('↘');
    direction.info({mills: now, direction: 'FortyFiveDown'}).entity.should.equal('&#8600;');

    direction.info({mills: now, direction: 'SingleDown'}).label.should.equal('↓');
    direction.info({mills: now, direction: 'SingleDown'}).entity.should.equal('&#8595;');

    direction.info({mills: now, direction: 'DoubleDown'}).label.should.equal('⇊');
    direction.info({mills: now, direction: 'DoubleDown'}).entity.should.equal('&#8650;');

    direction.info({mills: now, direction: 'NOT COMPUTABLE'}).label.should.equal('-');
    direction.info({mills: now, direction: 'NOT COMPUTABLE'}).entity.should.equal('&#45;');

    direction.info({mills: now, direction: 'RATE OUT OF RANGE'}).label.should.equal('⇕');
    direction.info({mills: now, direction: 'RATE OUT OF RANGE'}).entity.should.equal('&#8661;');
  });

  it('normalizes legacy direction aliases before display', function () {
    var direction = require('../lib/plugins/direction')();

    direction.info({mills: now, direction: 'Up'}).value.should.equal('SingleUp');
    direction.info({mills: now, direction: 'Up'}).label.should.equal('↑');

    direction.info({mills: now, direction: 'Down'}).value.should.equal('SingleDown');
    direction.info({mills: now, direction: 'Down'}).label.should.equal('↓');

    direction.info({mills: now, direction: 'Slide up'}).value.should.equal('FortyFiveUp');
    direction.info({mills: now, direction: 'Slide up'}).label.should.equal('↗');

    direction.info({mills: now, direction: 'Slide down'}).value.should.equal('FortyFiveDown');
    direction.info({mills: now, direction: 'Slide down'}).label.should.equal('↘');
  });

  it('normalizes legacy direction aliases to existing clock assets', function () {
    ['Up', 'Down', 'Slide up', 'Slide down'].forEach(function assertAssetExists(direction) {
      var asset = path.join(__dirname, '..', 'static', 'images', normalizeDirection(direction) + '.svg');
      fs.existsSync(asset).should.equal(true);
    });
  });


});
