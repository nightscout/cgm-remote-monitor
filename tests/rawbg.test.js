'use strict';

require('should');

describe('Raw BG', function ( ) {
  var rawbg = require('../lib/plugins/rawbg')();
  var sandbox = require('../lib/sandbox')();

  var pluginBase = {};
  var data = {
    sgvs: [{unfiltered: 113680, filtered: 111232, y: 110, noise: 1}]
    , cals: [{scale: 1, intercept: 25717.82377004309, slope: 766.895601715918}]
  };
  var app = { };
  var clientSettings = {
    units: 'mg/dl'
  };

  it('should calculate Raw BG', function (done) {
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('rawbg');
      var result = setter();
      result.value.should.equal(113);
      result.noiseLabel.should.equal('Clean');
      done();
    };

    rawbg.setProperties(sbx);

  });


});
