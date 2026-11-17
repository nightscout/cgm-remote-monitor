'use strict';

// Loads the jQuery UI widgets the page bundle ships into a test DOM's jQuery.
//
// The widget list is read from bundle/bundle.source.js, so a test sees the
// widgets the page loads and no others. jquery-ui 1.14 modules are AMD or
// browser-global only: webpack resolves their AMD dependencies and Node's
// require does not, so each module runs here with a small define() that loads
// its dependencies first. "jquery" is the jQuery passed in.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const UI = path.dirname(require.resolve('jquery-ui/ui/widget'));

function bundledWidgets () {
  const source = fs.readFileSync(path.join(ROOT, 'bundle/bundle.source.js'), 'utf8');
  const widgets = [];
  const re = /require\(\s*'jquery-ui\/ui\/(widgets\/[\w-]+)'\s*\)/g;
  let match;
  while ((match = re.exec(source))) widgets.push(match[1]);
  return widgets;
}

module.exports = function loadJqueryUiWidgets ($) {
  const loaded = new Map();
  function load (file) {
    if (loaded.has(file)) return loaded.get(file);
    loaded.set(file, undefined);
    let deps = [];
    let factory;
    function define (d, f) {
      if (typeof d === 'function') { factory = d; } else { deps = d; factory = f; }
    }
    define.amd = true;
    // eslint-disable-next-line no-new-func
    new Function('define', 'jQuery', fs.readFileSync(file, 'utf8'))(define, $);
    const values = deps.map(dep => dep === 'jquery' ? $ : load(path.resolve(path.dirname(file), dep + '.js')));
    const value = typeof factory === 'function' ? factory.apply(null, values) : undefined;
    loaded.set(file, value);
    return value;
  }
  const widgets = bundledWidgets();
  if (!widgets.length) throw new Error('bundle/bundle.source.js loads no jquery-ui widgets');
  widgets.forEach(widget => load(path.join(UI, widget + '.js')));
  return widgets;
};
