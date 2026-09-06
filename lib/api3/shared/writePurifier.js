'use strict';

const PURIFIED_COLLECTIONS = [
  'devicestatus',
  'entries',
  'food',
  'profile',
  'treatments'
];

function shouldPurifyCollection (colName) {
  return PURIFIED_COLLECTIONS.indexOf(colName) !== -1;
}

function purifyWritableDocument (opCtx, doc) {
  const { ctx, col } = opCtx;

  if (!doc || typeof doc !== 'object' || !shouldPurifyCollection(col.colName)) {
    return doc;
  }

  if (!ctx.purifier || typeof ctx.purifier.purifyObject !== 'function') {
    throw new Error('APIv3 write purifier is not configured');
  }

  return ctx.purifier.purifyObject(doc);
}

module.exports = {
  purifyWritableDocument,
  shouldPurifyCollection
};
