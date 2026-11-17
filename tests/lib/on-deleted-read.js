'use strict';

// The write step's on-deleted read (ID-FIRST-MATCH slice 3,
// lib/storage/write-intent.js deletedReached and the socket's deleted
// matches): a read whose filter is { $and: [<the write's match>, { isValid:
// false }] }, in the driver's spelling or in the storage interface's AST
// (lib/server/storage-reads.js toFilter).
//
// The suites that compare a module with its frozen copy (tests/fixtures/
// write-intent/), or pin the exact calls a write makes, predate slice 3: the
// read is new, and on their records (none deleted) it finds nothing and
// changes nothing else. Their fakes answer it with no records and leave it
// out of the calls they compare; tests/write-intent.on-deleted.test.js pins
// the read itself and what follows when it finds a deleted record.
function isOnDeletedRead (filter) {
  if (!filter || typeof filter !== 'object') return false;
  if (Array.isArray(filter.$and)) {
    const last = filter.$and[filter.$and.length - 1];
    return filter.$and.length === 2 && Boolean(last) && Object.keys(last).length === 1 && last.isValid === false;
  }
  if (filter.op === 'and' && Array.isArray(filter.nodes)) {
    const last = filter.nodes[filter.nodes.length - 1];
    return filter.nodes.length === 2 && Boolean(last) && last.op === 'eq' && last.field === 'isValid'
      && last.value === false;
  }
  return false;
}

module.exports = { isOnDeletedRead };
