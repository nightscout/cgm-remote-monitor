'use strict';

// Current credential and authority reads of one request (decision
// credential-rotation-next-request: a rotation applies from the next request).
// A request that authenticates and then exchanges the same credential reads
// its verifier row and subject once; every decision still runs on that read.
// Nothing here outlives the request object.
const reads = new WeakMap();

function forRequest (request) {
  if (!request || typeof request !== 'object') return undefined;
  let memo = reads.get(request);
  if (!memo) reads.set(request, memo = new Map());
  return memo;
}

// The first caller's read, shared with later callers of the same key. A failed
// read stays failed for this request.
function once (memo, key, read) {
  if (!memo) return read();
  let pending = memo.get(key);
  if (!pending) {
    pending = Promise.resolve().then(read);
    memo.set(key, pending);
  }
  return pending;
}

module.exports = { forRequest, once };
