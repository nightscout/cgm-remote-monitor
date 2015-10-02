var should = require('should');

describe('units', function ( ) {
  var units = require('../lib/units')();

  it('should convert 99 to 5.5', function () {
    units.mgdlToMMOL(99).should.equal('5.5')
  });

  it('should convert 180 to 10.0', function () {
    units.mgdlToMMOL(180).should.equal('10.0')
  });

});
