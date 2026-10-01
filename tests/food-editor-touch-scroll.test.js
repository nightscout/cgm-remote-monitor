'use strict';

/*
 * On a phone, the Food Editor's food list and quick picks could not be
 * scrolled by touch (#8192). jQuery UI marks each draggable food row with
 * .ui-draggable-handle and each sortable quick pick with .ui-sortable-handle,
 * and its stylesheet gives both touch-action: none, so a swipe that starts on
 * one of them does not scroll.
 *
 * jsdom does not compute touch-action, so these tests build the page from
 * views/foodindex.html, run the real food.js with jQuery UI, and resolve the
 * touch-action cascade over the page's own stylesheets in the page's order.
 */

// Filesystem paths are repository files named by the view and the bundle entry.
/* eslint-disable security/detect-non-literal-fs-filename */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const createSecureDOM = require('./fixtures/secure-jsdom').createSecureDOM;
const domGlobals = require('./fixtures/dom-globals');

const ROOT = path.join(__dirname, '..');
const VIEW = fs.readFileSync(path.join(ROOT, 'views/foodindex.html'), 'utf8');

// The view's <link> stylesheets in document order, then the CSS the bundle
// injects at the end of <head>.
function pageStylesheets () {
  const linked = (VIEW.match(/<link\b[^>]*>/g) || [])
    .filter(function isStyle (tag) { return /\bas="style"|\brel="stylesheet"/.test(tag); })
    .map(function staticPath (tag) { return path.join('static', /\bhref="([^"]+)"/.exec(tag)[1]); });
  const bundled = (fs.readFileSync(path.join(ROOT, 'bundle/bundle.source.js'), 'utf8')
    .match(/^import '\.\.\/(static\/css\/[^']+)';/gm) || [])
    .map(function importPath (line) { return /'\.\.\/([^']+)'/.exec(line)[1]; });
  return linked.concat(bundled).map(function load (file) {
    return { file: file, css: fs.readFileSync(path.join(ROOT, file), 'utf8') };
  });
}

// [ids, classes + attributes + pseudo-classes, types], enough for these sheets.
function specificity (selector) {
  const count = function (re) { return (selector.match(re) || []).length; };
  return [
    count(/#[\w-]+/g)
    , count(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g)
    , count(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/gi)
  ];
}

function outranks (a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// The touch-action a browser applies to the element: the matching declaration
// with the highest importance, then specificity, then document order.
function touchAction (element, sheets) {
  let winner = { value: 'auto', rank: [-1], from: 'initial value' };
  let order = 0;
  sheets.forEach(function eachSheet (sheet) {
    postcss.parse(sheet.css, { from: sheet.file }).walkDecls('touch-action', function eachDecl (decl) {
      order++;
      if (decl.parent.type !== 'rule') return;
      decl.parent.selectors.forEach(function eachSelector (selector) {
        if (!element.matches(selector)) return;
        const rank = [decl.important ? 1 : 0].concat(specificity(selector), order);
        if (outranks(rank, winner.rank)) {
          winner = { value: decl.value, rank: rank, from: sheet.file + ' ' + selector };
        }
      });
    });
  });
  return winner;
}

// touch-action is not inherited, but a browser only pans in a direction that
// every element from the touched one up allows. On a phone the page is wider
// than the screen, so both directions matter. Returns where the first
// restriction on that path comes from, or null.
function panBlockedBy (element, sheets) {
  for (let el = element; el && el.nodeType === 1; el = el.parentElement) {
    const winner = touchAction(el, sheets);
    const both = winner.value === 'auto' || winner.value === 'manipulation'
      || (/\bpan-x\b/.test(winner.value) && /\bpan-y\b/.test(winner.value));
    if (!both) return (el.id ? '#' + el.id : el.className) + ': ' + winner.from + ' { touch-action: ' + winner.value + ' }';
  }
  return null;
}

function foodRecord (name, carbs) {
  return {
    _id: 'food-' + name, type: 'food', category: 'Fruit', subcategory: 'Fresh'
    , name: name, portion: 100, carbs: carbs, fat: 0, protein: 1, energy: 200, gi: 2, unit: 'g'
  };
}

describe('food editor: touch scrolling (#8192)', function () {
  let env;
  let state;
  let $;
  let priorOption;

  beforeEach(function () {
    delete global.window;
    delete global.document;
    // createSecureDOM does not run scripts, so the view's <script> tags stay inert
    const body = /<body>([\s\S]*)<\/body>/.exec(VIEW)[1].replace(/<%[\s\S]*?%>/g, '');
    env = createSecureDOM('<!DOCTYPE html><html><body>' + body + '</body></html>');
    state = domGlobals.installDomGlobals(env);
    delete require.cache[require.resolve('jquery-ui-bundle')];
    require('jquery-ui-bundle');
    $ = env.window.$;

    const records = [foodRecord('Apple', 12), foodRecord('Banana', 23), foodRecord('Bread', 45)]
      .concat([0, 1].map(function quickpickRecord (position) {
        return {
          _id: 'qp-' + position, type: 'quickpick', name: 'Meal ' + position, carbs: 12
          , foods: [Object.assign(foodRecord('Apple', 12), { portions: 1 })]
          , hideafteruse: false, hidden: false, position: position
        };
      }));
    $.ajax = function foodAjax (url, options) {
      assert.equal(url, '/api/v1/food.json');
      options.success(records);
      return { done: function done (callback) { callback(); return this; } };
    };
    env.window.Nightscout = {
      client: {
        init: function init (callback) { callback(); }
        , headers: function headers () { return {}; }
        , translate: function translate (text) { return text; }
      }
    };
    // food.js builds <option>s with the global Option constructor
    priorOption = Object.getOwnPropertyDescriptor(global, 'Option');
    global.Option = env.window.Option;
    // and logs the records it loads and the form it fills
    const log = console.log;
    const info = console.info;
    console.log = console.info = function quiet () {};
    try {
      delete require.cache[require.resolve('../lib/food/food')];
      require('../lib/food/food')();
    } finally {
      console.log = log;
      console.info = info;
    }
  });

  afterEach(function () {
    delete require.cache[require.resolve('../lib/food/food')];
    delete require.cache[require.resolve('jquery-ui-bundle')];
    if (priorOption) Object.defineProperty(global, 'Option', priorOption);
    else delete global.Option;
    domGlobals.restoreDomGlobals(state);
  });

  it('draws the food rows and quick picks with jQuery UI\'s drag handles', function () {
    const rows = env.document.querySelectorAll('#fe_data .draggablefood');
    const quickpicks = env.document.querySelectorAll('#fe_picklist .sortablequickpick');
    assert.equal(rows.length, 3);
    assert.equal(quickpicks.length, 2);
    rows.forEach(function (row) { assert.ok(row.classList.contains('ui-draggable-handle'), row.className); });
    quickpicks.forEach(function (qp) { assert.ok(qp.classList.contains('ui-sortable-handle'), qp.className); });
  });

  it('lets a swipe that starts on a food row scroll the list, or the page sideways', function () {
    const cell = env.document.querySelector('#fe_data .draggablefood .width200px');
    assert.equal(cell.textContent, 'Apple');
    assert.equal(panBlockedBy(cell, pageStylesheets()), null);
  });

  it('lets a swipe that starts on a quick pick scroll the page either way', function () {
    const sheets = pageStylesheets();
    const quickpick = env.document.querySelector('#fe_picklist .sortablequickpick');
    assert.equal(panBlockedBy(quickpick.querySelector('legend'), sheets), null);
    assert.equal(panBlockedBy(quickpick.querySelector('.fe_foodinsideqp .width200px'), sheets), null);
  });

  it('control: a drag handle outside the food editor keeps jQuery UI\'s touch-action: none', function () {
    const handle = env.document.createElement('div');
    handle.className = 'ui-draggable-handle';
    env.document.body.appendChild(handle);
    const winner = touchAction(handle, pageStylesheets());
    assert.equal(winner.value, 'none');
    assert.equal(winner.from, 'static/css/ui-darkness/jquery-ui.min.css .ui-draggable-handle');
  });
});
