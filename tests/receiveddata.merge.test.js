'use strict';

/*
 * The client's delta merge. Both functions are exported with the comment
 * "expose for tests" and had none until now.
 *
 * mergeTreatmentUpdate walks the received items against the cached array
 * while splicing and pushing that same array. It captured the cached
 * array's length once, before the walk, so the bound went stale the first
 * time a 'remove' matched - and the next received item that matched nothing
 * read past the end and threw on `undefined._id`.
 *
 * That throw escapes receiveDData into lib/client/index.js dataUpdate, which
 * has no try/catch, so the rest of the socket update is abandoned: the chart
 * stops advancing and treatments stop arriving until the page is reloaded.
 * The time-ago watchdog runs on its own setTimeout chain and is unaffected,
 * so the page does go visibly stale rather than lying about it - but nothing
 * recovers on its own.
 */

require('should');

const receiveDData = require('../lib/client/receiveddata');
const mergeTreatmentUpdate = receiveDData.mergeTreatmentUpdate;
const mergeDataUpdate = receiveDData.mergeDataUpdate;

function ids (array) {
  return array.map(function (r) { return r._id; });
}

function cached ( ) {
  return [{ _id: 'a', mills: 1 }, { _id: 'b', mills: 2 }, { _id: 'c', mills: 3 }];
}

describe('client delta merge', function ( ) {

  describe('mergeTreatmentUpdate', function ( ) {

    it('survives a remove followed by an item that matches nothing', function ( ) {
      // The regression. Before the fix this threw
      // "Cannot read properties of undefined (reading '_id')".
      const out = mergeTreatmentUpdate(true, cached(), [
        { _id: 'a', action: 'remove' }
        , { _id: 'not-in-cache', action: 'update', mills: 9 }
      ]);
      ids(out).should.eql(['b', 'c']);
    });

    it('survives several removes and a miss in any order', function ( ) {
      const out = mergeTreatmentUpdate(true, cached(), [
        { _id: 'c', action: 'remove' }
        , { _id: 'a', action: 'remove' }
        , { _id: 'ghost', action: 'remove' }
        , { _id: 'ghost2', action: 'update', mills: 7 }
      ]);
      ids(out).should.eql(['b']);
    });

    it('removes a matching item', function ( ) {
      ids(mergeTreatmentUpdate(true, cached(), [{ _id: 'b', action: 'remove' }]))
        .should.eql(['a', 'c']);
    });

    it('updates in place and drops the action marker', function ( ) {
      const out = mergeTreatmentUpdate(true, cached(), [
        { _id: 'b', action: 'update', mills: 2, note: 'edited' }
      ]);
      ids(out).should.eql(['a', 'b', 'c']);
      const b = out.filter(function (r) { return r._id === 'b'; })[0];
      b.note.should.equal('edited');
      b.should.not.have.property('action');
    });

    it('appends an item that carries no action', function ( ) {
      ids(mergeTreatmentUpdate(true, cached(), [{ _id: 'new', mills: 4 }]))
        .should.eql(['a', 'b', 'c', 'new']);
    });

    it('returns the cache untouched when there is nothing received', function ( ) {
      const before = cached();
      mergeTreatmentUpdate(true, before, null).should.equal(before);
    });

    it('replaces everything when the update is not a delta', function ( ) {
      const replacement = [{ _id: 'z', mills: 5 }];
      mergeTreatmentUpdate(false, cached(), replacement).should.equal(replacement);
    });

    it('sorts the result by mills', function ( ) {
      const out = mergeTreatmentUpdate(true, cached(), [{ _id: 'early', mills: 0 }]);
      ids(out).should.eql(['early', 'a', 'b', 'c']);
    });
  });

  describe('mergeDataUpdate', function ( ) {
    // This one already reads the bound fresh, and its purge walks backwards.
    // These pin that, so the two functions cannot drift apart again.

    it('purges entries older than the age limit', function ( ) {
      const now = Date.now();
      const out = mergeDataUpdate(true,
        [{ mills: now - 200000 }, { mills: now - 1000 }],
        [], 100000);
      out.length.should.equal(1);
      out[0].mills.should.equal(now - 1000);
    });

    it('purges consecutive old entries without skipping one', function ( ) {
      // A forward walk with splice skips the element after each removal.
      const now = Date.now();
      const out = mergeDataUpdate(true,
        [{ mills: 1 }, { mills: 2 }, { mills: 3 }, { mills: now }],
        [], 100000);
      out.map(function (e) { return e.mills; }).should.eql([now]);
    });

    it('replaces an entry with the same mills rather than adding one', function ( ) {
      const now = Date.now();
      const out = mergeDataUpdate(true,
        [{ mills: now, sgv: 100 }],
        [{ mills: now, sgv: 120 }], 100000);
      out.length.should.equal(1);
      out[0].sgv.should.equal(120);
    });

    it('adds an entry with new mills', function ( ) {
      const now = Date.now();
      const out = mergeDataUpdate(true,
        [{ mills: now - 1000, sgv: 100 }],
        [{ mills: now, sgv: 120 }], 100000);
      out.map(function (e) { return e.sgv; }).should.eql([100, 120]);
    });
  });
});
