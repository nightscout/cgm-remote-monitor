'use strict';

const assertNoQueryJavascript = require('../storage/assert-no-query-javascript');
const assertAllowedQueryOperators = require('./query-operator-allowlist');

const traverse = require('traverse');
const coercion = require('./query-coercion');
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
    , collection: "treatments" // schema name, to type fields from the schema
    }
```
  *
  * `collection` is the preferred way to get type conversion: the field types
  * come from that collection's schema, so every declared field is converted
  * and none is converted to the wrong type. `walker` remains for conversions
  * that are not type claims -- treatments turns `notes` into a regular
  * expression as a search affordance -- and an entry in `walker` wins over the
  * schema for the same field.
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

    // Without a named collection there is no schema to consult, so fall back
    // to assuming `date` and `sgv` are int-typed, as this module always has.
    // With one, the schema supplies the types and this guess would override it.
    if (keys.indexOf('walker') < 1) {
      opts.walker = opts.collection ? { } : { date: parseInt, sgv: parseInt };
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
        // Repair an unescaped positive UTC offset without changing the date/time separator.
        dateString = dateString.replace(/([T ]\d[\d:.,]*) (\d{2}:\d{2}|\d{4}|\d{2})$/, '$1+$2');

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
/**
  * Operators whose operand is a yes/no question rather than a value drawn from
  * the field's own domain.
  *
  * Every operand in a query string arrives as text, so `find[x][$exists]=false`
  * reaches MongoDB as the STRING "false". MongoDB reads that as **true**: its
  * truthiness for a string is "any string, including the empty one", so the
  * request is answered with exactly the documents it asked to exclude, under
  * HTTP 200. Nothing warns the caller.
  *
  * Measured on mongod 3.6.8 and 7.0.43, identical on both, over the two
  * documents `[{_id: 1, sgv: 100}, {_id: 2}]`:
  *
  * ```
  *   {$exists: false}  -> [2]      {$exists: "false"} -> [1]
  *   {$exists: 0}      -> [2]      {$exists: "0"}     -> [1]
  *   {$exists: null}   -> [2]      {$exists: ""}      -> [1]
  * ```
  *
  * This is wrong on EVERY field, not only the ones with a declared type: a
  * field the type table does not name is never walked at all, so its operand
  * arrives as the raw string either way.
  */
const BOOLEAN_OPERANDS = { $exists: true };

/**
  * Read the four unambiguous spellings of a yes/no operand and leave every
  * other value exactly as it arrived.
  *
  * The empty string is deliberately NOT read as false. `?find[sgv][$exists]`
  * with no value is as easily "yes, I want this flag" as "no, I do not" -- and
  * it is reachable, because a valueless parameter parses to `''`. Guessing
  * would silently invert somebody's query, which is the defect this function
  * exists to remove, not a licence to commit it in the other direction.
  * Anything else unrecognised is passed through for the same reason.
  *
  * @param {*} value The operand as it arrived.
  * @returns {*} A boolean for a recognised spelling, otherwise `value`.
  */
function readBooleanOperand (value) {
  if (typeof value !== 'string') { return value; }
  var lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === '1') { return true; }
  if (lowered === 'false' || lowered === '0') { return false; }
  return value;
}

/**
  * Apply the operand readers to a finished query, wherever the operator
  * appears.
  *
  * This runs over the built query rather than inside the per-field walker on
  * purpose. The walker only visits fields that have a declared type, so a fix
  * placed there would close this for a typed `sgv` and leave it open for every
  * field the schema does not name -- which is most of them. Keying on the
  * operator also means `{$not: {$exists: "false"}}` is handled at whatever
  * depth it occurs.
  *
  * @param {Object} query The query object, modified in place.
  * @returns {Object} The same query.
  */
function normalizeOperands (query) {
  traverse(query).forEach(function each (x) {
    if (typeof this.key === 'string' && BOOLEAN_OPERANDS[this.key]) {
      this.update(readBooleanOperand(x));
    }
  });
  return query;
}

function create (params, opts) {
  // Runs on the caller's literal `find`, before any of the rewriting below, so
  // the operator named in the error is one the caller actually typed rather
  // than the $gte enforceDateFilter() adds or the $or updateIdQuery() mints.
  assertNoQueryJavascript(params && params.find);
  // The JavaScript guard goes first because 'server-side JavaScript' says more
  // than 'unsupported operator' about why $where is refused. The allowlist then
  // refuses every other operator outside the supported set.
  assertAllowedQueryOperators(params && params.find);
  // setup default options for what/how to do things
  opts = default_options(opts);
  // Build the iterator, pass it our initial params to et the results.
  var finder = walker(schemaWalker(params, opts))(params);
  // Get the final query to pass to mongodb.
  var query = finder && finder.find ? finder.find : { };

  // Ensure some kind of sane date constraint tied to an index is expressed in the query.
  // unless an ID is provided, in which case assume the user knows what they are doing.
  if (! query._id ) {
    enforceDateFilter(query, opts);
  }

  // Help queries for _id (pass opts for UUID handling)
  updateIdQuery(query, opts);

  // Read yes/no operands that arrived as text. See normalizeOperands.
  normalizeOperands(query);

  //console.info('query:', query);
  // Ready for mongodb.find( ) and friends.
  return query;
}

/**
  * Combine the caller's explicit `walker` with the types declared for
  * `opts.collection`, for the fields this query actually mentions.
  *
  * Only the query's own fields are looked up, so a collection with hundreds of
  * declared fields costs no more than the handful being filtered on. An
  * explicit `walker` entry is left alone: those express intent the schema does
  * not carry, such as treating `notes` as a regular expression.
  *
  * @param Object params QueryString object.
  * @param BuilderOpts opts Options, possibly naming a `collection`.
  * @returns Object A walker spec.
  */
function schemaWalker (params, opts) {
  var spec = opts.walker || { };
  var find = params && params.find;

  if (!opts.collection || !find || typeof find !== 'object') {
    return spec;
  }

  var combined = null;
  Object.keys(find).forEach(function each (field) {
    if (Object.prototype.hasOwnProperty.call(spec, field)) {
      return;
    }
    var typer = coercion.coercerFor(opts.collection, field);
    if (!typer) {
      return;
    }
    if (!combined) {
      combined = Object.assign({ }, spec);
    }
    combined[field] = typer;
  });

  return combined || spec;
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
          //
          // Some operators take an operand that is not one of the field's
          // values: `{$exists: 'true'}` is a yes/no question and
          // `{$regex: '^a'}` is a pattern. Converting those breaks them, so
          // leave them as they arrived.
          if (this.isLeaf) {
            if (coercion.isValueLeaf(this.path)) {
              // Leaf nodes should be converted to this type.
              this.update(typer(x));
            } else {
              // A non-value operand may still have a type of its own -- $type
              // takes a BSON code. Most have none and are left alone.
              var reader = coercion.operandReaderFor(this.path);
              if (reader) { this.update(reader(x)); }
            }
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
create.readBooleanOperand = readBooleanOperand;
create.normalizeOperands = normalizeOperands;
create.parseRegEx = parseRegEx;
create.default_options = default_options;
create.schemaWalker = schemaWalker;
create.normalizeIdValue = normalizeIdValue;

// expose module as single high level function
exports = module.exports = create;
