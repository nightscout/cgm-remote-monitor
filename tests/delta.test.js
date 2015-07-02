'use strict';

require('should');

describe('Delta', function ( ) {
  var delta = require('../lib/plugins/delta')();
  var sandbox = require('../lib/sandbox')();

  var pluginBase = {};
  var data = {sgvs: [{y: 100}, {y: 105}]};
  var app = { };
  var clientSettings = {
    units: 'mg/dl'
  };

  it('should calculate BG Delta', function (done) {
    var sbx = sandbox.clientInit(app, clientSettings, Date.now(), pluginBase, data);

    sbx.offerProperty = function mockedOfferProperty (name, setter) {
      name.should.equal('delta');
      var result = setter();
      result.value.should.equal(5);
      result.display.should.equal('+5');
      done();
    };

    delta.setProperties(sbx);

  });


});
