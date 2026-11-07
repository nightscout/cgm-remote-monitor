'use strict';

// The 24-hex rule, in either case, from the one helper storage uses.
var isHexId = require('../../server/object-id-forms').isHexId;

function isValidObjectId(id) {
  if (id === undefined || id === null) {
    return true;
  }

  return isHexId(id);
}

function findInvalidId(docs) {
  var invalidIndex = docs.findIndex(function (doc) {
    return !isValidObjectId(doc._id);
  });

  if (invalidIndex !== -1) {
    return { index: invalidIndex, id: docs[invalidIndex]._id };
  }

  return null;
}

module.exports = {
  findInvalidId: findInvalidId,
  isValidObjectId: isValidObjectId
};
