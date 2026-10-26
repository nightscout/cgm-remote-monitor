'use strict';

const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const ADAPTERS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'websocket']
  .map(name => 'lib/server/' + name + '.js')
  .concat('lib/api3/storage/mongoCollection/index.js');

function member(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' && !node.computed) return member(node.object) + '.' + member(node.property);
  return '';
}

// This gate covers the known adapter entry points. Runtime matrix assertions
// also prove writes cross the boundary; the AST check alone is not a proof
// that a newly introduced adapter is covered.
function check(source) {
  const ast = babel.parseSync(source, {babelrc: false, configFile: false, sourceType: 'script'});
  let acquisitions = 0;
  const failures = [];
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && ['ctx.store.collection', 'ctx.store.db.collection'].includes(member(node.callee))) {
      acquisitions++;
      if (parent?.type !== 'CallExpression' || member(parent.callee) !== 'writeStep.collection'
        || parent.arguments[0] !== node) failures.push('raw collection escapes the write boundary at line ' + node.loc.start.line);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node));
      else if (value && typeof value.type === 'string') visit(value, node);
    }
  }
  visit(ast);
  if (!acquisitions) failures.push('adapter has no checked collection acquisition');
  return failures;
}

function main() {
  let failed = false;
  for (const file of ADAPTERS) {
    const issues = check(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
    for (const issue of issues) { console.error(file + ': ' + issue); failed = true; }
  }
  if (failed) process.exitCode = 1;
  else console.log('Write boundary: all ' + ADAPTERS.length + ' adapter entry points checked');
}
if (require.main === module) main();
module.exports = {check, ADAPTERS};
