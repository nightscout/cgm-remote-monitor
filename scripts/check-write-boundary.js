'use strict';

const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const ADAPTERS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'websocket']
  .map(name => 'lib/server/' + name + '.js')
  .concat('lib/api3/storage/mongoCollection/index.js', 'lib/authorization/storage.js');
const WRITES = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne',
  'updateMany', 'deleteOne', 'deleteMany', 'bulkWrite']);

function member(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' && !node.computed) return member(node.object) + '.' + member(node.property);
  return '';
}

function requires(node, suffix) {
  return node?.type === 'CallExpression' && member(node.callee) === 'require'
    && typeof node.arguments[0]?.value === 'string' && node.arguments[0].value.endsWith(suffix);
}

function isWriteStep(node) {
  return node?.type === 'CallExpression' && member(node.callee) === 'writeStep.collection';
}

function walk(node, parent, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, node, fn));
    else if (value && typeof value.type === 'string') walk(value, node, fn);
  }
}

// This gate covers the known adapter entry points. Runtime matrix assertions
// also prove writes cross the boundary; the AST check alone is not a proof
// that a newly introduced adapter is covered.
//
// An adapter acquires a collection in one of two ways, and each counts:
// - the driver collection (ctx.store.collection / ctx.store.db.collection),
//   only as the first argument of writeStep.collection;
// - the storage interface (lib/server/storage-reads.js collection(), or
//   api3's MongoCollection), whose every write goes through writeStep.collection
//   inside lib/api3/storage/mongoCollection/index.js, itself an adapter here.
// A write method called on a write-step handle in an adapter is a write that
// bypasses the storage interface, and fails the gate.
function check(source) {
  const ast = babel.parseSync(source, {babelrc: false, configFile: false, sourceType: 'script'});
  let acquisitions = 0;
  const failures = [];
  const interfaces = new Set();
  const constructors = new Set();
  const handleFunctions = new Set();
  const handleVariables = new Set();
  walk(ast, null, function bindings(node) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      if (requires(node.init, '/storage-reads')) interfaces.add(node.id.name);
      if (requires(node.init, '/mongoCollection')) constructors.add(node.id.name);
      if (isWriteStep(node.init)) handleVariables.add(node.id.name);
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && isWriteStep(node.right)) {
      handleVariables.add(node.left.name);
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      walk(node.body, null, function returned(inner) {
        if (inner.type === 'ReturnStatement' && isWriteStep(inner.argument)) handleFunctions.add(node.id.name);
      });
    }
  });
  walk(ast, null, function visit(node, parent) {
    if (node.type === 'CallExpression' && ['ctx.store.collection', 'ctx.store.db.collection'].includes(member(node.callee))) {
      acquisitions++;
      if (!isWriteStep(parent) || parent.arguments[0] !== node) {
        failures.push('raw collection escapes the write boundary at line ' + node.loc.start.line);
      }
    }
    if ((node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && interfaces.has(member(node.callee.object)) && member(node.callee.property) === 'collection')
      || (node.type === 'NewExpression' && constructors.has(member(node.callee)))) {
      acquisitions++;
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed
      && WRITES.has(node.callee.property.name)) {
      const target = node.callee.object;
      if (isWriteStep(target) || (target.type === 'Identifier' && handleVariables.has(target.name))
        || (target.type === 'CallExpression' && target.callee.type === 'Identifier' && handleFunctions.has(target.callee.name))) {
        failures.push('write bypasses the storage interface at line ' + node.loc.start.line);
      }
    }
  });
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
