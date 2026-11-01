'use strict';

// A suite that stores records sharing an identifier straight to MongoDB
// stands for a database written before the unique index on identifier
// (ID-UNIQUE-INDEX). Booting under WRITE_IDENTIFIER_INDEX=try builds the index
// where no duplicates are stored yet, so such a suite drops it first, as an
// operator does to run without it (docs/architecture/write-intent.md). The
// next boot builds it again where it can.

const identifierIndex = require('../../lib/storage/identifier-index');

const NAMES = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity', 'settings'];

async function dropIdentifierIndex (store, env) {
  for (const name of NAMES) {
    try {
      await store.collection(env[name + '_collection'] || name).dropIndex(identifierIndex.INDEX_NAME);
    } catch {
      // not there
    }
  }
}

module.exports = { dropIdentifierIndex };
