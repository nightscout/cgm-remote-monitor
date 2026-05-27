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

});

describe('normalizeGlucoseUnit', function () {
  var units = require('../lib/units')();

  it('should normalize mg/dl variants to mgdl', function () {
    units.normalizeGlucoseUnit('mg/dl').should.equal('mgdl');
    units.normalizeGlucoseUnit('mg').should.equal('mgdl');
    units.normalizeGlucoseUnit('mgdl').should.equal('mgdl');
    units.normalizeGlucoseUnit('MG/DL').should.equal('mgdl');
  });

  it('should normalize mmol/l variants to mmol', function () {
    units.normalizeGlucoseUnit('mmol/l').should.equal('mmol');
    units.normalizeGlucoseUnit('mmol').should.equal('mmol');
    units.normalizeGlucoseUnit('MMOL/L').should.equal('mmol');
  });

  it('should return null for unrecognized or missing unit', function () {
    (units.normalizeGlucoseUnit(null) === null).should.be.true();
    (units.normalizeGlucoseUnit('') === null).should.be.true();
    (units.normalizeGlucoseUnit('unknown') === null).should.be.true();
  });
});

describe('guessUnitFromValueAndHint', function () {
  var units = require('../lib/units')();

  it('should trust a recognized unit hint', function () {
    units.guessUnitFromValueAndHint(100, 'mg/dl').should.equal('mgdl');
    units.guessUnitFromValueAndHint(5.5, 'mmol').should.equal('mmol');
  });

  it('should infer mgdl for value >= 40 without hint', function () {
    units.guessUnitFromValueAndHint(40).should.equal('mgdl');
    units.guessUnitFromValueAndHint(120).should.equal('mgdl');
  });

  it('should infer mmol for value <= 25 without hint', function () {
    units.guessUnitFromValueAndHint(5.5).should.equal('mmol');
    units.guessUnitFromValueAndHint(25).should.equal('mmol');
  });

  it('should return null for ambiguous values in 26-39 range without hint', function () {
    (units.guessUnitFromValueAndHint(30) === null).should.be.true();
    (units.guessUnitFromValueAndHint(35) === null).should.be.true();
  });
});

describe('guessUnitByProximity', function () {
  var units = require('../lib/units')();

  it('should pick mgdl when value is closer to reference as mg/dL', function () {
    // value=30, ref=100 → |30-100|=70 vs |mmolToMgdl(30)-100|=|540-100|=440 → mgdl
    units.guessUnitByProximity(30, 100).should.equal('mgdl');
  });

  it('should pick mmol when mmol interpretation is closer to reference', function () {
    // value=30, ref=540 → mmolToMgdl(30)≈540 → closer as mmol
    units.guessUnitByProximity(30, 540).should.equal('mmol');
  });
});
