'use strict';

/*
 * The bolus calculator's quick-pick chooser.
 *
 * Until now `loadFoodQuickpicks` filtered the food collection into a
 * `quickpicks` array and then built the <option> list from the UNFILTERED
 * collection, giving each option a value that indexed the filtered one. The
 * two arrays only line up when every food record is a quick pick.
 *
 * That is a regression from 3457de5b (2017) which moved the data source from
 * /api/v1/food/quickpicks - where every record WAS a quick pick, so
 * `records` and `quickpicks` were the same array - to the whole food
 * collection, and moved the filter into a separate pass without moving the
 * loop with it.
 *
 * These tests read which record the change handler actually resolves, via a
 * getter on `foods`, rather than through the calculator's GUI - the point is
 * the identity of the record, not the arithmetic done with it.
 */

const should = require('should');
const { createSecureDOM } = require('./fixtures/secure-jsdom');

const quickpick = require('../lib/food/quickpick');

describe('boluscalc quick-pick chooser', function ( ) {
  let env, $, boluscalc, client, resolved;

  function quickpickRecord (id, name, carbs, extra) {
    const record = Object.assign({
      _id: id, type: 'quickpick', name: name, carbs: carbs, position: carbs
    }, extra || { });
    const foods = [{ name: name + ' item', carbs: carbs, portion: 1, portions: 1 }];
    // Reading `.foods` is exactly what quickpickChange does with the record
    // it resolved, so this names the record without going near the GUI.
    Object.defineProperty(record, 'foods', {
      enumerable: true,
      get: function ( ) { resolved.push(name); return foods; }
    });
    return record;
  }

  function options ( ) {
    return $('#bc_quickpick option').toArray().map(function (o) {
      return { value: o.value, label: o.textContent };
    });
  }

  function pickLabelled (pattern) {
    // Select by LABEL, never by index - an index would assume the very
    // mapping these tests exist to check.
    const hit = options().filter(function (o) { return pattern.test(o.label); })[0];
    should.exist(hit, 'no option labelled ' + pattern);
    $('#bc_quickpick').val(hit.value);
    $('#bc_quickpick').trigger('change');
    return hit;
  }

  // jsdom globals are process-wide, and jquery binds to whichever window was
  // global when it was first required. A suite that leaves either behind
  // breaks every later client test in the run - which is how this one first
  // announced itself.
  var priorWindow, priorDocument, priorNavigator;

  afterEach(function ( ) {
    delete require.cache[require.resolve('jquery')];
    delete require.cache[require.resolve('../lib/client/boluscalc')];
    if (env) env.cleanup();
    if (priorWindow) { Object.defineProperty(global, 'window', priorWindow); } else { delete global.window; }
    if (priorDocument) { Object.defineProperty(global, 'document', priorDocument); } else { delete global.document; }
    if (priorNavigator) { Object.defineProperty(global, 'navigator', priorNavigator); }
  });

  beforeEach(function ( ) {
    priorWindow = Object.getOwnPropertyDescriptor(global, 'window');
    priorDocument = Object.getOwnPropertyDescriptor(global, 'document');
    priorNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
    resolved = [];
    env = createSecureDOM('<!DOCTYPE html><html><body>'
      + '<select id="bc_quickpick"></select>'
      + '</body></html>');
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: env.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: env.window.document });
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: env.window.navigator });
    $ = require('jquery');

    client = {
      translate: function (s) { return s; }
      , plugins: function ( ) { return { }; }
      , settings: { enable: [], extendedSettings: { }, units: 'mg/dl' }
      , sbx: { data: { food: [] } }
      , ctx: { moment: require('moment') }
      , utils: { }
      , headers: function ( ) { return { }; }
    };
    boluscalc = require('../lib/client/boluscalc')(client, $);
    // The chooser is what is under test; keep the insulin arithmetic and the
    // DOM it needs out of it.
    boluscalc.calculateInsulin = function ( ) { };
  });

  it('offers only quick picks, not every food in the database', function ( ) {
    client.sbx.data.food = [
      { _id: '1', type: 'food', name: 'Apple', carbs: 12 }
      , quickpickRecord('2', 'Breakfast', 45)
      , quickpickRecord('3', 'Lunch', 70)
    ];
    boluscalc.loadFoodQuickpicks();

    const labels = options().map(function (o) { return o.label; });
    labels.should.eql(['(none)', 'Breakfast (45 g)', 'Lunch (70 g)']);
    labels.should.not.containEql('Apple (12 g)');
  });

  it('resolves the quick pick it names, with a plain food in the collection', function ( ) {
    client.sbx.data.food = [
      { _id: '1', type: 'food', name: 'Apple', carbs: 12 }
      , quickpickRecord('2', 'Breakfast', 45)
      , quickpickRecord('3', 'Lunch', 70)
    ];
    boluscalc.loadFoodQuickpicks();

    pickLabelled(/Breakfast/);
    // The handler may read `.foods` more than once; the question is WHICH
    // record it read, never how many times.
    Array.from(new Set(resolved)).should.eql(['Breakfast'],
      'picking "Breakfast" must load Breakfast, not its neighbour');
  });

  it('resolves the last quick pick rather than throwing', function ( ) {
    client.sbx.data.food = [
      { _id: '1', type: 'food', name: 'Apple', carbs: 12 }
      , quickpickRecord('2', 'Breakfast', 45)
      , quickpickRecord('3', 'Lunch', 70)
    ];
    boluscalc.loadFoodQuickpicks();

    // Before the fix this threw "Cannot read properties of undefined
    // (reading 'foods')" - the chooser was simply broken for the last entry.
    pickLabelled(/Lunch/);
    Array.from(new Set(resolved)).should.eql(['Lunch']);
  });

  it('leaves hidden quick picks out of the chooser, in either spelling', function ( ) {
    client.sbx.data.food = [
      quickpickRecord('1', 'Visible', 10)
      , quickpickRecord('2', 'HiddenBoolean', 20, { hidden: true })
      , quickpickRecord('3', 'HiddenString', 30, { hidden: 'true' })
      , quickpickRecord('4', 'NotHiddenString', 40, { hidden: 'false' })
      , quickpickRecord('5', 'NoFlagAtAll', 50)
    ];
    boluscalc.loadFoodQuickpicks();

    options().map(function (o) { return o.label; }).should.eql([
      '(none)', 'Visible (10 g)', 'NotHiddenString (40 g)', 'NoFlagAtAll (50 g)'
    ]);
  });

  it('orders the chooser by position numerically, whichever type it was stored as', function ( ) {
    client.sbx.data.food = [
      quickpickRecord('a', 'Tenth', 1, { position: '10' })
      , quickpickRecord('b', 'Second', 2, { position: 2 })
      , quickpickRecord('c', 'First', 3, { position: '1' })
    ];
    boluscalc.loadFoodQuickpicks();

    // A lexicographic order would put '10' between '1' and '2'.
    options().map(function (o) { return o.label; }).should.eql([
      '(none)', 'First (3 g)', 'Second (2 g)', 'Tenth (1 g)'
    ]);
  });

  it('copes with an empty or absent food collection', function ( ) {
    client.sbx.data.food = [];
    boluscalc.loadFoodQuickpicks();
    options().map(function (o) { return o.label; }).should.eql(['(none)']);

    delete client.sbx.data.food;
    boluscalc.loadFoodQuickpicks();
    options().map(function (o) { return o.label; }).should.eql(['(none)']);
  });
});

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
