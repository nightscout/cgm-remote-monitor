'use strict';

/*
 * The bolus calculator's quick-pick chooser follows the food data the page
 * holds when the drawer is opened.
 *
 * The client constructs the calculator against an EMPTY sandbox
 * (lib/client/index.js creates client.sbx before any data has arrived, then
 * replaces it once the first data update lands). The chooser used to be built
 * exactly once, at construction, so it offered "(none)" and nothing else for
 * the life of the page, while "Add food from database" - which reads the
 * sandbox at click time - worked.
 *
 * These tests construct the calculator the same way (empty food), then
 * REPLACE client.sbx the way the client does, and open the drawer through its
 * own toggle. Records are named through a getter on `foods`, the property the
 * change handler reads, as tests/boluscalc.quickpick.test.js does: the
 * question is which record was resolved, not what was computed from it.
 */

const should = require('should');
const { createSecureDOM } = require('./fixtures/secure-jsdom');

describe('boluscalc quick-pick chooser rebuilds from the food data at open', function ( ) {
  let env, $, boluscalc, client, resolved;

  function quickpickRecord (id, name, carbs, extra) {
    const record = Object.assign({
      _id: id, type: 'quickpick', name: name, carbs: carbs, position: carbs
    }, extra || { });
    const foods = [{ name: name + ' item', carbs: carbs, portion: 1, portions: 1 }];
    Object.defineProperty(record, 'foods', {
      enumerable: true,
      get: function ( ) { resolved.push(name); return foods; }
    });
    return record;
  }

  function plainFood (id, name, carbs) {
    return { _id: id, type: 'food', name: name, carbs: carbs, portion: 1 };
  }

  // What index.js does when data arrives: a NEW sandbox object, not a mutation
  // of the one the calculator was constructed against.
  function dataArrives (food) {
    client.sbx = {
      data: { food: food }
      , lastSGVEntry: function ( ) { return null; }
    };
  }

  function options ( ) {
    return $('#bc_quickpick option').toArray().map(function (o) {
      return { value: o.value, label: o.textContent };
    });
  }

  function labels ( ) {
    return options().map(function (o) { return o.label; });
  }

  function pickLabelled (pattern) {
    const hit = options().filter(function (o) { return pattern.test(o.label); })[0];
    should.exist(hit, 'no option labelled ' + pattern + ' among ' + JSON.stringify(labels()));
    $('#bc_quickpick').val(hit.value);
    $('#bc_quickpick').trigger('change');
    return hit;
  }

  function openDrawer ( ) {
    // The user's action: the toggle button's own handler.
    $('#boluscalcDrawerToggle').trigger('click');
  }

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
      + '<a id="boluscalcDrawerToggle" href="#">Bolus Wizard</a>'
      + '<select id="bc_quickpick"></select>'
      + '</body></html>');
    Object.defineProperty(global, 'window', { configurable: true, writable: true, value: env.window });
    Object.defineProperty(global, 'document', { configurable: true, writable: true, value: env.window.document });
    Object.defineProperty(global, 'navigator', { configurable: true, writable: true, value: env.window.navigator });
    $ = require('jquery');

    const moment = require('moment');
    client = {
      translate: function (s) { return s; }
      , plugins: function ( ) { return { }; }
      , settings: { enable: [], extendedSettings: { }, units: 'mg/dl' }
      , sbx: { data: { food: [] } }   // the empty sandbox the client starts with
      , ctx: { moment: moment }
      , utils: { mergeInputTime: function ( ) { return moment(); } }
      , headers: function ( ) { return { }; }
      , profilefunctions: {
        listBasalProfiles: function ( ) { return []; }
        , activeProfileToTime: function ( ) { return ''; }
      }
      , browserUtils: {
        toggleDrawer: function ( ) { }
        , closeDrawer: function ( ) { }
        , getLastOpenedDrawer: null
      }
    };
    boluscalc = require('../lib/client/boluscalc')(client, $);
    boluscalc.calculateInsulin = function ( ) { };
  });

  it('starts empty, because it is constructed before any food has arrived', function ( ) {
    labels().should.eql(['(none)']);
  });

  it('offers the quick picks that arrived after construction when the drawer opens', function ( ) {
    dataArrives([
      quickpickRecord('2', 'Breakfast', 45)
      , quickpickRecord('3', 'Lunch', 70)
    ]);
    openDrawer();
    labels().should.eql(['(none)', 'Breakfast (45 g)', 'Lunch (70 g)']);
  });

  it('follows a change to the food data between two openings', function ( ) {
    dataArrives([quickpickRecord('2', 'Breakfast', 45), quickpickRecord('3', 'Lunch', 70)]);
    openDrawer();
    dataArrives([quickpickRecord('3', 'Lunch', 70), quickpickRecord('4', 'Dinner', 80)]);
    openDrawer();
    labels().should.eql(['(none)', 'Lunch (70 g)', 'Dinner (80 g)']);
  });

  it('resolves the quick pick it names after the rebuild, with plain foods in the collection (BF-35)', function ( ) {
    dataArrives([
      plainFood('1', 'Apple', 12)
      , quickpickRecord('2', 'Breakfast', 45)
      , plainFood('5', 'Bread', 15)
      , quickpickRecord('3', 'Lunch', 70)
    ]);
    openDrawer();
    labels().should.eql(['(none)', 'Breakfast (45 g)', 'Lunch (70 g)']);

    pickLabelled(/^Lunch/);
    Array.from(new Set(resolved)).should.eql(['Lunch']);
    resolved = [];
    pickLabelled(/^Breakfast/);
    Array.from(new Set(resolved)).should.eql(['Breakfast']);
  });

  it('keeps hidden quick picks out of the rebuilt chooser, in either spelling', function ( ) {
    dataArrives([
      quickpickRecord('1', 'Visible', 10)
      , quickpickRecord('2', 'HiddenBoolean', 20, { hidden: true })
      , quickpickRecord('3', 'HiddenString', 30, { hidden: 'true' })
    ]);
    openDrawer();
    labels().should.eql(['(none)', 'Visible (10 g)']);
  });

  it('does not offer a quick pick hidden since the last opening', function ( ) {
    // What quickpickHideFood leaves behind for a hide-after-use pick: the
    // record in the page's own data marked hidden, before any echo from the
    // server.
    const breakfast = quickpickRecord('2', 'Breakfast', 45, { hideafteruse: true });
    dataArrives([breakfast, quickpickRecord('3', 'Lunch', 70)]);
    openDrawer();
    labels().should.eql(['(none)', 'Breakfast (45 g)', 'Lunch (70 g)']);
    breakfast.hidden = true;
    openDrawer();
    labels().should.eql(['(none)', 'Lunch (70 g)']);
  });

  it('opens with nothing selected, whatever was selected before', function ( ) {
    dataArrives([quickpickRecord('2', 'Breakfast', 45), quickpickRecord('3', 'Lunch', 70)]);
    openDrawer();
    pickLabelled(/^Lunch/);
    openDrawer();
    $('#bc_quickpick').val().should.equal('-1');
  });

  it('binds the change handler once, however often the drawer opens', function ( ) {
    dataArrives([quickpickRecord('2', 'Breakfast', 45)]);
    openDrawer(); openDrawer(); openDrawer();
    const events = $._data($('#bc_quickpick')[0], 'events') || { };
    (events.change || []).length.should.equal(1);
  });
});
