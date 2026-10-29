'use strict';

// Gate G2 of the write contract (write-contract spec §5), for the code already
// enrolled in the write step (lib/storage/write-intent.js): it writes only
// through write(intent). It must not call a write method of the storage
// interface or of the driver, must not use the v1 write helpers
// (lib/server/storage-writes.js) the step replaced, and must not call a
// function of its own module that does either.
//
// scripts/check-write-boundary.js is the neighbouring gate one layer down:
// every write crosses the persistence boundary (lib/storage/write-step.js).
// This one says which writes go through the step above the interface. Code
// joins ENROLLED in the commit that routes its writes through the step: a
// whole module (a path), or named functions of a module whose other writers
// are not routed yet ({ file, functions }). An enrolled function that cannot
// be found fails the gate, so a rename cannot empty it.

const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');

const ENROLLED = ['lib/server/food.js', 'lib/server/activity.js', 'lib/server/treatments.js', 'lib/server/entries.js'
  , 'lib/server/devicestatus.js', 'lib/server/profile.js'
  // The socket's generic dbAdd (entries, food, activity) and its dbRemove
  // (every collection), slice 3; the dbAdd of treatments, devicestatus and
  // profile (the handler and processSingleDbAdd), dbUpdate and dbUpdateUnset,
  // slice 6. Every socket writer is enrolled; the module's other functions
  // (reconcilePartialWrite's read-back) only read.
  , { file: 'lib/server/websocket.js', functions: ['processGenericDbAdd', 'dbRemove', 'processSingleDbAdd', 'dbAdd'
    , 'dbUpdate', 'dbUpdateUnset'] }
  // API v3's generic create, update (PUT), patch and delete, every v3
  // collection (slice 4). autoPrune (lib/api3/generic/collection.js) still
  // deletes by query through the cached storage.
  , 'lib/api3/generic/create/insert.js', 'lib/api3/generic/update/replace.js'
  , 'lib/api3/generic/patch/operation.js', 'lib/api3/generic/delete/operation.js'];

// The driver's write methods, the storage interface's
// (lib/api3/storage/mongoCollection/index.js) and lib/server/storage-writes.js's.
const WRITES = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany',
  'deleteOne', 'deleteMany', 'bulkWrite', 'bulkUpsert', 'replaceFiltered', 'deleteManyOr',
  'updateEveryForm', 'deleteEveryForm']);

const STORAGE_WRITES = /\/storage-writes(\.js)?$/;

function walk (node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, fn));
    else if (value && typeof value.type === 'string') walk(value, fn);
  }
}

function isRequireOf (node, pattern) {
  return node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
    && typeof node.arguments[0]?.value === 'string' && pattern.test(node.arguments[0].value);
}

function isFunction (node) {
  return node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression';
}

// The names a module binds lib/server/storage-writes.js to (`var writes = require(...)`).
function writeHelperNames (ast) {
  const names = new Set();
  walk(ast, function visit (node) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init
      && isRequireOf(node.init, STORAGE_WRITES)) names.add(node.id.name);
  });
  return names;
}

// The direct writes inside `body`: a write method called on anything, or any
// call through the storage-writes binding.
function directWrites (body, helpers) {
  const found = [];
  walk(body, function visit (node) {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type === 'MemberExpression' && !callee.computed && WRITES.has(callee.property.name)) {
      found.push({ line: node.loc.start.line, what: 'write ' + callee.property.name });
    } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
      && helpers.has(callee.object.name)) {
      found.push({ line: node.loc.start.line, what: 'v1 write helper ' + callee.object.name + '.' + (callee.property.name || '?') });
    }
  });
  return found;
}

// The module's named functions that write, directly or by calling another
// one that does.
function writerFunctions (ast, helpers) {
  const bodies = new Map();
  walk(ast, function visit (node) {
    if (isFunction(node) && node.id) bodies.set(node.id.name, node.body);
  });
  const writers = new Set();
  for (const [name, body] of bodies) if (directWrites(body, helpers).length) writers.add(name);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (writers.has(name)) continue;
      walk(body, function visit (node) {
        if (!writers.has(name) && node.type === 'CallExpression' && node.callee.type === 'Identifier'
          && writers.has(node.callee.name)) {
          writers.add(name); grew = true;
        }
      });
    }
  }
  return writers;
}

function parse (source) {
  return babel.parseSync(source, { babelrc: false, configFile: false, sourceType: 'script' });
}

// A whole module: no write and no storage-writes require anywhere in it.
function check (source) {
  const ast = parse(source);
  const failures = [];
  walk(ast, function visit (node) {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (isRequireOf(node, STORAGE_WRITES)) {
      failures.push('requires the v1 write helpers instead of the write step at line ' + node.loc.start.line);
    }
    if (callee.type === 'MemberExpression' && !callee.computed && WRITES.has(callee.property.name)) {
      failures.push('write ' + callee.property.name + ' bypasses write(intent) at line ' + node.loc.start.line);
    }
  });
  return failures;
}

// Named functions of a module: none of them writes, uses the storage-writes
// binding, or calls a function of the module that writes.
function checkFunctions (source, functions) {
  const ast = parse(source);
  const helpers = writeHelperNames(ast);
  const writers = writerFunctions(ast, helpers);
  const failures = [];
  for (const name of functions) {
    const found = [];
    walk(ast, function visit (node) {
      if (isFunction(node) && node.id && node.id.name === name) found.push(node);
    });
    if (found.length !== 1) {
      failures.push('enrolled function ' + name + ' found ' + found.length + ' times, expected once');
      continue;
    }
    for (const w of directWrites(found[0].body, helpers)) {
      failures.push(name + ': ' + w.what + ' bypasses write(intent) at line ' + w.line);
    }
    walk(found[0].body, function visit (node) {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && writers.has(node.callee.name)) {
        failures.push(name + ': calls ' + node.callee.name + ', which writes around write(intent), at line ' + node.loc.start.line);
      }
    });
  }
  return failures;
}

function checkEntry (entry, source) {
  return typeof entry === 'string' ? check(source) : checkFunctions(source, entry.functions);
}

function fileOf (entry) {
  return typeof entry === 'string' ? entry : entry.file;
}

function main () {
  let failed = false;
  for (const entry of ENROLLED) {
    const file = fileOf(entry);
    for (const issue of checkEntry(entry, fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'))) {
      console.error(file + ': ' + issue);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('Write intent: ' + ENROLLED.length + ' enrolled module(s) write only through write(intent)');
}
if (require.main === module) main();
module.exports = { check, checkFunctions, checkEntry, fileOf, ENROLLED };
