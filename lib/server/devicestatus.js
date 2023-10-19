'use strict';

var moment = require('moment');
var find_options = require('./query');

function storage (collection, ctx) {

  function create (statuses, fn) {

    if (!Array.isArray(statuses)) { statuses = [statuses]; }

    const r = [];
    let errorOccurred = false;

    for (let i = 0; i < statuses.length; i++) {

      const obj = statuses[i];

      if (errorOccurred) return;

      // Normalize all dates to UTC
      const d = moment(obj.created_at).isValid() ? moment.parseZone(obj.created_at) : moment();
      obj.created_at = d.toISOString();
      obj.utcOffset = d.utcOffset();

      api().insertOne(obj, function(err, results) {

        if (err) {
          console.log('Error inserting the device status object', err.message);
          errorOccurred = true;
          fn(err.message, null);
          return;
        }

        if (results) {
          if (!obj._id) obj._id = results.insertedId;
          r.push(obj);

          ctx.bus.emit('data-update', {
            type: 'devicestatus'
            , op: 'update'
            , changes: ctx.ddata.processRawDataForRuntime([obj])
          });

          // Last object! Return results
          if (i == statuses.length - 1) {
            fn(null, r);
            ctx.bus.emit('data-received');
          }
        } else {
          console.log('Error inserting the device status object', err.message);
          errorOccurred = true;
          fn(err.message, null);
          return;
        }
      });
    };
  }

  function last (fn) {
    return list({ count: 1 }, function(err, entries) {
      if (entries && entries.length > 0) {
        fn(err, entries[0]);
      } else {
        fn(err, null);
      }
    });
  }

  function query_for (opts) {
    return find_options(opts, storage.queryOpts);
  }

  function list (opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort () {
      return opts && opts.sort || { created_at: -1 };
    }

    // configure the limit portion of the current query
    function limit () {
      if (opts && opts.count) {
        return this.limit(parseInt(opts.count));
      }
      return this;
    }

    // handle all the results
    function toArray (err, entries) {
      fn(err, entries);
    }

    // now just stitch them all together
    limit.call(api()
      .find(query_for(opts))
      .sort(sort())
    ).toArray(toArray);
  }

  function remove (opts, fn) {

    function removed (err, stat) {

      console.log('removed', err, stat);

      ctx.bus.emit('data-update', {
        type: 'devicestatus'
        , op: 'remove'
        , count: stat.deletedCount
        , changes: opts.find._id
      });

      fn(err, stat);
    }

    return api().deleteMany(
      query_for(opts), removed);
  }

  function api () {
    return ctx.store.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.aggregate = require('./aggregate')({}, api);
  api.indexedFields = [
    'created_at'



  
    , 'NSCLIENT_ID'
  ];
  return api;
}

storage.queryOpts = {
  dateField: 'created_at'
};

module.exports = storage;
