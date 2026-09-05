'use strict';

require('should');
var fs = require('fs');
var path = require('path');

var selectCOB = require('../../lib/client-core/devicestatus/cob');

var CAPTURED = path.join(__dirname, '..', 'fixtures', 'captured');

var AAPS = JSON.parse(fs.readFileSync(path.join(CAPTURED, 'aaps', 'devicestatus.json'), 'utf8'));
var TRIO = JSON.parse(fs.readFileSync(path.join(CAPTURED, 'trio', 'devicestatus.json'), 'utf8'));
var LOOP = JSON.parse(fs.readFileSync(path.join(CAPTURED, 'loop', 'devicestatus.json'), 'utf8'));
var PHONE = JSON.parse(fs.readFileSync(path.join(CAPTURED, 'phone-uploader', 'devicestatus.json'), 'utf8'));

function withMills (entry) {
  return Object.assign({}, entry, { mills: new Date(entry.created_at).getTime() });
}

describe('client-core: devicestatus / cob (selectCOB)', function () {

  it('returns {} for null / undefined / non-object', function () {
    selectCOB(null).should.eql({});
    selectCOB(undefined).should.eql({});
    selectCOB('string').should.eql({});
    selectCOB(42).should.eql({});
  });

  it('returns {} for a record with neither an openaps nor a loop block', function () {
    selectCOB(withMills(PHONE[0])).should.eql({});
  });

  describe('OpenAPS family', function () {

    it('reads COB from the newer of enacted and suggested', function () {
      var entry = {
        device: 'openaps://pi1'
        , mills: 3000
        , openaps: {
          suggested: { COB: 12, timestamp: 1000 }
          , enacted: { COB: 7, timestamp: 2000 }
        }
      };
      selectCOB(entry).should.eql({ cob: 7, source: 'OpenAPS', device: 'openaps://pi1', mills: 2000 });
    });

    it('prefers suggested when it is the newer block', function () {
      var entry = {
        device: 'Trio'
        , mills: 3000
        , openaps: {
          suggested: { COB: 12, timestamp: 2000 }
          , enacted: { COB: 7, timestamp: 1000 }
        }
      };
      selectCOB(entry).should.eql({ cob: 12, source: 'OpenAPS', device: 'Trio', mills: 2000 });
    });

    it('prefers suggested when both blocks carry the same timestamp', function () {
      var entry = {
        mills: 3000
        , openaps: {
          suggested: { COB: 12, timestamp: 2000 }
          , enacted: { COB: 7, timestamp: 2000 }
        }
      };
      selectCOB(entry).cob.should.equal(12);
    });

    it('ignores a block that carries no COB', function () {
      var entry = {
        mills: 3000
        , openaps: {
          suggested: { COB: 12, timestamp: 1000 }
          , enacted: { received: true, timestamp: 2000 }
        }
      };
      selectCOB(entry).should.eql({ cob: 12, source: 'OpenAPS', device: undefined, mills: 1000 });
    });

    it('dates a timestamp-less block from the enclosing record', function () {
      var entry = {
        device: 'openaps://AndroidAPS'
        , mills: 7000
        , openaps: { suggested: { COB: 3 }, enacted: { received: true } }
      };
      selectCOB(entry).should.eql({ cob: 3, source: 'OpenAPS', device: 'openaps://AndroidAPS', mills: 7000 });
    });

    it('returns {} when the record can not be dated at all', function () {
      selectCOB({ openaps: { suggested: { COB: 3 } } }).should.eql({});
    });

    it('coerces a string COB', function () {
      selectCOB({ mills: 100, openaps: { suggested: { COB: '61' } } }).cob.should.equal(61);
    });

    it('keeps a zero COB', function () {
      selectCOB({ mills: 100, openaps: { suggested: { COB: 0 } } }).cob.should.equal(0);
    });

    it('rejects a non-numeric COB', function () {
      selectCOB({ mills: 100, openaps: { suggested: { COB: 'n/a' } } }).should.eql({});
      selectCOB({ mills: 100, openaps: { suggested: { COB: null } } }).should.eql({});
    });

    it('falls through to the loop block when openaps yields no COB', function () {
      var entry = {
        device: 'loop://iPhone'
        , mills: 500
        , openaps: { enacted: { received: true } }
        , loop: { cob: { cob: 9, timestamp: 400 } }
      };
      selectCOB(entry).should.eql({ cob: 9, source: 'Loop', device: 'loop://iPhone', mills: 400 });
    });

  });

  describe('Loop', function () {

    it('reads loop.cob.cob', function () {
      var entry = { device: 'loop://iPhone', mills: 500, loop: { cob: { cob: 5, timestamp: 400 } } };
      selectCOB(entry).should.eql({ cob: 5, source: 'Loop', device: 'loop://iPhone', mills: 400 });
    });

    it('dates a timestamp-less loop.cob from the enclosing record', function () {
      selectCOB({ mills: 500, loop: { cob: { cob: 5 } } }).mills.should.equal(500);
    });

    it('returns {} for a loop block with no cob', function () {
      selectCOB({ mills: 500, loop: { iob: { iob: 1 } } }).should.eql({});
    });

  });

  describe('captured fixtures', function () {

    it('reads AndroidAPS COB from suggested, dated by the record', function () {
      var entry = withMills(AAPS[0]);
      selectCOB(entry).should.eql({
        cob: 0
        , source: 'OpenAPS'
        , device: 'openaps://AndroidAPS'
        , mills: new Date(AAPS[0].created_at).getTime()
      });
    });

    it('is stable across repeated calls for every AndroidAPS record', function () {
      AAPS.map(withMills).forEach(function (entry) {
        var first = selectCOB(entry);
        for (var i = 0; i < 50; i++) {
          selectCOB(entry).should.eql(first);
        }
        first.cob.should.be.a.Number();
        first.mills.should.equal(new Date(entry.created_at).getTime());
      });
    });

    it('reads Trio COB from the newer of suggested and enacted', function () {
      selectCOB(withMills(TRIO[0])).should.eql({
        cob: 61
        , source: 'OpenAPS'
        , device: 'Trio'
        , mills: new Date('2026-05-08T23:59:58.139Z').getTime()
      });

      // enacted here is a cycle behind suggested
      selectCOB(withMills(TRIO[2])).should.eql({
        cob: 62
        , source: 'OpenAPS'
        , device: 'Trio'
        , mills: new Date('2026-05-08T23:54:49.623Z').getTime()
      });
    });

    it('reads Loop COB', function () {
      selectCOB(withMills(LOOP[0])).should.eql({
        cob: 0
        , source: 'Loop'
        , device: 'loop://test-device'
        , mills: new Date('2026-05-09T00:00:30.372Z').getTime()
      });
    });

  });

  it('does not mutate the record it is given', function () {
    var entry = withMills(AAPS[0]);
    var before = JSON.stringify(entry);
    selectCOB(entry);
    JSON.stringify(entry).should.equal(before);
  });

});
