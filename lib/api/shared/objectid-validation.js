'use strict';

var OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

function isValidObjectId(id) {
  if (id === undefined || id === null) {
    return true;
  }

  return typeof id === 'string' && OBJECT_ID_PATTERN.test(id);
}

function findInvalidId(docs) {
  for (var i = 0; i < docs.length; i++) {
    if (!isValidObjectId(docs[i]._id)) {
      return { index: i, id: docs[i]._id };
    }
  }

  return null;
}

module.exports = {
  findInvalidId: findInvalidId,
  isValidObjectId: isValidObjectId
};
