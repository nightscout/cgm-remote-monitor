'use strict';

// D3 7 is ESM. CommonJS/NYC fixtures use the official browser distribution,
// matching the API bundled by webpack without transforming its ESM source.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const filename = path.join(path.dirname(require.resolve('d3')), '../dist/d3.js');
const factory = vm.runInThisContext('(function (module, exports) {' +
  fs.readFileSync(filename, 'utf8') + '\n})', { filename: filename });
factory(module, module.exports);
