'use strict';

// JSON Merge Patch (RFC 7386) for the write paths that merge into a stored
// record: every matched re-send (a create that matches a stored record, on
// API v1, in-process, API v3 and the socket's profile dbAdd; ID-Q8), API v3
// PATCH and the socket's dbUpdate (write-contract Q1b, decided 2026-10-26).
//
// A member sent as null removes that member from the stored record, at any
// depth. An object merges into the stored object member by member. Anything
// else (a string, a number, an array, a Date, an ObjectId) replaces the
// stored value whole; arrays are values, as RFC 7386 says, and a null inside
// an array is kept.
//
// The rule applies only after the target is resolved and only when a stored
// record matched. A create, including an upsert that turns out to be one,
// stores what it is sent, nulls included; a replace (v1 PUT, v3 PUT) stores
// the body as sent. Callers decide which case they are in; this module only
// computes the merge.
//
// This is the one place the rule lives. The write step
// (lib/storage/write-intent.js) calls it for every merge on match (ID-Q8: a
// matched re-send merges on every path; only PUT and save replace).

var isDeepStrictEqual = require('util').isDeepStrictEqual;

function isPlainObject (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  var proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn (obj, key) {
  return obj !== null && obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

// RFC 7386 section 2, MergePatch(target, patch). Returns a new value and
// changes neither argument.
function apply (target, patch) {
  if (!isPlainObject(patch)) return patch;
  var result = isPlainObject(target) ? Object.assign({}, target) : {};
  Object.keys(patch).forEach(function (key) {
    if (patch[key] === null) {
      delete result[key];
    } else {
      result[key] = apply(result[key], patch[key]);
    }
  });
  return result;
}

// The update a merge patch makes to a stored top-level document, as the
// members to set (each the merged value of that member) and the members to
// remove. Only the members the patch names are touched; `skip` lists members
// to leave out of the update altogether; `whole` lists top-level members whose
// sent value replaces the stored one, without a member-by-member merge (a
// profile's `store` on a re-send, ID-Q7): the patch is applied to nothing, so
// the value is stored as sent with its nulls removed, and a null removes it.
// `changed` is false when the merge leaves the stored document as it is.
//
// The update is computed per top-level member from the stored value rather
// than as dotted paths, so a key that contains a dot (a profile named
// "Profile 1.5" in store, say) is merged as a key, not read as a path.
function update (stored, patch, options) {
  var skip = (options && options.skip) || [];
  var whole = (options && options.whole) || [];
  var set = {};
  var unset = {};
  var changed = false;
  Object.keys(patch).forEach(function (key) {
    if (skip.indexOf(key) !== -1) return;
    var value = patch[key];
    if (value === null) {
      unset[key] = '';
      if (hasOwn(stored, key)) changed = true;
      return;
    }
    // A member taken whole is the patch applied to nothing: the value as
    // sent, its nulls removed (RFC 7386 on an absent target).
    var merged = apply(whole.indexOf(key) === -1 && hasOwn(stored, key) ? stored[key] : undefined, value);
    set[key] = merged;
    if (!hasOwn(stored, key) || !isDeepStrictEqual(merged, stored[key])) changed = true;
  });
  return { set: set, unset: unset, changed: changed };
}

// The MongoDB update document for update()'s result.
function toMongo (parts) {
  var out = {};
  if (Object.keys(parts.set).length > 0) out.$set = parts.set;
  if (Object.keys(parts.unset).length > 0) out.$unset = parts.unset;
  return out;
}

// Write update()'s result onto an in-memory copy of the stored document.
function assignInto (stored, parts) {
  Object.assign(stored, parts.set);
  Object.keys(parts.unset).forEach(function (key) { delete stored[key]; });
  return stored;
}

// Whether a merge patch can differ from a plain top-level $set of the same
// members: only a null member or an object member can. A patch with neither
// needs no stored copy to apply.
function differsFromSet (patch) {
  return Object.keys(patch).some(function (key) {
    return patch[key] === null || isPlainObject(patch[key]);
  });
}

module.exports = {
  apply: apply
  , update: update
  , toMongo: toMongo
  , assignInto: assignInto
  , differsFromSet: differsFromSet
  , isPlainObject: isPlainObject
};
