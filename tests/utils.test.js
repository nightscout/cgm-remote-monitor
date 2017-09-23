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

  it('merge date and time', function () {
    var result = utils.mergeInputTime('22:35', '2015-07-14');
    result.hours().should.equal(22);
    result.minutes().should.equal(35);
    result.year().should.equal(2015);
    result.format('MMM').should.equal('Jul');
    result.date().should.equal(14);
  });

});
