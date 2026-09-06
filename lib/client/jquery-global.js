'use strict';

const jquery = require('jquery');

// A function parameter keeps webpack's ProvidePlugin from rewriting this
// deliberate global access into an imported jQuery reference.
function expose(browserGlobal, value) {
  if (typeof browserGlobal.$ === 'undefined') {
    browserGlobal.$ = value;
  } else if (process.env.NODE_ENV === 'development') {
    throw new Error('The "$" value already exists in the browser global scope');
  }
}

// Preserve the loader's production no-overwrite and development collision rules.
expose(window, jquery);
module.exports = jquery;
