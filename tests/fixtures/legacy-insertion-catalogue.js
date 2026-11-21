'use strict';

// Retain the immutable pre-counter prefix for historical identity/sequence unit
// vectors. These vectors exercise legacy restore/rollback support; current
// tenant-local schema/role/maintenance acceptance has its own tests and native
// campaign. Do not relabel an old protocol double as a current schema oracle.
function legacyInsertionCatalogue (candidate) {
  return { ...candidate, migrations: candidate.migrations.filter(migration => !migration.operation) };
}

function legacyInsertionEntry (entry) {
  return { ...entry, candidate: legacyInsertionCatalogue(entry.candidate),
    tables: entry.tables.filter(table => table !== 'tenant_insertion_ordinal') };
}

module.exports = { legacyInsertionCatalogue, legacyInsertionEntry };
