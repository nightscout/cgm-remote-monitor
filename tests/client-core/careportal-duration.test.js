'use strict';

require('should');

var parseDuration = require('../../lib/client-core/careportal/duration');
var times = require('../../lib/times');

function toCareportalDuration(value) {
  var durationParsed = times.msecs(parseDuration(value)).mins;
  return durationParsed < 1 ? value : durationParsed;
}

describe('client-core/careportal/duration', function () {

  it('parses blank and invalid values as zero milliseconds', function () {
    parseDuration('').should.equal(0);
    parseDuration('not a duration').should.equal(0);
  });

  it('preserves the legacy unitless numeric behavior', function () {
    parseDuration('30').should.equal(30);
    toCareportalDuration('30').should.equal('30');
  });

  it('parses minute values', function () {
    parseDuration('30m').should.equal(times.mins(30).msecs);
    toCareportalDuration('30m').should.equal(30);
  });

  it('parses whole-hour values', function () {
    parseDuration('1h').should.equal(times.hour().msecs);
    toCareportalDuration('1h').should.equal(60);
  });

  it('parses fractional-hour values', function () {
    parseDuration('1.5h').should.equal(times.mins(90).msecs);
    toCareportalDuration('1.5h').should.equal(90);
  });

  it('keeps legacy support for scientific notation and digit group commas', function () {
    parseDuration('2e3s').should.equal(times.secs(2000).msecs);
    parseDuration('1,000ms').should.equal(1000);
  });

});
