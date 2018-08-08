'use strict';

require('should');

describe('Raw BG', function ( ) {
  var ctx =  {
      settings: { units: 'mg/dl'}
      , language: require('../lib/language')()
      , pluginBase: {}
  };
  ctx.language.set('en');

  var rawbg = require('../lib/plugins/rawbg')(ctx);

  var now = Date.now();
  var data = {
    sgvs: [{unfiltered: 113680, filtered: 111232, mgdl: 110, noise: 1, mills: now}]
    , cals: [{scale: 1, intercept: 25717.82377004309, slope: 766.895601715918, mills: now}]
  };


  it('should calculate Raw BG', function (done) {
    var sandbox = require('../lib/sandbox')();
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

  it('should handle alexa requests', function (done) {

    var sandbox = require('../lib/sandbox')();
    var sbx = sandbox.clientInit(ctx, Date.now(), data);

    rawbg.setProperties(sbx);

    rawbg.alexa.intentHandlers.length.should.equal(1);

    rawbg.alexa.intentHandlers[0].intentHandler(function next(title, response) {
      title.should.equal('Current Raw BG');
      response.should.equal('Your raw bg is 113');

      done();
    }, [], sbx);

  });

});
