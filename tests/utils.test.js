'use strict';

require('should');

describe('utils', function ( ) {
  var settings = {
    alarmTimeagoUrgentMins: 30
    , alarmTimeagoWarnMins: 15
  };

  var utils = require('../lib/utils')(settings);

  it('format numbers', function () {
    utils.toFixed(5.499999999).should.equal('5.50');
  });

  it('show format recent times to 1 minute', function () {
    var result = utils.timeAgo(Date.now() - 30000);
    result.value.should.equal(1);
    result.label.should.equal('min ago');
    result.status.should.equal('current');
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
