'use strict';

// The socket's write rules as lib/server/websocket.js ran them at 795a0751,
// before WC-STEP-PATCH slice 6 moved them into the write step: the dbAdd of
// treatments, devicestatus and profile (storeIdAsObjectId, the exact match,
// the similar match, the insert), the dbAdd preflight (WRITE_VALIDATION, then
// BF-194), and the write of dbUpdate and dbUpdateUnset (idMatch, server dates,
// BF-194, the JSON Merge Patch). Kept as the reference
// tests/write-intent.socket.test.js compares the step with: the same storage
// calls for the same records. The emissions, replies and logging are left
// out; each function says which branch ran instead, as
// { kind, record } (or throws { rule, cause } where the handler caught).

const ObjectID = require('mongodb').ObjectId;
const writeValidation = require('../../../lib/server/write-validation');
const reads = require('../../../lib/server/storage-reads');
const writes = require('../../../lib/server/storage-writes');
const idForms = require('../../../lib/server/object-id-forms');
const fallbackKey = require('../../../lib/server/treatment-fallback-key');
const srvDates = require('../../../lib/server/srv-dates');
const softDeleted = require('../../../lib/server/soft-deleted');
const mergePatch = require('../../../lib/server/merge-patch');
const targetUnits = require('../../../lib/treatmentTargetUnits');
const validatedUpdate = require('../../../lib/storage/validated-update');

function caught (rule, cause) {
  return { rule: rule, cause: cause };
}

function idMatch (id) {
  if (id instanceof ObjectID || idForms.isHexId(id)) {
    return { filter: { _id: { $in: idForms.idForms(id) } }, many: true };
  }
  return { filter: { _id: id }, many: false };
}

function literal (value) {
  return { $eq: value };
}

var v3Collections = ['treatments', 'entries', 'devicestatus', 'profile', 'food'];
function servedByV3 (name) {
  return v3Collections.indexOf(name) !== -1;
}

// dbAdd's preflight for one treatment: the refusal's problems, or null.
function preflight (env, document) {
  var refused = null;
  try {
    writeValidation.enforce(env, 'socket', document);
  } catch (err) {
    if (!writeValidation.isValidationError(err)) throw err;
    refused = err.problems;
  }
  if (!refused) targetUnits.normalizeTargetUnits(document);
  return refused;
}

async function storeIdAsObjectId (mongoCollection, document) {
  if (!idForms.isHexId(document._id)) return;
  var stale = await reads.findOne(mongoCollection
    , { _id: { $in: idForms.stringIdForms(document._id) } }
    , { _id: 1 });
  document._id = stale ? stale._id : idForms.toStoredId(document._id);
}

async function insertDocument (mongoCollection, doc) {
  await mongoCollection.insertOne(doc, { normalize: false });
  return { insertedId: doc._id };
}

async function processSingleDbAdd (mongoCollection, data, maxtimediff) {
  try {
    await storeIdAsObjectId(mongoCollection, data.data);
  } catch (err) {
    throw caught('id-form', err);
  }

  if (data.collection === 'treatments') {
    var query;
    if (data.data.NSCLIENT_ID) {
      query = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
    } else {
      query = fallbackKey.fallbackQuery(data.data, data.data.created_at);
    }
    try {
      var exactTreatment = await reads.findOne(mongoCollection, softDeleted.visible(query));
      if (exactTreatment) {
        return { kind: 'exact', record: exactTreatment };
      }
    } catch (err) {
      throw caught('exact-match', err);
    }

    var query_similiar = {
      created_at: { $gte: new Date(new Date(data.data.created_at).getTime() - maxtimediff).toISOString(), $lte: new Date(new Date(data.data.created_at).getTime() + maxtimediff).toISOString() }
    };
    ['insulin', 'carbs'].forEach(function (field) {
      var value = data.data[field];
      if (value) {
        query_similiar[field] = literal(value);
      } else if (value === 0) {
        query_similiar[field] = { $in: [0, null] };
      }
    });
    ['percent', 'absolute', 'duration'].forEach(function (field) {
      var value = data.data[field];
      if (value || value === 0) {
        query_similiar[field] = literal(value);
      }
    });
    if (data.data.NSCLIENT_ID) {
      query_similiar.NSCLIENT_ID = literal(data.data.NSCLIENT_ID);
    }
    query_similiar.eventType = literal(data.data.eventType);
    try {
      var similar = await reads.findOne(mongoCollection, softDeleted.visible(query_similiar));
      if (similar) {
        similar.created_at = data.data.created_at;
        var similarFields = { created_at: data.data.created_at };
        srvDates.stampModified(similarFields);
        await writes.update(mongoCollection, { '_id': similar._id }, { $set: similarFields }, { one: true });
        similar.srvModified = similarFields.srvModified;
        return { kind: 'similar', record: similar };
      }
    } catch (err) {
      throw caught('similar-match', err);
    }

    try {
      srvDates.stampCreated(data.data);
      var insertResult = await insertDocument(mongoCollection, data.data);
      var doc = data.data;
      doc._id = insertResult.insertedId;
      return { kind: 'inserted', record: doc };
    } catch (err) {
      throw caught('insert', err);
    }
  } else if (data.collection === 'devicestatus') {
    var queryDev;
    if (data.data.NSCLIENT_ID) {
      queryDev = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
    } else {
      queryDev = {
        created_at: literal(data.data.created_at)
      };
    }
    try {
      var existingStatus = await reads.findOne(mongoCollection, softDeleted.visible(queryDev));
      if (existingStatus) {
        return { kind: 'exact', record: existingStatus };
      }
    } catch (err) {
      throw caught('exact-match', err);
    }
    try {
      srvDates.stampCreated(data.data);
      var devicestatusInsertResult = await insertDocument(mongoCollection, data.data);
      var devicestatusDoc = data.data;
      devicestatusDoc._id = devicestatusInsertResult.insertedId;
      return { kind: 'inserted', record: devicestatusDoc };
    } catch (err) {
      throw caught('insert', err);
    }
  } else if (data.collection === 'profile') {
    var profileQuery = null;
    if (data.data.NSCLIENT_ID) {
      profileQuery = { NSCLIENT_ID: literal(data.data.NSCLIENT_ID) };
    } else if (data.data.startDate) {
      profileQuery = { startDate: literal(data.data.startDate) };
    }
    if (profileQuery) {
      try {
        var existingProfile = await reads.findOne(mongoCollection, profileQuery);
        if (existingProfile) {
          var replacementDoc = Object.assign({}, data.data);
          replacementDoc._id = existingProfile._id;
          srvDates.carry(replacementDoc, existingProfile, srvDates.next());
          await writes.replace(mongoCollection, { _id: existingProfile._id }, replacementDoc);
          return { kind: 'replaced', record: replacementDoc };
        }
      } catch (err) {
        throw caught('exact-match', err);
      }
    }
    try {
      srvDates.stampCreated(data.data);
      var profileInsertResult = await insertDocument(mongoCollection, data.data);
      var profileDoc = data.data;
      profileDoc._id = profileInsertResult.insertedId;
      return { kind: 'inserted', record: profileDoc };
    } catch (err) {
      throw caught('insert', err);
    }
  }
}

async function targetUnitsUpdates (env, mongoCollection, match, setFields) {
  var stored = match.many
    ? await reads.findAll(mongoCollection, match.filter)
    : [await reads.findOne(mongoCollection, match.filter)].filter(Boolean);
  var anyTarget = false;
  var updates = stored.map(function (doc) {
    var fields = Object.assign({}, setFields);
    if (writeValidation.mode(env) !== 'off' && writeValidation.touchesDomain(setFields)) {
      validatedUpdate.checkedUpdate({ $set: Object.assign({}, fields) }, doc, { env: env, source: 'socket' });
    }
    if (targetUnits.normalizeTargetUnits(fields, doc)) anyTarget = true;
    return { stored: doc, fields: fields };
  });
  if (!anyTarget) return null;
  var first = JSON.stringify(updates[0].fields);
  var uniform = updates.every(function (u) { return JSON.stringify(u.fields) === first; });
  return uniform ? { fields: updates[0].fields } : { each: updates };
}

// dbUpdate's write; returns the match it wrote by.
async function dbUpdate (env, mongoCollection, data) {
  var match = idMatch(data._id);
  var setFields = data.data;
  if (servedByV3(data.collection)) {
    setFields = Object.assign({}, data.data);
    srvDates.stampModified(setFields);
  }
  var converted = data.collection === 'treatments' && targetUnits.touches(setFields)
    ? await targetUnitsUpdates(env, mongoCollection, match, setFields) : null;
  if (converted && converted.fields) setFields = converted.fields;
  if (converted && converted.each) {
    for (var c = 0; c < converted.each.length; c += 1) {
      var convertedUpdate = mergePatch.toMongo(mergePatch.update(converted.each[c].stored, converted.each[c].fields));
      if (Object.keys(convertedUpdate).length > 0) {
        await writes.update(mongoCollection, { _id: converted.each[c].stored._id }, convertedUpdate, { one: true });
      }
    }
  } else if (!mergePatch.differsFromSet(setFields)) {
    await writes.update(mongoCollection, match.filter, { $set: setFields }, { one: !match.many });
  } else {
    var targets = match.many
      ? await reads.findAll(mongoCollection, match.filter)
      : [await reads.findOne(mongoCollection, match.filter)].filter(Boolean);
    for (var t = 0; t < targets.length; t += 1) {
      var parts = mergePatch.update(targets[t], setFields);
      var mergeUpdate = mergePatch.toMongo(parts);
      if (Object.keys(mergeUpdate).length > 0) {
        await writes.update(mongoCollection, { _id: targets[t]._id }, mergeUpdate, { one: true });
      }
    }
  }
  return match;
}

// dbUpdateUnset's write; returns the match it wrote by.
async function dbUpdateUnset (env, mongoCollection, data) {
  var unsetMatch = idMatch(data._id);
  var unsetUpdate = { $unset: data.data };
  if (servedByV3(data.collection)) {
    var unsetFields = Object.assign({}, data.data);
    delete unsetFields.srvModified;
    delete unsetFields.srvCreated;
    unsetUpdate = { $set: {} };
    srvDates.stampModified(unsetUpdate.$set);
    if (Object.keys(unsetFields).length > 0) unsetUpdate.$unset = unsetFields;
  }
  await writes.update(mongoCollection, unsetMatch.filter, unsetUpdate, { one: !unsetMatch.many });
  return unsetMatch;
}

module.exports = { idMatch, preflight, processSingleDbAdd, dbUpdate, dbUpdateUnset };
