'use strict';

// Gate G2 of the write contract (write-contract spec §5), for the modules
// already enrolled in the write step (lib/storage/write-intent.js): such a
// module writes only through write(intent). It must not call a write method
// of the storage interface or of the driver, and must not use the v1 write
// helpers (lib/server/storage-writes.js) the step replaced.
//
// scripts/check-write-boundary.js is the neighbouring gate one layer down:
// every write crosses the persistence boundary (lib/storage/write-step.js).
// This one says which writes go through the step above the interface. A
// module joins ENROLLED in the commit that routes its writes through the step.

const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');

const ENROLLED = ['lib/server/food.js', 'lib/server/activity.js'];

// The driver's write methods, the storage interface's
// (lib/api3/storage/mongoCollection/index.js) and lib/server/storage-writes.js's.
const WRITES = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'bulkWrite', 'bulkUpsert', 'replaceFiltered', 'deleteManyOr',
  'updateEveryForm', 'deleteEveryForm']);

function walk (node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, fn));
    else if (value && typeof value.type === 'string') walk(value, fn);
  }
}

function check (source) {
  const ast = babel.parseSync(source, { babelrc: false, configFile: false, sourceType: 'script' });
  const failures = [];
  walk(ast, function visit (node) {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type === 'Identifier' && callee.name === 'require'
      && typeof node.arguments[0]?.value === 'string' && /\/storage-writes(\.js)?$/.test(node.arguments[0].value)) {
      failures.push('requires the v1 write helpers instead of the write step at line ' + node.loc.start.line);
    }
    if (callee.type === 'MemberExpression' && !callee.computed && WRITES.has(callee.property.name)) {
      failures.push('write ' + callee.property.name + ' bypasses write(intent) at line ' + node.loc.start.line);
    }
  });
  return failures;
}

function main () {
  let failed = false;
  for (const file of ENROLLED) {
    for (const issue of check(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'))) {
      console.error(file + ': ' + issue);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('Write intent: ' + ENROLLED.length + ' enrolled module(s) write only through write(intent)');
}
if (require.main === module) main();
module.exports = { check, ENROLLED };
