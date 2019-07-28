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
    var undef;
    utils.toFixed(3.345, 2).should.equal('3.35');
    utils.toFixed(5.499999999, 0).should.equal('6');
    utils.toFixed(5.499999999, 1).should.equal('5.5');
    utils.toFixed(5.499999999, 3).should.equal('5.5');
    utils.toFixed(123.45, -2).should.equal('100');

    utils.toFixed(undef, 2).should.equal('0');
    utils.toFixed(null, 2).should.equal('0');
    utils.toFixed('text', 2).should.equal('0');
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
