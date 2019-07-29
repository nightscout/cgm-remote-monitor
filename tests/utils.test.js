'use strict';

require('should');

describe('utils', function ( ) {
  var utils = require('../lib/utils')({
    language: require('../lib/language')()
    , settings: {
      alarmTimeagoUrgentMins: 30
      , alarmTimeagoWarnMins: 15
    }
  });

  it('format numbers', function () {
    utils.toFixed(5.499999999).should.equal('5.50');
  });

  it('format numbers short', function () {
    var undef;
    utils.toFixedMin(3.345, 2).should.equal('3.35');
    utils.toFixedMin(5.499999999, 0).should.equal('5');
    utils.toFixedMin(5.499999999, 1).should.equal('5.5');
    utils.toFixedMin(5.499999999, 3).should.equal('5.5');
    utils.toFixedMin(123.45, -2).should.equal('100');
    utils.toFixedMin(-0.001, 2).should.equal('0');
    utils.toFixedMin(-2.47, 1).should.equal('-2.5');
    utils.toFixedMin(-2.44, 1).should.equal('-2.4');

    utils.toFixedMin(undef, 2).should.equal('0');
    utils.toFixedMin(null, 2).should.equal('0');
    utils.toFixedMin('text', 2).should.equal('0');
  });

  it('merge date and time', function () {
    var result = utils.mergeInputTime('22:35', '2015-07-14');
    result.hours().should.equal(22);
    result.minutes().should.equal(35);
    result.year().should.equal(2015);
    result.format('MMM').should.equal('Jul');
    result.date().should.equal(14);
  });

});
