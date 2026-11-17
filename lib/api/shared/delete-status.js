'use strict';

function normalizeDeleteStatus(stat) {
  if (!stat || typeof stat !== 'object') {
    return stat;
  }

  var response = Object.assign({}, stat);

  if (response.n === undefined && response.deletedCount !== undefined) {
    response.n = response.deletedCount;
  }

  if (response.deletedCount === undefined && response.n !== undefined) {
    response.deletedCount = response.n;
  }

  // `deleted` is the storage interface's own spelling of the same number
  // (deleteManyOr's contract; lib/api3/storage/mongoCollection/modify.js). It
  // is internal, so it is removed here rather than published: this is the one
  // place every v1 delete endpoint builds its body, which is why the storage
  // modules hand their result straight through.
  delete response.deleted;

  return response;
}

module.exports = normalizeDeleteStatus;
