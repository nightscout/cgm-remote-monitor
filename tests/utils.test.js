'use strict';

require('should');

describe('utils', function ( ) {
  var utils = require('../lib/utils')();

  var clientSettings = {
    alarmTimeAgoUrgentMins: 30
    , alarmTimeAgoWarnMins: 15
  };

  it('format numbers', function () {
    utils.toFixed(5.499999999).should.equal('5.50');
  });

  it('show format recent times to 1 minute', function () {
    var result = utils.timeAgo(Date.now() - 30000, clientSettings);
    result.value.should.equal(1);
    result.label.should.equal('min ago');
    result.status.should.equal('current');
  });

});
