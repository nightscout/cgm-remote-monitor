'use strict';

// Which storage implementation to boot.
//
// lib/server/bootevent.js loaded '../storage/mongo-storage' under a "assume
// mongo for now, when there are more storage options add a lookup" TODO. This
// is that lookup. It reads the scheme already in the connection URI rather
// than adding a second setting: a separate backend setting could disagree with
// the URI it describes, and `postgres://...` handed to the MongoDB driver
// surfaces as a URI parse failure instead of as the configuration mistake it
// is. The scheme is where the operator has already said what the database is.
//
// The require() calls are literal, inside thunks:
//   - tests/runtime-policy.test.js intercepts Module._load and treats the
//     literal '../storage/mongo-storage' as the sign that an application
//     service was loaded before the Node version was checked. require(variable)
//     would retire that check without failing it.
//   - only the selected backend is loaded, so a deployment does not pull in a
//     driver it does not use.

const BACKENDS = Object.freeze([
  Object.freeze({
    name: 'mongodb'
    , schemes: Object.freeze(['mongodb', 'mongodb+srv'])
    , load: function load () { return require('../storage/mongo-storage'); }
  })
]);

// A URI with no scheme, or no URI at all, is not an error here. That is how a
// misconfigured deployment looks today, and mongo-storage (and checkSettings)
// already report it specifically; a scheme error would replace a good message
// with a worse one.
const DEFAULT_BACKEND = 'mongodb';

// RFC 3986 scheme grammar. Not `new URL()`: a connection URI can carry
// credentials WHATWG parsing rejects or rewrites, and only the first token is
// wanted. Nothing else of the URI is read, kept or logged here.
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function schemeOf (storageURI) {
  if (typeof storageURI !== 'string') return null;
  const match = SCHEME.exec(storageURI.trim());
  return match ? match[1].toLowerCase() : null;
}

function knownSchemes () {
  return BACKENDS.reduce((all, backend) => all.concat(backend.schemes), []);
}

/**
 * @param {string} storageURI env.storageURI
 * @returns {{name: string, schemes: string[], load: Function}}
 * @throws {Error} name 'UnsupportedStorageBackendError' when the URI names a
 *   scheme no backend in this build claims. The message names that scheme and
 *   the ones this build has; it never repeats the rest of the URI.
 */
function selectBackend (storageURI) {
  const scheme = schemeOf(storageURI);
  if (scheme === null) return BACKENDS.find(backend => backend.name === DEFAULT_BACKEND);
  const backend = BACKENDS.find(candidate => candidate.schemes.includes(scheme));
  if (backend) return backend;
  const error = new Error('No storage backend for URI scheme "' + scheme
    + '". This build supports: ' + knownSchemes().join(', ') + '.');
  error.name = 'UnsupportedStorageBackendError';
  throw error;
}

module.exports = { selectBackend, schemeOf, knownSchemes, DEFAULT_BACKEND };
