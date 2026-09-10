'use strict';

function getDeletedCount(retVal) {
  if (!retVal) {
    return 0;
  }

  if (retVal.n !== undefined) {
    return retVal.n;
  }

  if (retVal.deletedCount !== undefined) {
    return retVal.deletedCount;
  }

  return 0;
}

module.exports = getDeletedCount;
