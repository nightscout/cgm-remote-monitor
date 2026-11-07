'use strict';

const validation = require('../server/write-validation');
const RETRIES = 3;

function conflict() {
  const err = new Error('Treatment changed during validation; retry the write');
  err.name = 'WriteConflictError';
  err.status = 409;
  return err;
}

function checkedUpdate(update, stored, context) {
  const set = Object.assign({}, update.$set);
  // Domain fields are scalars: a dotted edit must not evade their rules.
  for (const field of Object.keys(set).concat(Object.keys(update.$unset || {}))) {
    if (field.includes('.') && validation.DOMAIN_FIELDS.includes(field.split('.')[0])) {
      set[field.split('.')[0]] = {};
    }
  }
  const effective = validation.enforce(context.env, context.source, set, stored, update.$unset);
  const prepared = {...update};
  if (update.$set) {
    prepared.$set = {...update.$set};
    if (Object.prototype.hasOwnProperty.call(set, 'units')) prepared.$set.units = set.units;
  }
  // Persist derived duration fields too: validating a normalized cancellation
  // while retaining an old endmills/durationInMilliseconds would store an active
  // target. Explicit unsets still win; validate that resulting stored shape.
  if (effective) {
    for (const field of ['duration', 'durationInMilliseconds', 'endmills']) {
      if (Object.prototype.hasOwnProperty.call(effective, field)
        && !Object.prototype.hasOwnProperty.call(update.$unset || {}, field)
        && effective[field] !== Object.assign({}, stored, prepared.$set)[field]) {
        prepared.$set = Object.assign({}, prepared.$set, {[field]: effective[field]});
      }
    }
    const persisted = Object.assign({}, stored, prepared.$set);
    Object.keys(prepared.$unset || {}).forEach(field => { delete persisted[field]; });
    validation.enforce(context.env, context.source, persisted);
  }
  return prepared;
}

// Exact expression equality (not query array-element equality) plus an
// existence check protects every field on which the validation decision rests.
// $literal keeps stored objects/strings from becoming Mongo expressions.
function snapshotFilter(filter, stored) {
  const checks = [filter, {_id: {$eq: stored._id}}];
  for (const field of validation.DOMAIN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(stored, field)) {
      checks.push({[field]: {$exists: true}});
      checks.push({$expr: {$eq: ['$' + field, {$literal: stored[field]}]}});
    } else checks.push({[field]: {$exists: false}});
  }
  return {$and: checks};
}

async function run(collection, method, args, context) {
  const [filter, update, options] = args;
  // Current adapters use inserts/replacements for upserts. A conditional
  // update must never turn a failed snapshot match into a duplicate insertion.
  if (options && (options.upsert || options.writeConcern && options.writeConcern.w === 0)) {
    const err = new Error('Validated treatment updates require an acknowledged, non-upsert write');
    err.name = 'WriteValidationError';
    err.status = 400;
    throw err;
  }
  const cursor = collection.find(filter);
  if (method === 'updateOne') cursor.limit(1);
  const docs = await cursor.toArray();
  // Preserve batch preflight: a known invalid later twin must not allow an
  // earlier twin to be updated. Concurrent failures may still be partial,
  // just as Mongo updateMany is atomic per document, not a transaction.
  docs.forEach(doc => checkedUpdate(update, doc, context));
  const result = {acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null};
  try {
    for (const initial of docs) {
      let stored = initial;
      for (let attempt = 0; ; attempt++) {
        const prepared = checkedUpdate(update, stored, context);
        const committed = await collection.updateOne(snapshotFilter(filter, stored), prepared, options);
        if (committed.acknowledged === false) throw conflict();
        if (committed.matchedCount) {
          result.matchedCount += committed.matchedCount;
          result.modifiedCount += committed.modifiedCount;
          if (method === 'updateOne' && update.$set && prepared.$set) Object.assign(update.$set, prepared.$set);
          break;
        }
        if (attempt >= RETRIES) throw conflict();
        stored = await collection.findOne({$and: [filter, {_id: {$eq: initial._id}}]});
        if (!stored) break; // Deleted concurrently; never recreate it.
      }
    }
  } catch (err) {
    if (result.modifiedCount) err.result = result;
    throw err;
  }
  return result;
}

module.exports = {run, checkedUpdate, snapshotFilter};
