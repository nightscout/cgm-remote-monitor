'use strict';

const { EventEmitter } = require('node:events');
const createData = require('./ddata');
const createLoader = require('./dataloader');
const createCache = require('../server/cache');
const { jsonCopy } = require('./json-copy');

// Every deep copy the loader, its cache and ddata make in a private
// acquisition gives exactly the JSON round trip's result (json-copy.js), so
// copies stay as independent as before without building and parsing the text.
const COPY = Object.freeze({ copy: jsonCopy });

// A working context belongs to one acquisition. Callers supply their own read,
// statistics and completion policies; resident data, cache and bus are never
// inherited. This helper does not select query bounds or database isolation.
function createContext (fields) {
  return { ...fields, bus: new EventEmitter(), ddata: createData(COPY) };
}

// Keep the loader's helper data separate from its materialized target. Cache
// creation stays immediately before loading, after the caller has built its
// private read facade. In
// particular, errors remain the caller's policy: the loader may log a read
// failure and continue, so its callback alone cannot establish completeness.
function load (env, ctx, options, done) {
  ctx.cache = createCache(env, ctx, { copy: jsonCopy, retentionEdges: options.retentionEdges });
  const ddata = createData(COPY);
  createLoader(env, ctx).update(ddata, options, error => done(error, ddata));
}

// Domain-only acquisition retains the shipping frame/cache semantics. It is
// not a clinical frame and must never feed derived properties or evaluation.
function loadRaw (env, ctx, logical, at, done) {
  ctx.cache = createCache(env, ctx, COPY);
  const ddata = ctx.ddata;
  ddata.lastUpdated = at;
  ddata.page = { frame: true, after: at };
  const query = createLoader.rawQuery(logical, ddata, ctx, env);
  ctx[logical].list(query, (error, docs) => {
    if (error) return done(error);
    try {
      const normalized = ddata.processRawDataForRuntime(docs);
      ctx.cache.insertDataRef(logical, normalized);
      // Only the unaddressed entries handler reads ddata, for Last-Modified.
      // Keep the loader's last-SGV rule/order, including its MBG precedence.
      if (logical === 'entries') {
        let last;
        for (const row of normalized) if (row && !row.mbg && row.sgv) last = row;
        ddata.sgvs = last ? [{ mills: last.date, mgdl: Number(last.sgv) }] : [];
      }
      done(null, ddata);
    } catch (failure) { done(failure); }
  });
}

// An empty working set of the kind load() fills.
function createWorkingSet () {
  return createData(COPY);
}

module.exports = { createContext, load, loadRaw, createWorkingSet };
