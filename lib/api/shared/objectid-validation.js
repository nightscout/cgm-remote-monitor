'use strict';

var OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

function isValidObjectId(id) {
  if (id === undefined || id === null) {
    return true;
  }

  return typeof id === 'string' && OBJECT_ID_PATTERN.test(id);
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
