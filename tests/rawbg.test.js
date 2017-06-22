'use strict';

require('should');

describe('Raw BG', function ( ) {
  var rawbg = require('../lib/plugins/rawbg')();
  var sandbox = require('../lib/sandbox')();

  var now = Date.now();
  var data = {
    sgvs: [{unfiltered: 113680, filtered: 111232, mgdl: 110, noise: 1, mills: now}]
    , cals: [{scale: 1, intercept: 25717.82377004309, slope: 766.895601715918, mills: now}]
  };
  var ctx = {
    settings: {
      units: 'mg/dl'
    }
    , pluginBase: {}
  };

  it('should calculate Raw BG', function (done) {
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('rawbg');
      var result = setter();
      result.mgdl.should.equal(113);
      result.noiseLabel.should.equal('Clean');
      done();
    };

    rawbg.setProperties(sbx);

  });


});
