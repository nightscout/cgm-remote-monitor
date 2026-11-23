'use strict';

require('should');
var fs = require('fs');
var path = require('path');
var moment = require('moment');

var selectLatestPumpStatus = require('../../lib/client-core/devicestatus/pump');

var CAPTURED = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'captured', 'loop', 'devicestatus.json'), 'utf8'));

describe('client-core: devicestatus / pump (selectLatestPumpStatus)', function () {

  it('returns null for empty / non-array input', function () {
    (selectLatestPumpStatus([]) === null).should.be.true();
    (selectLatestPumpStatus(null) === null).should.be.true();
    (selectLatestPumpStatus(undefined) === null).should.be.true();
  });

  it('returns the only record when given a single-element list', function () {
    var ds = { mills: 1000, pump: { clock: '2026-05-09T00:00:00Z' } };
    var r = selectLatestPumpStatus([ds]);
    r.should.equal(ds);
    r.clockMills.should.equal(moment('2026-05-09T00:00:00Z').valueOf());
  });

  it('picks the record with the latest pump.clock', function () {
    var older = { mills: 1, pump: { clock: '2026-05-08T00:00:00Z' } };
    var newer = { mills: 2, pump: { clock: '2026-05-09T00:00:00Z' } };
    selectLatestPumpStatus([older, newer]).should.equal(newer);
    selectLatestPumpStatus([newer, older]).should.equal(newer);
  });

  it('falls back to status.mills when pump.clock is absent', function () {
    var older = { mills: 1000, pump: { reservoir: 100 } };
    var newer = { mills: 2000, pump: { reservoir: 50 } };
    selectLatestPumpStatus([older, newer]).should.equal(newer);
  });

  it('compares pump.clock against status.mills consistently', function () {
    // newer by mills, older by clock — clock should win (clock is the
    // pump's authoritative timestamp; mills is upload time).
    var byClock = { mills: 1000, pump: { clock: '2026-05-09T00:00:00Z' } };
    var byMills = { mills: Date.parse('2026-05-10T00:00:00Z') }; // pump-less record
    var r = selectLatestPumpStatus([byClock, byMills]);
    r.should.equal(byMills);
  });

  it('mutates each input status with computed clockMills (legacy contract)', function () {
    var ds = { mills: 5000, pump: { clock: '2026-05-09T00:00:00Z' } };
    selectLatestPumpStatus([ds]);
    ds.should.have.property('clockMills').which.is.a.Number();
  });

  it('selects a captured pump-bearing devicestatus from the Loop fixture', function () {
    var pumpRecords = JSON.parse(JSON.stringify(CAPTURED))
      .filter(function (d) { return d.pump; });
    pumpRecords.length.should.be.greaterThan(0);
    var r = selectLatestPumpStatus(pumpRecords);
    (r !== null).should.be.true();
    r.should.have.property('pump');
    r.clockMills.should.be.a.Number();
  });
});
