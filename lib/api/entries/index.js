'use strict';

var _ = require('lodash');
var consts = require('../../constants');
var es = require('event-stream');
var sgvdata = require('sgvdata');
var expand = require('expand-braces');

var ID_PATTERN = /^[a-f\d]{24}$/;
function isId (value) {
  //TODO: why did we need tht length check?
  return value && ID_PATTERN.test(value) && value.length === 24;
}

/**
  * @module Entries
  * Entries module
  */

/**
  * @method configure
  * Configure the entries module, given an existing express app, common
  * middlewares, and the global app's `ctx`.
  * @param Express app  The express app we'll mount onto.
  * @param Object wares Common middleware used by lots of apps.
  * @param Object ctx The global ctx with all modules, storage, and event buses
  * configured.
  */
function configure (app, wares, ctx) {
  // default storage biased towards entries.
  var entries = ctx.entries;
  var express = require('express'),
      api = express.Router( )
    ;

    // invoke common middleware
    api.use(wares.sendJSONStatus);
    // text body types get handled as raw buffer stream
    api.use(wares.bodyParser.raw());
    // json body types get handled as parsed json
    api.use(wares.bodyParser.json());
    // shortcut to use extension to specify output content-type
    api.use(wares.extensions([
      'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
    ]));
    // also support url-encoded content-type
    api.use(wares.bodyParser.urlencoded({ extended: true }));

    api.use(ctx.authorization.isPermitted('api:entries:read'));
    /**
      * @method force_typed_data
      * @returns {Stream} Creates a through stream which validates that all
      * elements on the stream have a `type` field.
      * Generate a stream that ensures elements have a `type` field.
      */
    function force_typed_data (opts) {
      /**
        * @function sync
        * Iterate over every element in the stream, enforcing some data type.
        */
      function sync (data, next) {
        // if element has no data type, but we know what the type should be
        if (!data.type && opts.type) {
          // bless absence with known type
          data.type = opts.type;
        }
        // continue control flow to next element in the stream
        next(null, data);
      }
      // return configured stream
      return es.map(sync);
    }

    // check for last modified from in-memory data

    function ifModifiedSinceCTX (req, res, next) {

      var lastEntry = _.last(ctx.ddata.sgvs);
      var lastEntryDate = null;
      
      if (!_.isNil(lastEntry)) {
        lastEntryDate = new Date(_.last(ctx.ddata.sgvs).mills);
        res.setHeader('Last-Modified', lastEntryDate.toUTCString());
      }
      
      var ifModifiedSince = req.get('If-Modified-Since');
      if (!ifModifiedSince) { return next(); }
      
      if (lastEntryDate <= new Date(ifModifiedSince)) {
        res.status(304).send({status:304, message: 'Not modified', type:'internal'});
        return;
      }
      
      return next();
    }

    // check for last modified from query results
    
    function ifModifiedSince (req, res, next) {
    
      var lastEntryDate = new Date(_.last(res.entries).dateString);
      res.setHeader('Last-Modified', lastEntryDate.toUTCString());
      
      var ifModifiedSince = req.get('If-Modified-Since');

      if (!ifModifiedSince) { return next(); }
      
      if (lastEntryDate <= new Date(ifModifiedSince)) {
        res.status(304).send({status:304, message: 'Not modified', type:'internal'});
        return;
      }
      
      return next();
    }

    /**
      * @method format_entries
      * A final middleware to send payloads assembled by previous middlewares
      * out to the http client.
      * We expect a payload to be attached to `res.entries`.
      // Middleware to format any response involving entries.
      */
    function format_entries (req, res) {
      // deduce what type of records we might expect
      var type_params = {
        type: (req.query && req.query.find && req.query.find.type
            && req.query.find.type !== req.params.model)
            ? req.query.find.type : req.params.model
      };
      // prepare a stream of elements from some prepared payload
      var output = es.readArray(res.entries || [ ]);
      // on other hand, if there's been some error, report that
      if (res.entries_err) {
        return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', res.entries_err);
      }
      // if no error, format the payload
      // The general pattern here is to create an output stream that reformats
      // the data correctly into the desired representation.
      // The stream logic allows some streams to ensure that some basic rules,
      // such as enforcing a type property to exist, are followed.
      return res.format({
        text: function ( ) {
          res.set('Content-Type', 'text/plain');
          // sgvdata knows how to format sgv entries as text
          es.pipeline(output, sgvdata.format( ), es.writeArray(function (err, out) {
            res.send(out.join(''));
          }));
        },
        csv: function ( ) {
          // sgvdata knows how to format sgv entries as text
          res.set('Content-Type', 'text/plain');
          var csvpipe = require('sgvdata/lib/text')({ format: ',', parse: /[\t,]/ });
          es.pipeline(
              output
              , sgvdata.mapper(csvpipe.format)
              , es.join('\n')
              , es.writeArray(function (err, out) {
                  res.send(out.join(''));
              })
          );
        },
        json: function ( ) {
          // so long as every element has a `type` field, and some kind of
          // date, we'll consider it valid
          es.pipeline(output, force_typed_data(type_params), es.writeArray(function (err, out) {
            res.json(out);
          }));
        }
      });
    }

    /**
      * @method insert_entries
      * middleware to process "uploads" of sgv data
      * This inspects the http requests's incoming payload.  This creates a
      * validating stream for the appropriate type of payload, which is piped
      * into the configured storage layer, saving the results in mongodb.
      */
    // middleware to process "uploads" of sgv data
    function insert_entries (req, res, next) {
      // list of incoming records
      var incoming = [ ];
      // Potentially a single json encoded body.
      // This can happen from either an url-encoded or json content-type.
      if ('date' in req.body) {
        // add it to the incoming list
        incoming.push(req.body);
      }
      // potentially a list of json entries
      if (req.body.length) {
        // add them to the list
        incoming = incoming.concat(req.body);
      }

      /**
        * @function inputs
        * @returns {ReadableStream} Readable stream with all incoming elements
        * in the stream.
        * in node, pipe is the most interoperable interface
        * inputs returns a readable stream representing all the potential
        * records from the HTTP body.
        * Most content-types are handled by express middeware.
        * However, text/* types are given to us as a raw buffer, this
        * function switches between these two variants to find the
        * correct input stream.
        * stream, so use svgdata to handle those.
        * The inputs stream always emits sgv json objects.
        */
      function inputs ( ) {
        var input;
        // handle all text types
        if (req.is('text/*')) {
          // re-use the svgdata parsing stream
          input = es.pipeline(req, sgvdata.parse( ));
          return input;
        }
        // use established list
        return es.readArray(incoming);
      }

      /**
        * @function persist
        * @returns {WritableStream} a writable persistent storage stream
        * Sends stream elements into storage layer.
        * Configures the storage layer stream.
        */
      function persist (fn) {
        if (req.persist_entries) {
          // store everything
          return entries.persist(fn);
        }
        // support a preview mode, just lint everything
        return es.pipeline(entries.map( ), es.writeArray(fn));
      }

      /**
        * @function done
        * Final callback store results on `res.entries`, after all I/O is done.
        * store results and move to the next middleware
        */
      function done (err, result) {
        // assign payload
        res.entries = result;
        res.entries_err = err;
        return next( );
      }

      // pipe everything to persistent storage
      // when finished, pass to the next piece of middleware
      es.pipeline(inputs( ), persist(done));
    }

    /**
      * @function prepReqModel
      * @param {Request} req The request to inspect
      * @param {String} model The name of the model to use if not found.
      * Sets `req.query.find.type` to your chosen model.
      */
    function prepReqModel(req, model) {
      var type =  model || 'sgv';
      if (!req.query.find) {
        req.query.find = {
          type: type
        };
      } else {
        req.query.find.type = type;
      }
    }

    /**
      * @param model
      * Prepare model based on explicit choice in route/path parameter.
      */
    api.param('model', function (req, res, next, model) {
      prepReqModel(req, model);
      next( );
    });

    /**
      * @module get#/entries/current
      * @route
      * Get last entry.
      * @response /definitions/Entries
      */
    api.get('/entries/current', function(req, res, next) {
      //assume sgv
      req.params.model = 'sgv';
      entries.list({count: 1}, function(err, records) {
        res.entries = records;
        res.entries_err = err;
        return next( );
      });
    }, format_entries);

    /**
      * @module get#/entries/:spec
      * @route
      * Fetch one entry by id
      * @response /definitions/Entries
      * @param String spec :spec is either the id of a record or model name to
      * search.  If it is an id, only the record with that id will be in the
      * response.  If the string is a model name, like `sgv`, `mbg`, et al, the
      * usual query logic is performed biased towards that model type.
      * Useful for filtering by type.
      */
    api.get('/entries/:spec', function(req, res, next) {
      if (isId(req.params.spec)) {
        entries.getEntry(req.params.spec, function(err, entry) {
          if (err) { return next(err); }
          res.entries = [entry];
          res.entries_err = err;
          req.query.find = req.query.find || {};
          if (entry) {
            req.query.find.type = entry.type;
          } else {
            res.entries_err = 'No such id: \'' + req.params.spec + '\'';
          }
          next();
        });
      } else {
        req.params.model = req.params.spec;
        prepReqModel(req, req.params.model);
        query_models(req, res, next);
      }
    }, format_entries);


    /**
      * @module get#/entries
      * @route
      * @response /definitions/Entries
      * Use the `find` parameter to generate mongo queries.
      * Default is `count=10`, for only 10 latest entries, reverse sorted by
      * `find[date]`.
      *
      */
    api.get('/entries', ifModifiedSinceCTX, query_models, format_entries);

    /**
      * @function echo_query
      * Output the generated query object itself, instead of the query results.
      * Useful for understanding how REST api parameters translate into mongodb
      * queries.
      */
    function echo_query (req, res) {
      var query = req.query;
      // make a depth-wise copy of the original raw input
      var input = JSON.parse(JSON.stringify(query));

      // If "?count=" is present, use that number to decided how many to return.
      if (!query.count) {
        query.count = 10;
      }
      // bias towards entries, but allow expressing preference of storage layer
      var storage = req.params.echo || 'entries';

      // send payload with information about query itself
      res.json({ query: ctx[storage].query_for(query), input: input, params: req.params, storage: storage});
    }

    /**
      * @function query_models
      * Perform the standard query logic, translating API parameters into mongo
      * db queries in a fairly regimented manner.
      * This middleware executes the query, assigning the payload to results on
      * `res.entries`.
      */
    function query_models (req, res, next) {
      var query = req.query;

      // If "?count=" is present, use that number to decided how many to return.
      if (!query.count) {
        query.count = 10;
      }

      // bias to entries, but allow expressing a preference
      var storage = req.storage || ctx.entries;
      // perform the query
      storage.list(query, function payload (err, entries) {
        // assign payload
        res.entries = entries;
        res.entries_err = err;
        return next( );
      });
    }

    function count_records (req, res, next) {
      var query = req.query;
      var storage = req.storage || ctx.entries;
      storage.aggregate(query, function payload (err, entries) {
        // assign payload
        res.entries = entries;
        res.entries_err = err;
        return next(err);
      });
    }

    function format_results (req, res, next) {
      res.json(res.entries);
      next( );
    }

    /**
      * @function delete_records
      * Delete entries.  The query logic works the same way as find/list.  This
      * endpoint uses same search logic to remove records from the database.
      */
    function delete_records (req, res, next) {
      // bias towards model, but allow expressing a preference
      if (!req.model) {
        req.model = ctx.entries;
      }
      var query = req.query;
      if (!query.count) { query.count = 10 }
      // remove using the query
      req.model.remove(query, function(err, stat) {
        if (err) {
          return next(err);
        }
        // yield some information about success of operation
        res.json(stat);
        return next( );
      });
    }

    /**
      * @param spec
      * Middleware that prepares the :spec parameter in the routed path.
      */
    api.param('spec', function (req, res, next, spec) {
      if (isId(spec)) {
        prepReqModel(req, req.params.model);
        req.query = {find: {_id: req.params.spec}};
      } else {
        prepReqModel(req, req.params.model);
      }
      next( );
    });

    /**
      * @param echo
      * The echo parameter in the path routing parameters allows the echo
      * endpoints to customize the storage layer.
      */
    api.param('echo', function (req, res, next, echo) {
      console.log('echo', echo);
      if (!echo) {
        req.params.echo = 'entries';
      }
      next( );
    });

    /**
      * @module get#/echo/:echo/:model/:spec
      * @routed
      * Echo information about model/spec queries.
      * Useful in understanding how REST API prepares queries against mongo.
      */
    api.get('/echo/:echo/:model?/:spec?', echo_query);

    /**
      * Prepare regexp patterns based on `prefix`, and `regex` parameters.
      * Translates `/:prefix/:regex` strings into fancy mongo queries.
      * @method prep_patterns
      * @params String prefix
      * @params String regex
      * This performs bash style brace/glob pattern expansion in order to generate flexible series of regex patterns.
      * Very useful in querying across days, but constrained hours of time.
      * Consider the following examples:
```
curl -s -g 'http://localhost:1337/api/v1/times/2015-04/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120' | json -a dateString sgv
curl -s -g 'http://localhost:1337/api/v1/times/20{14..15}-04/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120' | json -a dateString sgv
curl -s -g 'http://localhost:1337/api/v1/times/20{14..15}/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120' | json -a dateString sgv

```
      */
    function prep_patterns (req, res, next) {
      // initialize empty pattern list.
      var pattern = [ ];
      // initialize a basic prefix
      // also perform bash brace/glob-style expansion
      var prefix = expand(req.params.prefix || '.*');

      // if expansion leads to more than one prefix
      if (prefix.length > 1) {
        // pre-pend the prefix to the pattern list and wait to expand it as
        // part of the full pattern
        pattern.push('^' + req.params.prefix);
      }
      // append any regex parameters
      if (req.params.regex) {
        // prepend "match any" rule to their rule
        pattern.push('.*' + req.params.regex);
      }
      // create a single pattern with all inputs considered
      // expand the pattern using bash/glob style brace expansion to generate
      // an array of patterns.
      pattern = expand(pattern.join(''));

      /**
        * Factory function to customize creation of RegExp patterns.
        * @method iter_regex
        * @param String prefix Default null
        * @param String suffix Default null
        * @returns function(pat) which turns the given pattern into a new
        * RegExp with the prefix and suffix prepended, and appended,
        * respectively.
        */
      function iter_regex (prefix, suffix) {
        /**
          * @function make
          * @returns RegExp Make a RegExp with configured prefix and suffix
          */
        function make (pat) {
          // concat the prefix, pattern, and suffix.
          pat = (prefix ? prefix : '') + pat + (suffix ? suffix : '');
          // return RegExp.
          return new RegExp(pat);
        }
        // return functor
        return make;
      }

      // save pattern for other middlewares, eg echo, query, etc.
      req.pattern = pattern;
      var matches = pattern.map(iter_regex( ));
      // prepare the query against a configurable field name.
      var field = req.patternField;
      var query = { };
      query[field] = {
          // $regex: prefix,
          // configure query to perform regex against list of potential regexp
          $in: matches
      };
      if (prefix.length === 1) {
        // If there is a single prefix pattern, mongo can optimize this against
        // an indexed field
        query[field].$regex = prefix.map(iter_regex('^')).pop( );
      }

      // Merge into existing query structure.
      if (req.query.find) {
        if (req.query.find[field]) {
          req.query.find[field].$in = query[field].$in;
        } else {
          req.query.find[field] = query[field];
        }
      } else {
        req.query.find = query;
      }
      // Also assist in querying for the requested type.
      if (req.params.type) {
        req.query.find.type = req.params.type;
      }
      next( );
    }

    /**
      * @method prep_pattern_field
      * Ensure that `req.patternField` is set to assist other middleware in
      * deciding which field to generate queries against.
      * Default is `dateString`, because that's the iso8601 field for sgv
      * entries.
      */
    function prep_pattern_field (req, res, next) {
      // If req.params.field from routed path parameter is available use it.
      if (req.params.field) {
        req.patternField = req.params.field;
      } else {
        // Default is `dateString`.
        req.patternField = 'dateString';
      }
      next( );
    }

    /**
      * @method prep_storage
      * Prep storage layer for other middleware by setting `req.storage`.
      * Some routed paths have a `storage` parameter available, when this is
      * set, `req.storage will be set to that value.  The default otherwise is
      * the entries storage layer, because that's where sgv records are stored
      * by default.
      */
    function prep_storage (req, res, next) {
      if (req.params.storage && _.includes(['entries', 'treatments', 'devicestatus'], req.params.storage)) {
        req.storage = ctx[req.params.storage];
      } else {
        req.storage = ctx.entries;
      }
      next( );
    }

    /**
      * @module get#/times/echo/:prefix/:regex
      * Echo interface for the regex pattern generator.
      * @routed
      * Useful for understanding how the `/:prefix/:regex` route generates
      * mongodb queries.
      */
    api.get('/times/echo/:prefix?/:regex?', prep_storage, prep_pattern_field, prep_patterns, prep_patterns, function (req, res) {
      res.json({ req: { params: req.params, query: req.query}, pattern: req.pattern});
    });

    /**
      * @module get#/times/:prefix/:regex
      * Allows searching for modal times of day across days and months.
```
/api/v1/times/2015-04/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120
/api/v1/times/20{14..15}-04/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120
/api/v1/times/20{14..15}/T{13..18}:{00..15}'.json'?find[sgv][$gte]=120
```
      * @routed
      * @response 200 /definitions/Entries
      */
    api.get('/times/:prefix?/:regex?', prep_storage, prep_pattern_field, prep_patterns, prep_patterns, query_models, format_entries);

    api.get('/count/:storage/where', prep_storage, count_records, format_results);

    /**
      * @module get#/slice/:storage/:field/:type/:prefix/:regex
      * @routed
      * @response 200 /definitions/Entries
      * Allows searching for modal times of day across days and months.
      * Also allows specifying field to perform regexp on, the storage layer to
      * use, as well as which type of model to look for.
```
/api/v1/slice/entries/dateString/mbg/2015.json
```
      */
    api.get('/slice/:storage/:field/:type?/:prefix?/:regex?', prep_storage, prep_pattern_field, prep_patterns, query_models, format_entries);

    /**
      * @module post#/entries/preview
      * Allow previewing your post content, just echos everything you
      * posted back out.
      * Similar to the echo api, useful to lint/debug upload problems.
      */
    api.post('/entries/preview', ctx.authorization.isPermitted('api:entries:create'), function (req, res, next) {
      // setting this flag tells insert_entries to not actually store the results
      req.persist_entries = false;
      next( );
    }, insert_entries, format_entries);

    // Protect endpoints with authenticated api.
    if (app.enabled('api')) {
      // Create and store new sgv entries
      /**
        * @module post#/entries
        * Allow posting content to store.
        * Stores incoming payload that follows basic rules about having a
        * `type` field in `entries` storage layer.
        */
      api.post('/entries/', ctx.authorization.isPermitted('api:entries:create'), function (req, res, next) {
        // setting this flag tells insert_entries to store the results
        req.persist_entries = true;
        next( );
      }, insert_entries, format_entries);

      /**
        * @module delete#/entries/:spec
        * @route
        * Delete entries.  The query logic works the same way as find/list.  This
        * endpoint uses same search logic to remove records from the database.
        */
      api.delete('/entries/:spec', ctx.authorization.isPermitted('api:entries:delete'), function (req, res, next) {
        // if ID, prepare to query for one record
        if (isId(req.params.spec)) {
          prepReqModel(req, req.params.model);
          req.query = {find: {_id: req.params.spec}};
        } else {
          req.params.model = req.params.spec;
          prepReqModel(req, req.params.model);
          if (req.query.find.type === '*') {
            delete req.query.find.type;
          }
        }
        next( );
      }, delete_records);


    }

    return api;
}

// expose module
module.exports = configure;
