'use strict';

const traverse = require('traverse');
const ObjectID = require('mongodb').ObjectId;
const moment = require('moment');
const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TWO_DAYS = 172800000;
/**
 * @module query utilities
 * Assist in translating objects from query-string representation into
 * mongo-style queries by performing type translation.
 */

/**
  * Options for query.
  * Interpret and return the options to use for building our query.
  *
  * @returns {Object} Options for create, below.
```
  * { deltaAgo: <ms> // ms ago to constrain queries missing any query body
    , dateField: "date" // name of field to ensure there is a valid query body
    , walker: <walker-spec> // a mapping of names to types
    }
```
  */
function default_options (opts) {
  opts = opts || { };
  if (opts) {
    var keys = [null].concat(Object.keys(opts));

    // default at least TWO_DAYS of data
    // TODO: discuss/consensus on right value/ENV?
    if (keys.indexOf('deltaAgo') < 1) {
      opts.deltaAgo = ( TWO_DAYS * 2 );
    }

    // default at `date` and `sgv` properties are both int-types.
    if (keys.indexOf('walker') < 1) {
      opts.walker = { date: parseInt, sgv: parseInt };
    }

    // The default field to constrain is called 'date' for entries module.
    // Allow other models/backends to use other fields names.
    opts.dateField = opts.dateField || 'date';
  }
  return opts;
}

/**
  * Enforce rule that says that the query must express some constraint on the
  * configured `dateField` or against the field named `dateString`.  If the
  * configured option `useEpoch` is set, the naive JS epoch is used, otherwise
  * ISO 8601 is used.  The rule ensures that records must have a date field
  * with a date and time greater than or equal to the configured `deltaAgo`
  * option, (`opts.deltaAgo`).
  */
function enforceDateFilter (query, opts) {
  var dateValue = query[opts.dateField];

  // rewrite dates to ISO UTC strings so queries work as expected
  if (dateValue) {
    Object.keys(dateValue).forEach(function(key) {
      let dateString = dateValue[key];
      if (isNaN(dateString)) {
        dateString = dateString.replace(' ', '+'); // some clients don't excape the plus

        const validDate = moment(dateString).isValid();

        if (!validDate) {
          console.error('API request using an invalid date:', dateString);
          throw new Error('Cannot parse ' + dateString + ' as a valid ISO-8601 date');
        }

        const d = moment.parseZone(dateString);
        dateValue[key] = d.toISOString();
      }
    });
  }

  if (!dateValue && !query.dateString && true !== opts.noDateFilter) {
    var minDate = Date.now( ) - opts.deltaAgo;
    query[opts.dateField] = {
      $gte: opts.useEpoch ? minDate : new Date(minDate).toISOString()
    };
  }
}

/**
  * Helper to set ObjectID type for `_id` queries.
  * Forces anything named `_id` to be the `ObjectID` type.
  * When opts.uuidHandling is true, UUID _id values search by identifier field.
  */
function updateIdQuery (query, opts) {
  if (!Object.prototype.hasOwnProperty.call(query, '_id')) {
    return;
  }

  if (typeof query._id === 'string') {
    var result = normalizeIdValue(query._id, opts);
    if (result.searchByIdentifier) {
      // UUID detected with uuidHandling enabled
      // Use $or to match both new docs (identifier field) and legacy docs (UUID in _id)
      query.$or = [{ identifier: result.value }, { _id: result.value }];
      delete query._id;
    } else {
      query._id = result.value;
    }
    return;
  }

  if (query._id && typeof query._id === 'object') {
    traverse(query._id).forEach(function (x) {
      if (this.isLeaf) {
        var result = normalizeIdValue(x, opts);
        // For complex queries (like $in), we only handle ObjectIDs
        // UUID handling in complex queries would require more work
        this.update(result.value);
      }
    });
  }
}

/**
 * Normalize an _id value for MongoDB queries.
 * @param {string} value - The _id value to normalize
 * @param {Object} opts - Options including uuidHandling flag
 * @returns {Object} { value: normalized, searchByIdentifier: boolean }
 */
function normalizeIdValue (value, opts) {
  if (typeof value === 'string' && OBJECT_ID_HEX_RE.test(value)) {
    return { value: new ObjectID(value), searchByIdentifier: false };
  }

  // Check if it's a UUID and uuidHandling is enabled
  if (typeof value === 'string' && UUID_RE.test(value) && opts && opts.uuidHandling) {
    return { value: value, searchByIdentifier: true };
  }

  // Unknown format - return as-is (will likely return 0 results)
  return { value: value, searchByIdentifier: false };
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
  // setup default options for what/how to do things
  opts = default_options(opts);
  // Build the iterator, pass it our initial params to et the results.
  var finder = walker(opts.walker)(params);
  // Get the final query to pass to mongodb.
  var query = finder && finder.find ? finder.find : { };

  // Ensure some kind of sane date constraint tied to an index is expressed in the query.
  // unless an ID is provided, in which case assume the user knows what they are doing.
  if (! query._id ) {
    enforceDateFilter(query, opts);
  }

  // Help queries for _id (pass opts for UUID handling)
  updateIdQuery(query, opts);

  //console.info('query:', query);
  // Ready for mongodb.find( ) and friends.
  return query;
}

/**
  * Configure a single iterator given a specification of named mapped to types.
  * @params Object spec A simple mapping of field names to function to create that type.
  *
  * Example spec: { sgv: parseInt }
  * @returns function Function will translate types expressed in query.
  */
function walker (spec) {
  // empty queue
  var fns = [ ];

  // for each key/value pair in the spec
  var keys = Object.keys(spec);
  keys.forEach(function config (prop) {
    var typer = spec[prop];
    // add function from walk_prop to the queue
    fns.push(walk_prop(prop, typer));
  });

  /**
    * Execute all configured mappings in single step.
    * @param Object obj QueryString object
    * @returns Object for mongodb queries, with fields set to appropriate type
        described by previous mapping.
    */
  function exec (obj) {
    var fn;
    // for each mapping in the queue
    while (fns.length > 0) {
      fn = fns.shift( );
      // do each mapping
      obj = fn(obj);
    }
    return obj;
  }
  // return a function that can execute the configured queue of translations
  return exec;
}

/**
  * Given a name and a type, return a function which will transform any value
  * on a leaf-node into that type.
  * @param String prop Property name to to translate.
  * @param function typer Function to convert to type, eg `parseInt`
  */
function walk_prop (prop, typer) {
  function iter (opts) {
    // This is specifically configured to match the `find` convention in our REST API.
    // Query parameters are the ones attached to the `find` object.
    if (opts && opts.find && opts.find[prop]) {
      if (typeof opts.find[prop] === 'string') {
        //simple string property, no need to traverse
        opts.find[prop] = typer(opts.find[prop]);
      } else {
        // Traverse any query elements associated with this property.
        traverse(opts.find[prop]).forEach(function (x) {
          // In Mongo queries, the leaf nodes are always the values to search for.
          // Ignore any interstitial arrays/objects to represent
          // greater-than-or-equal-to, etc.
          if (this.isLeaf) {
            // Leaf nodes should be converted to this type.
            this.update(typer(x));
          }
        });
      }
    }
    // Return opts after modifying in place.
    return opts;
  }
  return iter;
}

function parseRegEx (str) {
  var regtest = /\/(.*)\/(.*)/.exec(str);
  if (regtest) {
    return new RegExp(regtest[1],regtest[2]);
  }
  return str;
}

// attach helpers and utilities to main function for testing
walker.walk_prop = walk_prop;
create.walker = walker;
create.parseRegEx = parseRegEx;
create.default_options = default_options;
create.normalizeIdValue = normalizeIdValue;

// expose module as single high level function
exports = module.exports = create;
