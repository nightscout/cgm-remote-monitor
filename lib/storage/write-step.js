'use strict';

// The persistence boundary shared by v1/internal storage, API v3 and the
// legacy socket. Route adapters retain their matching, coercion and reply
// policies: moving those policies must be a separately measured change.
const assertNoQueryJavascript = require('./assert-no-query-javascript');
const validation = require('../server/write-validation');
const METHODS = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne',
  'updateMany', 'deleteOne', 'deleteMany', 'bulkWrite']);
const DOMAIN_FIELDS = new Set(['eventType', 'units', 'targetTop', 'targetBottom',
  'duration', 'durationInMilliseconds']);

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
// validate at their reply boundary (including positional batch refusals and
// duration coercion). Do not repeat checks against a different representation.
async function validateSocket(collection, ops, context) {
  if (context.source !== 'socket' || context.name !== 'treatments'
    || context.validated || validation.mode(context.env) === 'off') return;
  for (const {method, spec} of ops) {
    if (method === 'insertOne' || method === 'replaceOne') {
      validation.enforce(context.env, 'socket', spec.document || spec.replacement);
    } else if (method === 'updateOne' || method === 'updateMany') {
      const update = spec.update;
      const fields = Object.keys(update.$set || {}).concat(Object.keys(update.$unset || {}));
      // A note edit must remain possible on a legacy invalid target. Treat a
      // dotted edit of a domain field as relevant too; it must not bypass the check.
      if (!fields.some(field => DOMAIN_FIELDS.has(field.split('.')[0]))) continue;
      const cursor = collection.find(spec.filter);
      if (method === 'updateOne') cursor.limit(1);
      const docs = await cursor.toArray();
      for (const stored of docs) {
        const target = Object.assign({}, stored, update.$set);
        Object.keys(update.$unset || {}).forEach(field => { delete target[field]; });
        // Dotted edits turn these scalar fields into objects, which are invalid.
        fields.filter(field => field.includes('.') && DOMAIN_FIELDS.has(field.split('.')[0]))
          .forEach(field => { target[field.split('.')[0]] = {}; });
        validation.enforce(context.env, 'socket', target);
        if (validation.mode(context.env) === 'reject' && update.$set
          && Object.prototype.hasOwnProperty.call(update.$set, 'units')) {
          update.$set.units = target.units;
        }
      }
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
  await validateSocket(collection, ops, context);
  let result;
  try {
    result = await collection[method](...args);
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
