'use strict';

require('should');
var fs = require('fs');
var path = require('path');
var moment = require('moment');

var selectLoopState = require('../../lib/client-core/devicestatus/loop');

var CAPTURED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'captured', 'loop', 'devicestatus.json'), 'utf8'));
var TRIO = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'captured', 'trio', 'devicestatus.json'), 'utf8'));

// The captured set is anchored so the latest record is at
// 2026-05-09T00:00:00Z; pick a "now" just past the latest sample
// so all 30 captured records fall within the recent window.
var NOW_MILLS = Date.parse('2026-05-09T00:01:00Z');
var RECENT = moment(NOW_MILLS).subtract(15, 'minutes'); // mirrors warn/2 default of 30min

describe('client-core: devicestatus / loop (selectLoopState)', function () {

  describe('contract', function () {

    it('returns the documented null-shape for an empty list', function () {
      var r = selectLoopState([], RECENT);
      r.should.have.properties(['lastLoop', 'lastEnacted', 'lastPredicted', 'lastOverride', 'lastOkMoment', 'display']);
      (r.lastLoop === null).should.be.true();
      r.display.should.have.properties(['symbol', 'code', 'label']);
      r.display.code.should.equal('warning');
    });

    it('handles non-array input without throwing', function () {
      var r = selectLoopState(null, RECENT);
      r.display.code.should.equal('warning');
    });

    it('skips records without a loop.timestamp', function () {
      var r = selectLoopState([{ device: 'x' }, { loop: {} }], RECENT);
      (r.lastLoop === null).should.be.true();
    });
  });

  describe('captured Loop iOS fixtures', function () {

    var result;

    before(function () {
      // Deep-clone captured data so mutations (loopStatus.moment etc.)
      // don't leak between tests.
      var clone = JSON.parse(JSON.stringify(CAPTURED));
      result = selectLoopState(clone, RECENT);
    });

    it('selects a lastLoop', function () {
      (result.lastLoop !== null).should.be.true();
      result.lastLoop.should.have.property('timestamp');
      moment.isMoment(result.lastLoop.moment).should.be.true();
    });

    it('selects a lastPredicted with a startDate + values array', function () {
      (result.lastPredicted !== null).should.be.true();
      result.lastPredicted.should.have.property('startDate');
      result.lastPredicted.should.have.property('values').which.is.an.Array();
      result.lastPredicted.values.length.should.be.greaterThan(0);
    });

    it('lastOkMoment is the latest non-failure loop moment', function () {
      moment.isMoment(result.lastOkMoment).should.be.true();
      result.lastOkMoment.valueOf().should.equal(result.lastLoop.moment.valueOf());
    });

    it('display code is one of the documented states', function () {
      ['warning', 'error', 'enacted', 'recommendation', 'looping']
        .indexOf(result.display.code).should.not.equal(-1);
    });

    it('captured Loop fixtures produce a "looping" or "enacted" display when within recent window', function () {
      // The latest captured record is anchored to NOW-1min; within RECENT.
      ['looping', 'enacted', 'recommendation'].indexOf(result.display.code).should.not.equal(-1);
    });

    it('lastEnacted (when present) carries timestamp and a moment', function () {
      if (result.lastEnacted) {
        result.lastEnacted.should.have.property('timestamp');
        moment.isMoment(result.lastEnacted.moment).should.be.true();
      }
    });
  });

  describe('captured Trio fixtures (no loop block)', function () {
    it('returns the null-shape because Trio devicestatus has no `loop` body', function () {
      var clone = JSON.parse(JSON.stringify(TRIO));
      var r = selectLoopState(clone, RECENT);
      (r.lastLoop === null).should.be.true();
      r.display.code.should.equal('warning');
    });
  });

  describe('display state machine', function () {

    function buildLoop (overrides) {
      var ts = moment(NOW_MILLS).subtract(2, 'minutes').toISOString();
      var base = { loop: { timestamp: ts } };
      if (overrides) Object.assign(base.loop, overrides);
      return [base];
    }

    it('failureReason → error', function () {
      var r = selectLoopState(buildLoop({ failureReason: 'boom' }), RECENT);
      r.display.code.should.equal('error');
    });

    it('enacted but not received → error', function () {
      var r = selectLoopState(buildLoop({ enacted: { timestamp: 'x', received: false } }), RECENT);
      r.display.code.should.equal('error');
    });

    it('enacted and received within recent window → enacted', function () {
      var ts = moment(NOW_MILLS).subtract(2, 'minutes').toISOString();
      var statuses = [{
        timestamp: ts
        , loop: { timestamp: ts, enacted: { timestamp: ts, received: true } }
      }];
      var r = selectLoopState(statuses, RECENT);
      r.display.code.should.equal('enacted');
    });

    it('plain recent loop (no enacted, no recommendation) → looping', function () {
      var r = selectLoopState(buildLoop(), RECENT);
      r.display.code.should.equal('looping');
    });
  });
});
