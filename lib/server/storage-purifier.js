'use strict';

// Storage adapters are called by more than the HTTP APIs. Bridges and the
// nightscout-connect importer write through them directly, so this is the
// final in-process boundary before a document reaches MongoDB.
function purifyForStorage (ctx, objOrArray) {
  if (!ctx.purifier || typeof ctx.purifier.purifyObject !== 'function') {
    throw new Error('Storage write purifier is not configured');
  }

  var documents = Array.isArray(objOrArray) ? objOrArray : [objOrArray];
  documents.forEach(function (document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new TypeError('Storage writes require document objects');
    }
    // Keep the complexity/parser budget per document. Existing REST and
    // WebSocket paths already use that boundary for batch uploads.
    ctx.purifier.purifyObject(document);
  });

  return objOrArray;
}

module.exports = purifyForStorage;
