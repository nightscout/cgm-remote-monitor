'use strict';

// Driver 7 no longer caps getMore batches at 1,000 documents by default.
// Bound bulk-read batches explicitly to avoid decoding a whole report at once.
// This also sizes the initial batch; query limits and returned data are unchanged.
module.exports = Object.freeze({batchSize: 1000});
