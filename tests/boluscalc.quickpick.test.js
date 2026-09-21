'use strict';

require('should');
const quickpick = require('../lib/food/quickpick');

describe('lib/food/quickpick', function ( ) {
  describe('isTrue', function ( ) {
    it('accepts both spellings of true and nothing else', function ( ) {
      quickpick.isTrue(true).should.equal(true);
      quickpick.isTrue('true').should.equal(true);
      [false, 'false', undefined, null, 0, 1, '', 'yes', 'TRUE'].forEach(function (v) {
        quickpick.isTrue(v).should.equal(false, JSON.stringify(v));
      });
    });
  });

  describe('isHidden', function ( ) {
    it('treats an absent flag as not hidden', function ( ) {
      quickpick.isHidden({ }).should.equal(false);
      quickpick.isHidden(null).should.equal(false);
      quickpick.isHidden({ hidden: 'false' }).should.equal(false);
      quickpick.isHidden({ hidden: true }).should.equal(true);
      quickpick.isHidden({ hidden: 'true' }).should.equal(true);
    });
  });

  describe('positionOf', function ( ) {
    it('reads a position out of either type, and sorts an unusable one last', function ( ) {
      quickpick.positionOf({ position: 3 }).should.equal(3);
      quickpick.positionOf({ position: '3' }).should.equal(3);
      quickpick.positionOf({ }).should.equal(Number.MAX_SAFE_INTEGER);
      quickpick.positionOf({ position: 'later' }).should.equal(Number.MAX_SAFE_INTEGER);
      quickpick.positionOf(null).should.equal(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('selectable', function ( ) {
    it('is empty for no input rather than throwing', function ( ) {
      quickpick.selectable(undefined).should.eql([]);
      quickpick.selectable(null).should.eql([]);
      quickpick.selectable([]).should.eql([]);
    });

    it('does not mutate the array it was given', function ( ) {
      const records = [
        { type: 'quickpick', name: 'B', position: 2 }
        , { type: 'quickpick', name: 'A', position: 1 }
      ];
      quickpick.selectable(records);
      records.map(function (r) { return r.name; }).should.eql(['B', 'A']);
    });
  });
});
