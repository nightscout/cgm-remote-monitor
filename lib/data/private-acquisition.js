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
  ctx.cache = createCache(env, ctx, COPY);
  const ddata = createData(COPY);
  createLoader(env, ctx).update(ddata, options, error => done(error, ddata));
}

module.exports = { createContext, load };
