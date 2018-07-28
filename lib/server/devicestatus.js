'use strict';

var moment = require('moment');
var find_options = require('./query');

function storage (collection, ctx) {
  var ObjectID = require('mongodb').ObjectID;

  function create(obj, fn) {
    if (! obj.hasOwnProperty('created_at')){
      obj.created_at = (new Date()).toISOString();
    }
    api().insert(obj, function (err, doc) {
      fn(null, doc.ops);
      ctx.bus.emit('data-received');
    });
  }

  function last(fn) {
    return list({count: 1}, function (err, entries) {
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

  function list(opts, fn) {
    // these functions, find, sort, and limit, are used to
    // dynamically configure the request, based on the options we've
    // been given

    // determine sort options
    function sort ( ) {
      return opts && opts.sort || {created_at: -1};
    }

    // configure the limit portion of the current query
    function limit ( ) {
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
    limit.call(api( )
        .find(query_for(opts))
        .sort(sort( ))
    ).toArray(toArray);
  }

  function remove (_id, fn) {
    var filter;
    if (_id === '*') {
      filter = {};
    } else {
      filter = { '_id': new ObjectID(_id) };
    }
    return api( ).remove(filter, fn);
  }

  function removeOld (date, fn) {
    var filter;
    var year;
    var endMonth;
    var month;
    var monthStr;
    var day;
    var dayStr;
    var retVal = null;

    var firstErr = null,
        numDeletes = 0,
        totalDeletes = 0;

    var endDate = moment(date);
    endMonth = endDate.month() + 1;

    numDeletes = endDate.year() - 2015;
    numDeletes += endMonth;
    numDeletes += endDate.date();

    function removeOldFn (err) {
      firstErr = firstErr || err;
      if (++totalDeletes === numDeletes) {
        //TODO: this is triggering a read from Mongo, we can do better
        ctx.bus.emit('data-received');
        console.info('Finished deleting old data');
        fn(firstErr, date);
      }
    }

    console.info('Deleted devicestatus data prior to ' + endDate.format());

    // Delete all data prior to year in endDate
    for (year=2015; year < endDate.year(); ++year) {
      filter = { 'created_at': '/^' + year + '/' };
      retVal = api( ).remove(filter, removeOldFn);
    }

    // Delete all data prior to month in endDate
    for (month=1; month < endMonth; ++month) {
      monthStr = (month >= 10) ? month : '0' + month;
      filter = { 'created_at': '/^' + year + '-' + monthStr + '/' };
      retVal = api( ).remove(filter, removeOldFn);
    }

    monthStr = (month >= 10) ? month : '0' + month;

    // Delete all data prior to day in endDate
    for (day=1; day < endDate.date(); ++day) {
      dayStr = (day >= 10) ? day : '0' + day;
      filter = { 'created_at': '/^' + year + '-' + monthStr + '-' + dayStr + '/' };
      retVal = api( ).remove(filter, removeOldFn);
    }

    // TODO: provide a reasonable return value instead
    // of only the last one.
    return retVal;
  }

  function api() {
    return ctx.store.collection(collection);
  }

  api.list = list;
  api.create = create;
  api.query_for = query_for;
  api.last = last;
  api.remove = remove;
  api.removeOld = removeOld;
  api.aggregate = require('./aggregate')({ }, api);
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
