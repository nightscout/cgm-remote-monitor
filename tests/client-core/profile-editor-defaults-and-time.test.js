'use strict';
require('should');

var buildDefaultProfile = require('../../lib/client-core/profile-editor/default-profile');
var timeUtils = require('../../lib/client-core/profile-editor/time-utils');

describe('client-core: profile-editor / default-profile + time-utils', function () {

  describe('buildDefaultProfile', function () {
    it('returns a fresh object on each call (no shared reference)', function () {
      var a = buildDefaultProfile();
      var b = buildDefaultProfile();
      a.should.not.equal(b);
      a.carbratio.should.not.equal(b.carbratio);
    });

    it('has the canonical shape (basal, sens, target_low/high arrays)', function () {
      var p = buildDefaultProfile();
      p.dia.should.equal(3);
      p.carbratio.should.be.an.Array().and.have.length(1);
      p.carbratio[0].should.eql({ time: '00:00', value: 30 });
      p.basal[0].time.should.equal('00:00');
      p.target_low.length.should.equal(p.target_high.length);
    });

    it('exposes both default export and named buildDefaultProfile', function () {
      buildDefaultProfile.buildDefaultProfile.should.equal(buildDefaultProfile);
    });
  });

  describe('toMinutesFromMidnight', function () {
    it('parses HH:mm', function () {
      timeUtils.toMinutesFromMidnight('00:00').should.equal(0);
      timeUtils.toMinutesFromMidnight('01:30').should.equal(90);
      timeUtils.toMinutesFromMidnight('23:59').should.equal(23 * 60 + 59);
    });

    it('returns NaN for non-string', function () {
      isNaN(timeUtils.toMinutesFromMidnight(null)).should.be.true();
      isNaN(timeUtils.toMinutesFromMidnight(undefined)).should.be.true();
    });
  });

  describe('toTimeString', function () {
    it('formats integer minutes as zero-padded HH:mm', function () {
      timeUtils.toTimeString(0).should.equal('00:00');
      timeUtils.toTimeString(90).should.equal('01:30');
      timeUtils.toTimeString(60 * 23 + 59).should.equal('23:59');
    });

    it('wraps 1440 to 00:00 (matches moment behaviour)', function () {
      timeUtils.toTimeString(1440).should.equal('00:00');
      timeUtils.toTimeString(1500).should.equal('01:00');
    });

    it('handles invalid input safely', function () {
      timeUtils.toTimeString('not-a-number').should.equal('00:00');
    });

    it('round-trips with toMinutesFromMidnight', function () {
      var samples = [0, 30, 60, 90, 720, 1380];
      samples.forEach(function (m) {
        timeUtils.toMinutesFromMidnight(timeUtils.toTimeString(m)).should.equal(m);
      });
    });
  });
});
