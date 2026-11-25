'use strict';
const assert = require('node:assert/strict');
function brokenModule (file, needle, replacement) {
  const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
  const name = require.resolve(file, { paths: [require('node:path').join(__dirname, '../../')] }), source = fs.readFileSync(name, 'utf8');assert.equal(source.split(needle).length, 2);
  const loaded = { exports: {} };vm.runInThisContext('(function(require,module,exports){' + source.replace(needle, replacement) + '\n})', { filename: name })(createRequire(name), loaded, loaded.exports);return loaded.exports;
}
module.exports = brokenModule;
