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

  return response;
}

module.exports = normalizeDeleteStatus;
