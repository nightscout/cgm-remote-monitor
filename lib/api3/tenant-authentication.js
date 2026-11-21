'use strict';

// Only an awaited, trusted data-plane bridge can bind this request object.
// No header, JWT claim, request property or display name enters this map.
const verified = new WeakMap();

module.exports = Object.freeze({
  bind (request, authorization) { verified.set(request, authorization); },
  get (request) { return verified.get(request); }
});
