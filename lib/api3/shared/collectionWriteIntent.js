'use strict';

const writeIntent = require('../../storage/write-intent');

module.exports = function collectionWriteIntent ({ col, ctx, env }) {
  return typeof col.intentFactory === 'function'
    ? col.intentFactory()
    : writeIntent.forCollectionIntent(col.storage, col.colName, 'v3', { env, bus: ctx && ctx.bus });
};
