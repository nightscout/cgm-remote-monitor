'use strict';

var traverse = require('traverse');
var ObjectID = require('mongodb').ObjectID;

var TWO_DAYS = 172800000;
/**
 * @module query utilities
 * Assist in translating objects from query-string representation into
 * mongo-style queries by performing type translation.
 */

/**
  * Options for query.
  * Interpret and return the options to use for building our query.
  *
  * @returns Object Options for create, below.
  * { deltaAgo: <ms> // ms ago to constrain queries missing any query body
    , dateField: "date" // name of field to ensure there is a valid query body
    , walker: <walker-spec> // a mapping of names to types
    }
  */
function default_options (opts) {
  opts = opts || { };
  if (opts) {
    var keys = [null].concat(Object.keys(opts));

    if (keys.indexOf('deltaAgo') < 1) {
      opts.deltaAgo = ( TWO_DAYS * 2 );
    }
    if (keys.indexOf('walker') < 1) {
      opts.walker = { date: parseInt, sgv: parseInt };
    }

    opts.dateField = opts.dateField || 'date';
  }
  return opts;
}

function enforceDateFilter (query, opts) {
  var dateValue = query[opts.dateField];

  if (!dateValue && !query.dateString) {
    var minDate = Date.now( ) - opts.deltaAgo;
    query[opts.dateField] = {
      $gte: opts.useEpoch ? minDate : new Date(minDate).toISOString()
    };
  }
}

function updateIdQuery (query) {
  if (query._id && query._id.length) {
    query._id = ObjectID(query._id);
  }
}

/**
  * @param QueryParams params Object returned by qs.parse or https://github.com/hapijs/qs
  * @param BuilderOpts opts Options for how to translate types.
  * 
  * Allows performing logic described by a model's attributes.
  * Specifically, we try to ensure that all queries have some kind of query
  * body to filter the rows mongodb will spool.  The defaults, such as name and
  * representation of a date field can be configured via the `opts` passed in.
  *
  * @returns Object An object which can be passed to `mongodb.find( )`
  */

function create (params, opts) {
  opts = default_options(opts);
  var finder = walker(opts.walker)(params);
  var query = finder && finder.find ? finder.find : { };

  enforceDateFilter(query, opts);
  updateIdQuery(query);

  return query;
}

function walker (spec) {
  var fns = [ ];
  var keys = Object.keys(spec);
  keys.forEach(function config (prop) {
    var typer = spec[prop];
    fns.push(walk_prop(prop, typer));
  });

  function exec (obj) {
    var fn;
    while (fns.length > 0) {
      fn = fns.shift( );
      obj = fn(obj);
    }
    return obj;
  }
  return exec;
}

function walk_prop (prop, typer) {
  function iter (opts) {
    if (opts && opts.find && opts.find[prop]) {
      traverse(opts.find[prop]).forEach(function (x) {
        if (this.isLeaf) {
          this.update(typer(x));
        }
      });
    }
    return opts;
  }
  return iter;
}

walker.walk_prop = walk_prop;
create.walker = walker;
create.default_options = default_options;

exports = module.exports = create;

