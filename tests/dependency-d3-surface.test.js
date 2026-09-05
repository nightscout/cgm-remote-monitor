'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const d3 = require('../lib/d3.mjs');

function files(directory) {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? files(filename) : /\.(?:js|mjs)$/.test(filename) ? [filename] : [];
  });
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  Object.values(node).forEach(value => {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  });
}

describe('D3 browser surface coverage', function () {
  it('exports every statically accessed application D3 API', function () {
    let accesses = 0;
    for (const filename of files(path.resolve(__dirname, '../lib'))) {
      const tree = espree.parse(fs.readFileSync(filename, 'utf8'), {ecmaVersion: 2020, sourceType: 'module', loc: true});
      walk(tree, node => {
        if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier' || node.object.name !== 'd3') return;
        const name = node.computed ? node.property.value : node.property.name;
        assert.equal(typeof name, 'string', filename + ':' + node.loc.start.line + ': dynamic D3 lookup requires explicit review');
        assert.equal(typeof d3[name], 'function', filename + ':' + node.loc.start.line + ': missing D3 API ' + name);
        accesses++;
      });
    }
    assert.ok(accesses > 50, 'Expected to inspect actual chart and report consumers');
  });
  it('keeps unused D3 subsystems out of the production source map', function () {
    const map = JSON.parse(fs.readFileSync(path.resolve(__dirname,
      '../node_modules/.cache/_ns_cache/public/js/bundle.app.js.map'), 'utf8'));
    assert.ok(map.sources.some(source => source.includes('/d3-selection/')), 'Expected production D3 selections');
    for (const removed of ['chord', 'contour', 'delaunay', 'dsv', 'fetch', 'force', 'geo', 'hierarchy', 'polygon', 'quadtree', 'random', 'scale-chromatic']) {
      assert.ok(!map.sources.some(source => source.includes('/d3-' + removed + '/')),
        'Unused D3 subsystem returned to the browser bundle: ' + removed);
    }
  });

});
