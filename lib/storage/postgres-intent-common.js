'use strict';

// Shared preview mechanics only. Callers retain source-specific query, natural-
// order and validation policy, and supply the owned transaction boundary.
const utils = require('../api3/storage/mongoCollection/utils');
const intent = require('./write-intent');

function project (docs, projection, label) {
  if (!projection || !Object.keys(projection).length) return docs;
  const keys = Object.keys(projection);
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ![0, 1].includes(projection[key]))) {
    throw new TypeError(label + ': unsupported projection');
  }
  const included = keys.filter(key => key !== '_id' && projection[key] === 1);
  const excluded = keys.filter(key => key !== '_id' && projection[key] === 0);
  if (included.length && excluded.length) throw new TypeError(label + ': mixed projection');
  const inclusion = included.length || (projection._id === 1 && !excluded.length);
  return docs.map(doc => {
    if (!inclusion) return Object.fromEntries(Object.entries(doc).filter(([key]) => projection[key] !== 0));
    const keep = new Set(included);
    if (projection._id !== 0) keep.add('_id');
    return Object.fromEntries(Object.entries(doc).filter(([key]) => keep.has(key)));
  });
}

function findOneFilter (reader, translate, label) {
  return async function findOne (filter, projection, options = {}) {
    if (Object.keys(options).some(key => !['normalize', 'limit'].includes(key))) {
      throw new TypeError(label + ': unsupported findOneFilter option');
    }
    const docs = await reader.findFiltered(translate(filter), {
      sort: { identifier: -1, _id: -1 },
      limit: Number.isInteger(options.limit) && options.limit > 1 ? options.limit : 1,
      options: { normalize: false }
    });
    const shown = project(docs, projection, label);
    if (options.normalize !== false) shown.forEach(utils.normalizeDoc);
    return shown;
  };
}

function withCommitEvents (step, { connection, storage, bus, logical, source }) {
  const publish = fn => connection.afterCommit ? connection.afterCommit(fn) : fn();
  return Object.assign({}, step, {
    storage,
    async write (planned) {
      // The tenant and the clock's allocated floor are read inside the owned
      // transaction, after the step has written: the clock's per-transaction
      // state is gone once transaction() returns. A connection without a
      // write clock has no stamp. Publication timing is unchanged.
      let tenant = null, stamp = null;
      const written = await connection.transaction(async () => {
        const result = await step.write(planned);
        tenant = intent.intentTenant();
        stamp = typeof connection.currentStamp === 'function' ? connection.currentStamp() : null;
        return result;
      });
      publish(() => intent.emitIntentEvent(bus, written, { name: logical, source, op: planned && planned.op, tenant, stamp }));
      return written;
    },
    // A settle opens no transaction and proves no write: no stamp.
    settle (planned, stored, outcome, reason) {
      const written = step.settle(planned, stored, outcome, reason);
      publish(() => intent.emitIntentEvent(bus, written, { name: logical, source, op: planned && planned.op,
        tenant: intent.intentTenant(), stamp: null }));
      return written;
    }
  });
}

module.exports = { project, findOneFilter, withCommitEvents };
