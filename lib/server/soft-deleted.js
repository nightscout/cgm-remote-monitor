'use strict';

// A record stored with `isValid: false` is deleted.
//
// API v3 DELETE does not remove a record: it keeps it with `isValid: false`
// and a new `srvModified`, so that a client syncing by v3 history (AndroidAPS
// NSClientV3) learns of the deletion (lib/api3/generic/delete/operation.js).
// AndroidAPS on the v1 websocket deletes the same way, with a dbUpdate that
// sets `isValid: false`. v3 search leaves such records out; v3 history returns
// them, which is how a client learns of the delete.
//
// Everything else the site shows or computes with reads through the v1
// storage modules (lib/server/<collection>.js), the dataloader and the cache.
// Those leave deleted records out too, so a deleted carb or insulin entry no
// longer counts in COB or IOB, and v1 reads, reports and followers stop
// returning it. A v1 read that names `isValid` in its `find` asks for it
// explicitly and gets exactly what it asked for, so a tool can still list the
// deleted records with `find[isValid]=false`.
//
// Deletes and purges are not filtered: a v1 DELETE still removes deleted
// records along with the rest.

function notDeleted () {
  return { isValid: { $ne: false } };
}

function asksForIsValid (opts) {
  return !!(opts && opts.find && typeof opts.find === 'object'
    && Object.prototype.hasOwnProperty.call(opts.find, 'isValid'));
}

// The query, restricted to records that are not deleted, unless the caller
// named isValid itself.
function visible (query, opts) {
  if (asksForIsValid(opts)) return query;
  if (!query || typeof query !== 'object' || Object.keys(query).length === 0) {
    return notDeleted();
  }
  if (!Object.prototype.hasOwnProperty.call(query, 'isValid')) {
    return Object.assign({}, query, notDeleted());
  }
  return { $and: [query, notDeleted()] };
}

function isDeleted (doc) {
  return !!doc && doc.isValid === false;
}

module.exports = {
  visible: visible,
  isDeleted: isDeleted,
  notDeleted: notDeleted
};
