'use strict';
const path = require('node:path');
const EventEmitter = require('node:events');

// Real entries router/storage code with an owned in-memory collection boundary.
// Authentication is outside this format/batch fixture; real API tests cover it.
function fixture(rows = [], deNormalizeDates = true, implementation = path.resolve(__dirname, '../..')) {
  const express = require('node:module').createRequire(path.join(implementation, 'package.json'))('express');
  const state = {writes: [], purifications: 0};
  const env = {settings: {deNormalizeDates}, entries_collection: 'entry_transform_test'};
  const collection = {bulkWrite: async (ops, options) => {
    state.writes.push({ops, options});
    if (state.failure) throw state.failure;
    return {upsertedIds: {}};
  }};
  const ctx = {store: {collection: () => collection}, bus: new EventEmitter(),
    purifier: {purifyObject: () => state.purifications++},
    ddata: {sgvs: [], processRawDataForRuntime: docs => docs}, cache: {entries: [], getData: () => []},
    authorization: {isPermitted: () => (req, res, next) => next()}};
  ctx.entries = require(path.join(implementation, 'lib/server/entries'))(env, ctx);
  ctx.entries.list = (query, done) => done(null, structuredClone(rows));
  const app = express();
  require('../../lib/middleware/configure-request')(app);
  app.enable('api');
  app.use(require(path.join(implementation, 'lib/api/entries'))(app, require(path.join(implementation, 'lib/middleware'))(env), ctx, env));
  return {app, state, entries: ctx.entries};
}

module.exports = fixture;
