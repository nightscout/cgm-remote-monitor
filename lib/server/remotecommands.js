'use strict';

var find_options = require('./query');

function storage(collection, ctx) {
  var ObjectID = require('mongodb').ObjectID;

  function create(obj, fn) {
    obj.created_at = (new Date()).toISOString();
    api().insert(obj, function (err, doc) {
      if (err != null && err.message) {
        console.log('Data insertion error', err.message);
        fn(err.message, null);
        return;
      }
      fn(null, doc);
    });
    ctx.bus.emit('data-received');
  }

  function save(id, update, fn) {
    const objectID = new ObjectID(id)
    let filter = {_id: objectID}

    //If trying to set it in  in-progress, it is required
    //that the state be in Pending to avoid race conditions.
    if (update.status != undefined && update.status.state != undefined && update.status.state == "In-Progress") {
      filter = {
        "status.state": "Pending",
        _id: objectID
      }
    }

    api().findOneAndUpdate (
      filter,
      {"$set": update},
      {returnOriginal: false},
      (err, updateResult) => {
        fn(err, updateResult)
      }
    )
    ctx.bus.emit('data-received');
  }

  function list(opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort() {
      return opts && opts.sort || { created_at: -1 };
    }

    // configure the limit portion of the current query
    function limit() {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    // handle all the results
    function toArray(err, entries) {
      fn(err, entries);
    }

    /*
    TODO: Remove this comment before merge.

    Documenting a confusing flow to non-Javascript devs, like me, in case this needs augmented before merge:

    - The api().find..sort commands are executed before the limit part is involved.
    - The limit.call is an interesting method on the Function type (like a Swift extension)... It allows you to call a function (limit) on its argument -- the cursor from api().find..sort.
    - Inside limit() above, "this" is the cursor
    - The this.limit(parseInt) is actually a method in Mongo db.
    - If an error is encountered before toArray, the fn callback is not triggered. The error is unhandled which travels the Express stack somehow and is included in the response.

    If the error needs to be caught in here, consider calling query_for in a try/catch before using limit. 
    */

    // now just stitch them all together
    limit.call(api()
      .find(query_for(opts))
      .sort(sort())
    ).toArray(toArray);
  }

  function query_for(opts) {
    return find_options(opts, storage.queryOpts);
  }

  function remove(opts, fn) {

    function removed(err, stat) {

      ctx.bus.emit('data-update', {
        type: 'remotecommands'
        , op: 'remove'
        , count: stat.result.n
        , changes: opts.find._id
      });

      fn(err, stat);
    }

    return api().remove(
      query_for(opts), removed);
  }

  function api() {
    return ctx.store.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.save = save;
  api.remove = remove;
  api.indexedFields = ['name']; //TODO: Other things to index?
  return api;
}

storage.queryOpts = {
  walker: {
    otp: String,
    sendNotification: JSON.parse,
    _id: String
  },
  dateField: 'created_at'
};

module.exports = storage;