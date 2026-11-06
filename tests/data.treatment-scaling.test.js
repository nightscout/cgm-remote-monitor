'use strict';

require('should');

var calcDelta = require('../lib/data/calcdelta');

// Characterization and scaling guards for the two treatment hot loops:
//   ddata.processDurations   (lib/data/ddata.js)
//   calcdelta nsArrayTreatments (lib/data/calcdelta.js)
//
// Both were O(n x n) over the treatment window. The behaviour tests below pin the
// semantics that must not change - in particular the `cuttedby` / `cutting` pair,
// which lib/client/renderer.js and lib/report_plugins/daytoday.js render as the
// profile-switch label, and which depends on cutting order.
//
// The scaling tests are deliberately generous: they fail by more than 3x against
// the previous nested scans and pass by more than 100x against the current code,
// so they are a regression guard rather than a benchmark.

function tempBasals (n, stepMs) {
  var out = [];
  for (var i = 0; i < n; i++) {
    out.push({
      _id: String(i).padStart(24, '0'),
      eventType: 'Temp Basal',
      duration: 30,
      absolute: 0.8,
      mills: 1600000000000 + i * (stepMs || 600000)
    });
  }
  return out;
}

describe('treatment duration processing', function ( ) {

  var ddata = require('../lib/data/ddata')();

  // NaN timestamps are the one input where the Set dedup below is not identical to
  // the filter/findIndex it replaced. `===` never matches NaN, so that version kept
  // every NaN-milled event; a Set is SameValueZero, so they collapse to one. This is
  // a return to the older semantics rather than a new divergence - `_.uniqBy` stood
  // here until 9cab9f5a (2025-05-11) and lodash's uniq special-cases NaN.
  //
  // The input is reachable, not hypothetical: ddata.processRawDataForRuntime derives
  // mills from `new Date(created_at).getTime()`, and the v1 REST API stopped
  // validating created_at in 1059232f (2020-09-21, "Remove the validation for
  // created_at in REST API ;("), so an unparseable created_at reaches here as NaN.
  // lib/plugins/timeago.js and the endmills guard in ddata.js both defend against it.
  //
  // Downstream, a surviving NaN is inert in cutIfInInterval - every comparison against
  // NaN is false - but it does make the millsOrder comparator inconsistent, so the
  // binary search in firstAfter loses its sortedness precondition. The damage is
  // one-sided: NaN compares false in firstAfter's test, so the returned index can only
  // be too low, which adds candidates that cutIfInInterval then rejects. Empirically
  // V8's sort leaves the real entries correctly ordered around a single NaN, so the
  // forward scan's `break` still fires in the right place - but that is an observation
  // about V8, not a guarantee, and it is only single-NaN because of the dedup above.
  it('drops later treatments that share a timestamp, keeping the first', function ( ) {
    var mills = 1600000000000;
    var result = ddata.processDurations([
      { _id: 'a', mills: mills, duration: 30, eventType: 'Temp Basal' },
      { _id: 'b', mills: mills, duration: 60, eventType: 'Temp Basal' },
      { _id: 'c', mills: mills + 3600000, duration: 30, eventType: 'Temp Basal' }
    ], false);

    result.length.should.equal(2);
    result[0]._id.should.equal('a');
    result[0].duration.should.equal(30);
    result[1]._id.should.equal('c');
  });

  it('cuts a duration short at the next event and records the cutting pair', function ( ) {
    var mills = 1600000000000;
    var base = { _id: 'base', mills: mills, duration: 60, profile: 'Day', eventType: 'Profile Switch' };
    var next = { _id: 'next', mills: mills + 900000, profile: 'Night', eventType: 'Profile Switch' };

    var result = ddata.processDurations([base, next], true);

    result.length.should.equal(2);
    base.duration.should.equal(15);          // cut from 60 minutes to 15
    base.cuttedby.should.equal('Night');
    next.cutting.should.equal('Day');
  });

  it('ends up cut by the earliest overlapping event whatever the input order', function ( ) {
    var mills = 1600000000000;
    var base = { _id: 'base', mills: mills, duration: 120, profile: 'A', eventType: 'Profile Switch' };
    var late = { _id: 'late', mills: mills + 3600000, profile: 'C', eventType: 'Profile Switch' };
    var early = { _id: 'early', mills: mills + 600000, profile: 'B', eventType: 'Profile Switch' };

    // deliberately out of time order
    ddata.processDurations([base, late, early], true);

    // The surviving duration and `cuttedby` are order-independent: they always
    // describe the earliest event inside the window.
    base.duration.should.equal(10);
    base.cuttedby.should.equal('B');

    // `cutting`, however, is set on EVERY event that successfully cut along the
    // way, so it depends on input order - here `late` cut 120 -> 60 before
    // `early` cut 60 -> 10. This is long-standing behaviour and is pinned here
    // deliberately, because the profile-switch label in lib/client/renderer.js
    // reads it.
    early.cutting.should.equal('A');
    late.cutting.should.equal('A');
  });

  it('leaves an event alone when nothing falls inside its window', function ( ) {
    var mills = 1600000000000;
    var base = { _id: 'base', mills: mills, duration: 30, eventType: 'Temp Basal' };
    var far = { _id: 'far', mills: mills + 7200000, eventType: 'Announcement' };

    ddata.processDurations([base, far], true);

    base.duration.should.equal(30);
    should(base.cuttedby).equal(undefined);
  });

  it('drops zero-duration events unless keepzeroduration is set', function ( ) {
    var mills = 1600000000000;
    var input = function ( ) {
      return [
        { _id: 'a', mills: mills, duration: 30, eventType: 'Temp Basal' },
        { _id: 'b', mills: mills + 7200000, eventType: 'Announcement' }
      ];
    };
    ddata.processDurations(input(), false).length.should.equal(1);
    ddata.processDurations(input(), true).length.should.equal(2);
  });

  it('handles an empty list', function ( ) {
    ddata.processDurations([], false).length.should.equal(0);
    ddata.processDurations([], true).length.should.equal(0);
  });

  // What this fixture does and does not cover. The cost of processDurations is now
  // O(n log n) for the index plus, per base, the number of events inside that base's
  // own window - not n^2. tempBasals() above lays 30-minute durations 10 minutes
  // apart, so each window holds about three events and this measures the sort rather
  // than the window scan. A single long-duration event still collects every event
  // inside it, so a treatment set dominated by long windows degrades back toward
  // quadratic. That is a ceiling this guard does not exercise, not a regression: the
  // previous nested scan visited all n for every base unconditionally, so the new
  // worst case is the old ordinary case.
  //
  // Long windows have real carriers. Nothing clamps `duration` - lib/server/treatments
  // only coerces it with Number() and drops it if NaN - and all three arrays that reach
  // processDurations can carry hours-long events: temp targets (routed through here by
  // db819b5e), profile switches with a duration, and pump-length temp basals.
  it('scales sub-quadratically over a long treatment history', function ( ) {
    this.timeout(30000);
    var treatments = tempBasals(20000);
    var started = Date.now();
    var result = ddata.processDurations(treatments, false);
    var elapsed = Date.now() - started;

    result.length.should.equal(20000);
    // Previous nested scan: ~6000 ms here. Current: ~10 ms.
    elapsed.should.be.below(2000);
  });
});

describe('treatment delta', function ( ) {

  function world (treatments) {
    return {
      sgvs: [{ _id: 's1', mills: 1600000000000, mgdl: 100 }],
      treatments: treatments, mbgs: [], cals: [], devicestatus: [],
      profiles: [{ _id: 'p1', store: {} }], food: [], dbstats: {},
      lastUpdated: 1600000000000
    };
  }

  it('reports adds, updates and removes in input order', function ( ) {
    var older = tempBasals(3);
    var newer = [
      { ...older[0] },
      { ...older[1], absolute: 1.5 },
      { _id: 'newone', mills: 1600000000000 + 99, eventType: 'Bolus', insulin: 1 }
    ];
    var delta = calcDelta(world(older), world(newer));

    // compressArrays sorts each delta array by mills before emitting it, so the
    // expected order is by timestamp rather than by the order changes were found.
    var actions = delta.treatments.map(function (t) { return [t._id, t.action]; });
    actions.should.deepEqual([
      ['newone', undefined],
      [older[1]._id, 'update'],
      [older[2]._id, 'remove']
    ]);
  });

  it('ignores mgdl when deciding whether a treatment changed', function ( ) {
    var older = [{ _id: 'a'.repeat(24), mills: 1600000000000, eventType: 'Bolus', mgdl: 100 }];
    var newer = [{ _id: 'a'.repeat(24), mills: 1600000000000, eventType: 'Bolus', mgdl: 180 }];
    var oldWorld = world(older);
    var newWorld = world(newer);
    // calcDelta returns newData wholesale when nothing changed anywhere, so move
    // an unrelated collection to force a real delta and then assert treatments is
    // absent from it.
    newWorld.sgvs = [{ _id: 's1', mills: 1600000000000, mgdl: 100 },
                     { _id: 's2', mills: 1600000000300, mgdl: 105 }];
    var delta = calcDelta(oldWorld, newWorld);

    delta.delta.should.equal(true);
    delta.sgvs.length.should.equal(1);
    should(delta.treatments).equal(undefined);
  });

  it('scales sub-quadratically over a long treatment history', function ( ) {
    this.timeout(30000);
    var older = tempBasals(20000);
    var newer = older.map(function (t, i) {
      return i % 500 === 0 ? { ...t, absolute: 9 } : { ...t };
    });
    var started = Date.now();
    var delta = calcDelta(world(older), world(newer));
    var elapsed = Date.now() - started;

    delta.treatments.length.should.equal(40);
    // Previous nested scan: well over 10 s here. Current: ~30 ms.
    elapsed.should.be.below(2000);
  });
});
