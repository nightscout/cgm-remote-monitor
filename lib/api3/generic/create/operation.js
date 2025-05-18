'use strict';

const _ = require('lodash')
  , apiConst = require('../../const.json')
  , security = require('../../security')
  , insert = require('./insert')
  , replace = require('../update/replace')
  , opTools = require('../../shared/operationTools')
  ;


/**
 * CREATE: Inserts a new document into the collection
 */
async function create (opCtx) {

  const { col, req, res } = opCtx;
  const doc = req.body;

  if (_.isEmpty(doc)) {
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_REQUEST_BODY);
  }

  try {
    col.parseDate(doc); // Step 1: Parse date string to canonical form
  } catch (err) {
    // If parseDate throws, assume it's a bad date format from the user
    return opTools.sendJSONStatus(res, apiConst.HTTP.BAD_REQUEST, apiConst.MSG.HTTP_400_BAD_FIELD_DATE);
  }

  // Step 2: Ensure date is a numeric timestamp if parseDate converted it to a Date object.
  // This helps consistency for validation and comparison (e.g. with self.validDoc.date).
  if (doc.date && doc.date instanceof Date) {
    doc.date = doc.date.getTime();
  }

  opTools.resolveIdentifier(doc); // Step 3: Resolve identifier

  const identifyingFilter = col.storage.identifyingFilter(doc.identifier, doc, col.dedupFallbackFields);

  const result = await col.storage.findOneFilter(identifyingFilter, { });

  if (result && result.length > 0) {
    const storageDoc = result[0];
    await replace(opCtx, doc, storageDoc, { isDeduplication: true });
  }
  else {
    await insert(opCtx, doc);
  }
}


function createOperation (ctx, env, app, col) {

  return async function operation (req, res) {

    const opCtx = { app, ctx, env, col, req, res };

    try {
      opCtx.auth = await security.authenticate(opCtx);

      await create(opCtx);

    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        return opTools.sendJSONStatus(res, apiConst.HTTP.INTERNAL_ERROR, apiConst.MSG.STORAGE_ERROR);
      }
    }
  };
}

module.exports = createOperation;