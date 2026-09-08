'use strict';

// API3 is mounted at /api/v3. Collection names come from generic/setup, not
// request paths or proxy headers. Encode each dynamic segment independently.
module.exports = function documentLocation (collection, identifier) {
  return '/api/v3/' + encodeURIComponent(collection) + '/' + encodeURIComponent(identifier);
};
