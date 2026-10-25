'use strict';

const assert = require('node:assert/strict');
const {referencesOf, repoFiles, reverseGraph} = require('../scripts/test-select');

describe('Cut 2 test-selection graph', function () {
  const known = new Set(repoFiles());

  it('connects built-bundle tests to every page entry', function () {
    const refs = referencesOf('tests/browser/bundle.test.js', known);
    for (const entry of ['bundle.source', 'bundle.clocks.source', 'bundle.reports.source',
      'bundle.admin.source', 'bundle.profile.source', 'bundle.food.source']) {
      assert.ok(refs.has('bundle/' + entry + '.js'), 'Missing entry: ' + entry);
    }
  });

  it('keeps the narrowed D3 module connected to its browser consumer', function () {
    const refs = referencesOf('lib/client/index.js', known);
    assert.ok(refs.has('lib/d3.mjs'));
    const graph = reverseGraph(['lib/d3.mjs', 'lib/client/index.js']);
    assert.ok(graph.get('lib/d3.mjs').has('lib/client/index.js'));
  });

  it('finds a report change through its dedicated entry and a built-bundle test', function () {
    const graph = reverseGraph(repoFiles());
    const pending = ['lib/report/reportclient.js'], reached = new Set(pending);
    while (pending.length) {
      for (const file of graph.get(pending.shift()) || []) {
        if (!reached.has(file)) {reached.add(file); pending.push(file);}
      }
    }
    assert.ok(reached.has('bundle/bundle.reports.source.js'));
    assert.ok(reached.has('tests/browser/bundle.test.js'));
  });
});
