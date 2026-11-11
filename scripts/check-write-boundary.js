'use strict';

const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const ADAPTERS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'socket-write-handlers']
  .map(name => 'lib/server/' + name + '.js')
  .concat('lib/api3/storage/mongoCollection/index.js', 'lib/authorization/storage.js');
const socketIntent = require('./check-write-intent');
const SOCKET_WRAPPER = 'lib/server/websocket.js';
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

// The wrapper delegates acquisition to the canonical handlers. It must retain
// that binding and contain no direct writes; absence of an acquisition is valid
// only for this separately checked delegating module.
function checkSocketWrapper(source) {
  return socketIntent.checkSocketBinding(source).concat(socketIntent.check(source));
}

// Decision write-clock-complete: every supported PostgreSQL write that changes
// evaluated or displayed input advances the tenant write clock in the same
// transaction. The clinical writer is the one module every domain's storage
// port writes through (postgres-collection-intent.js, postgres-entries-intent.js,
// tenant-socket-order-port.js all build on it). Each function there that issues
// a mutating statement must call recordWrite (srv-dates) itself; a DELETE needs
// recordWrite({ deleted: true }). Every other PostgreSQL storage module that
// issues mutating SQL is listed with what it writes, so a new writer fails here
// until it is classified.
const CLOCK_WRITERS = ['lib/storage/postgres-entries-write.js'];
const CLOCK_EXEMPT = {
  'lib/storage/postgres-write-clock.js': 'the clock row itself',
  'lib/storage/postgres-durable-replay.js': "a consumer's own checkpoint, not clinical input"
};
function staticText(node) {
  if (!node) return '';
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked).join(' ');
  if (node.type === 'BinaryExpression' && node.operator === '+') return staticText(node.left) + ' ' + staticText(node.right);
  return '';
}
// A statement mutates when it starts with INSERT/UPDATE/DELETE, or a WITH
// clause holds one (`x AS (DELETE FROM ...)`). Comments, quoted literals (such
// as privilege names) and row-lock clauses are not statements.
function mutation(text) {
  const sql = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'[^']*'/g, "''").replace(/FOR\s+(NO\s+KEY\s+)?UPDATE/gi, ' ');
  const found = /^\s*(INSERT|UPDATE|DELETE)\b/i.exec(sql) || /\bAS\s*\(\s*(INSERT|UPDATE|DELETE)\b/i.exec(sql);
  return found ? found[1].toUpperCase() : null;
}
function checkClock(source) {
  const ast = babel.parseSync(source, {babelrc: false, configFile: false, sourceType: 'script'});
  const failures = [];
  let statements = 0;
  walk(ast, null, function functions(node) {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod'].includes(node.type)) return;
    const name = node.id?.name || node.key?.name || 'anonymous function';
    const kinds = [], records = [];
    (function own(inner) {
      if (!inner || typeof inner !== 'object') return;
      if (inner !== node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod'].includes(inner.type)) return;
      if (inner.type === 'CallExpression' && member(inner.callee).endsWith('.query')) {
        const kind = mutation(staticText(inner.arguments[0]));
        if (kind) kinds.push({ kind, line: inner.loc.start.line });
      }
      if (inner.type === 'CallExpression' && member(inner.callee).split('.').pop() === 'recordWrite') {
        const arg = inner.arguments[0];
        records.push(arg?.type === 'ObjectExpression' && arg.properties.some(p => p.key?.name === 'deleted' && p.value?.value === true));
      }
      for (const value of Object.values(inner)) {
        if (Array.isArray(value)) value.forEach(own);
        else if (value && typeof value.type === 'string') own(value);
      }
    })(node.body);
    for (const { kind, line } of kinds) {
      statements++;
      if (!records.length) failures.push(name + ' (line ' + line + ') issues ' + kind + ' without advancing the tenant write clock: call recordWrite(' + (kind === 'DELETE' ? '{ deleted: true }' : '') + ') in the same function');
      else if (kind === 'DELETE' && !records.some(Boolean)) failures.push(name + ' (line ' + line + ') issues DELETE without advancing last_delete_stamp: call recordWrite({ deleted: true })');
    }
  });
  if (!statements) failures.push('clinical writer has no mutating statement: the gate would be vacuous');
  return failures;
}
function checkClockInventory(root) {
  const failures = [];
  const dir = path.join(root, 'lib/storage');
  for (const file of fs.readdirSync(dir).filter(name => /^postgres-.*\.js$/.test(name)).sort()) {
    const relative = 'lib/storage/' + file;
    if (CLOCK_WRITERS.includes(relative) || Object.hasOwn(CLOCK_EXEMPT, relative)) continue;
    const ast = babel.parseSync(fs.readFileSync(path.join(dir, file), 'utf8'), {babelrc: false, configFile: false, sourceType: 'script'});
    walk(ast, null, node => {
      if (node.type === 'CallExpression' && member(node.callee).endsWith('.query') && mutation(staticText(node.arguments[0]))) {
        failures.push(relative + ': mutating SQL at line ' + node.loc.start.line + ' in an unclassified PostgreSQL storage module: list it as a clock writer or exempt it with a reason');
      }
    });
  }
  return failures;
}

function main() {
  let failed = false;
  const root = path.resolve(__dirname, '..');
  for (const file of CLOCK_WRITERS) {
    for (const issue of checkClock(fs.readFileSync(path.join(root, file), 'utf8'))) { console.error(file + ': ' + issue); failed = true; }
  }
  for (const issue of checkClockInventory(root)) { console.error(issue); failed = true; }
  for (const file of ADAPTERS) {
    const issues = check(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'));
    for (const issue of issues) { console.error(file + ': ' + issue); failed = true; }
  }
  for (const issue of checkSocketWrapper(fs.readFileSync(path.resolve(__dirname, '..', SOCKET_WRAPPER), 'utf8'))) {
    console.error(SOCKET_WRAPPER + ': ' + issue); failed = true;
  }
  if (failed) process.exitCode = 1;
  else console.log('Write boundary: all ' + ADAPTERS.length + ' adapter entry points and canonical socket delegation checked;'
    + ' tenant write clock advanced by every mutating statement in ' + CLOCK_WRITERS.join(', '));
}
if (require.main === module) main();
module.exports = {check, checkSocketWrapper, checkClock, checkClockInventory, ADAPTERS, SOCKET_WRAPPER, CLOCK_WRITERS, CLOCK_EXEMPT};
