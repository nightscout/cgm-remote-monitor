'use strict';

require('should');

describe('times', function ( ) {
  var times = require('../lib/times');

  it('hours to mins, secs, and msecs', function () {
    times.hour().mins.should.equal(60);
    times.hour().secs.should.equal(3600);
    times.hour().msecs.should.equal(3600000);
    times.hours(3).mins.should.equal(180);
    times.hours(3).secs.should.equal(10800);
    times.hours(3).msecs.should.equal(10800000);
  });

  it('mins to secs and msecs', function () {
    times.min().secs.should.equal(60);
    times.min().msecs.should.equal(60000);
    times.mins(2).secs.should.equal(120);
    times.mins(2).msecs.should.equal(120000);
  });

  it('secs as msecs', function () {
    times.sec().msecs.should.equal(1000);
    times.secs(15).msecs.should.equal(15000);
  });


});
