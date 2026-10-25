'use strict';

require('should');

describe('units', function ( ) {
  var units = require('../lib/units')();

  it('should convert 99 to 5.5', function () {
    units.mgdlToMMOL(99).should.equal('5.5');
  });

  it('should convert 180 to 10.0', function () {
    units.mgdlToMMOL(180).should.equal('10.0');
  });

  it('should convert 5.5 to 99', function () {
    units.mmolToMgdl(5.5).should.equal(99);
  });

  it('should convert 10.0 to 180', function () {
    units.mmolToMgdl(10.0).should.equal(180);
  });

  it('should convert 5.5 mmol and then convert back to 5.5 mmol', function () {
    units.mgdlToMMOL(units.mmolToMgdl(5.5)).should.equal('5.5');
  });

  it('should convert 99 mgdl and then convert back to 99 mgdl', function () {
    units.mmolToMgdl(units.mgdlToMMOL(99)).should.equal(99);
  });

  it('should convert negative delta -9 mgdl to mmol preserving sign', function () {
    units.mgdlToMMOL(-9).should.equal('-0.5');
  });

  it('should convert negative delta -18 mgdl to mmol preserving sign', function () {
    units.mgdlToMMOL(-18).should.equal('-1.0');
  });

  it('should convert 0 delta to 0.0', function () {
    units.mgdlToMMOL(0).should.equal('0.0');
  });

});
