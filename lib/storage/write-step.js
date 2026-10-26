'use strict';

// The persistence boundary shared by v1/internal storage, API v3 and the
// legacy socket. Route adapters retain their matching, coercion and reply
// policies: moving those policies must be a separately measured change.
const assertNoQueryJavascript = require('./assert-no-query-javascript');
const validation = require('../server/write-validation');
const validatedUpdate = require('./validated-update');
const METHODS = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne',
  'updateMany', 'deleteOne', 'deleteMany', 'bulkWrite']);


function operations(method, args) {
  if (method === 'bulkWrite') return args[0].map(op => {
    const name = Object.keys(op)[0];
    return {method: name, spec: op[name]};
  });
  if (method === 'insertMany') return args[0].map(document => ({method: 'insertOne', spec: {document}}));
  if (method === 'insertOne') return [{method, spec: {document: args[0]}}];
  return [{method, spec: {filter: args[0], replacement: args[1], update: args[1]}}];
}

// Only the socket was missing domain validation. v1/internal and v3 already
// validate inserts/replacements at their reply boundary (including positional
// batch refusals and duration coercion). Strict partial updates from every
// adapter use the conditional boundary below to close the read/write race.
async function validateSocket(collection, ops, context) {
  if (context.source !== 'socket' || context.name !== 'treatments'
    || context.validated || validation.mode(context.env) === 'off') return;
  for (const {method, spec} of ops) {
    if (method === 'insertOne' || method === 'replaceOne') {
      validation.enforce(context.env, 'socket', spec.document || spec.replacement);
    } else if (method === 'updateOne' || method === 'updateMany') {
      const update = spec.update;
      if (!validation.touchesDomain(update.$set, update.$unset)) continue;
      const cursor = collection.find(spec.filter);
      if (method === 'updateOne') cursor.limit(1);
      const docs = await cursor.toArray();
      for (const stored of docs) validatedUpdate.checkedUpdate(update, stored, context);
    }
  }
}

function counts(result) {
  return {
    inserted: result.insertedCount || (result.insertedId != null ? 1 : 0),
    upserted: result.upsertedCount || (result.upsertedId != null ? 1 : 0),
    modified: result.modifiedCount || 0,
    deleted: result.deletedCount || 0
  };
}

// No documents, identifiers, selectors or caller-supplied messages in events.
// This is an internal commit observation, NOT a new /storage broadcast.
function publish(context, method, result, partial) {
  if (!result || result.acknowledged === false) return null;
  const changes = counts(result);
  if (!Object.values(changes).some(value => value > 0)) return null;
  const event = Object.freeze({collection: context.name, source: context.source,
    operation: method, partial: !!partial, counts: Object.freeze(changes)});
  if (context.bus) {
    try { context.bus.emit('storage-write-committed', event); }
    catch { console.warn('Storage commit observer failed; the write remains committed'); }
  }
  return event;
}

async function write({collection, method, args = [], context = {}}) {
  if (!METHODS.has(method)) throw new TypeError('Unsupported storage write operation');
  const ops = operations(method, args);
  for (const op of ops) {
    if (!METHODS.has(op.method) || op.method === 'bulkWrite' || !op.spec) {
      throw new TypeError('Unsupported storage bulk operation');
    }
    if (op.spec.filter) assertNoQueryJavascript(op.spec.filter);
  }
  const conditional = context.name === 'treatments' && validation.mode(context.env) === 'reject'
    && ['updateOne', 'updateMany'].includes(method)
    && validation.touchesDomain(args[1].$set, args[1].$unset);
  if (!conditional) await validateSocket(collection, ops, context);
  let result;
  try {
    result = conditional ? await validatedUpdate.run(collection, method, args, context)
      : await collection[method](...args);
  } catch (err) {
    // Mongo can commit part of an unordered batch before rejecting it. Keep
    // the original error (and its insertedIds/writeErrors) for existing callers.
    publish(context, method, err.result, true);
    throw err;
  }
  return {result, event: publish(context, method, result, false)};
}

function collection(raw, context) {
  // Bind driver methods to the driver collection, including reads/cursors.
  // No mutation of a shared Mongo Collection or of driver result/error objects.
  return new Proxy(raw, {
    get(target, key) {
      if (METHODS.has(key)) return async (...args) => (await write({collection: target,
        method: key, args, context})).result;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

module.exports = {write, collection};
