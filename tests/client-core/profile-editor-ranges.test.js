'use strict';
require('should');

var ranges = require('../../lib/client-core/profile-editor/ranges');

describe('client-core: profile-editor / ranges', function () {

  describe('addRangeStop', function () {
    it('inserts a {time:"00:00", value:0} stop at index', function () {
      var arr = [{ time: '00:00', value: 1 }, { time: '12:00', value: 2 }];
      ranges.addRangeStop(arr, 1);
      arr.length.should.equal(3);
      arr[1].should.eql({ time: '00:00', value: 0 });
      arr[2].time.should.equal('12:00');
    });

    it('clamps a too-large index to the end', function () {
      var arr = [{ time: '00:00', value: 1 }];
      ranges.addRangeStop(arr, 99);
      arr.length.should.equal(2);
    });

    it('treats invalid index as 0', function () {
      var arr = [{ time: '00:00', value: 1 }];
      ranges.addRangeStop(arr, 'nope');
      arr.length.should.equal(2);
      arr[0].value.should.equal(0);
    });
  });

  describe('removeRangeStop', function () {
    it('refuses to remove the only stop', function () {
      var arr = [{ time: '00:00', value: 1 }];
      ranges.removeRangeStop(arr, 0);
      arr.length.should.equal(1);
    });

    it('removes at index and forces arr[0].time = "00:00" invariant', function () {
      var arr = [
        { time: '00:00', value: 1 },
        { time: '06:00', value: 2 },
        { time: '12:00', value: 3 }
      ];
      ranges.removeRangeStop(arr, 0);
      arr.length.should.equal(2);
      arr[0].time.should.equal('00:00');
      arr[0].value.should.equal(2); // value carried from old index 1
    });

    it('rejects out-of-bounds index without modifying array', function () {
      var arr = [{ time: '00:00', value: 1 }, { time: '06:00', value: 2 }];
      ranges.removeRangeStop(arr, -1);
      ranges.removeRangeStop(arr, 99);
      arr.length.should.equal(2);
    });
  });

  describe('addTargetStop / removeTargetStop', function () {
    it('keeps target_low and target_high in lockstep', function () {
      var lo = [{ time: '00:00', value: 80 }];
      var hi = [{ time: '00:00', value: 140 }];
      ranges.addTargetStop(lo, hi, 1);
      lo.length.should.equal(2);
      hi.length.should.equal(2);
      ranges.removeTargetStop(lo, hi, 1);
      lo.length.should.equal(1);
      hi.length.should.equal(1);
      lo[0].time.should.equal('00:00');
      hi[0].time.should.equal('00:00');
    });
  });
});
