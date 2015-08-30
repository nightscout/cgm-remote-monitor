'use strict';

var consts = require('../../constants');
var es = require('event-stream');
var sgvdata = require('sgvdata');

var ID_PATTERN = /^[a-f\d]{24}$/;
function isId (value) {
  //TODO: why did we need tht length check?
  return value && ID_PATTERN.test(value) && value.length === 24;
}

/**********\
 * Entries
\**********/
function configure (app, wares, ctx) {
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
    // api.use(require('express-extension-to-accept')([
    api.use(wares.extensions([
      'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
    ]));
    // also support url-encoded content-type
    api.use(wares.bodyParser.urlencoded({ extended: true }));

    function force_typed_data (opts) {
      function sync (data, next) {
        if (!data.type && opts.type) {
          data.type = opts.type;
        }
        next(null, data);
      }
      return es.map(sync);
    }

    // Middleware to format any response involving entries.
    function format_entries (req, res) {
      var type_params = {
        type: (req.query && req.query.find && req.query.find.type
            && req.query.find.type !== req.params.model)
            ? req.query.find.type : req.params.model
      };
      var output = es.readArray(res.entries || [ ]);
      if (res.entries_err) {
        return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', res.entries_err);
      }
      return res.format({
        text: function ( ) {
          es.pipeline(output, sgvdata.format( ), res);
        },
        json: function ( ) {
          es.pipeline(output, force_typed_data(type_params), es.writeArray(function (err, out) {
            res.json(out);
          }));
        }
      });
    }

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

      /*
       * inputs -> <ReadableStream>
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

      // return a writable persistent storage stream
      function persist (fn) {
        if (req.persist_entries) {
          // store everything
          return entries.persist(fn);
        }
        // support a preview mode, just lint everything
        return es.pipeline(entries.map( ), es.writeArray(fn));
      }

      // store results and move to the next middleware
      function done (err, result) {
        res.entries = result;
        res.entries_err = err;
        return next( );
      }

      // pipe everything to persistent storage
      // when finished, pass to the next piece of middleware
      es.pipeline(inputs( ), persist(done));
    }

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

    api.param('model', function (req, res, next, model) {
      prepReqModel(req, model);
      next( );
    });

    api.get('/entries/current', function(req, res, next) {
      //assume sgv
      req.params.model = 'sgv';
      entries.list({count: 1}, function(err, records) {
        res.entries = records;
        res.entries_err = err;
        return next( );
      });
    }, format_entries);

    // Fetch one entry by id
    api.get('/entries/:spec', function(req, res, next) {
      if (isId(req.params.spec)) {
        entries.getEntry(req.params.spec, function(err, entry) {
          res.entries = [entry];
          res.entries_err = err;
          req.query.find = req.query.find || {};
          req.query.find.type = entry.type;
          next();
        });
      } else {
        req.params.model = req.params.spec;
        prepReqModel(req, req.params.model);
        query_models(req, res, next);
      }
    }, format_entries);

    api.get('/entries', query_models, format_entries);

    function echo_query (req, res) {
      var query = req.query;
      var input = JSON.parse(JSON.stringify(query));

      // If "?count=" is present, use that number to decided how many to return.
      if (!query.count) {
        query.count = 10;
      }
      var storage = req.params.echo || 'entries';

      res.json({ query: ctx[storage].query_for(query), input: input, params: req.params, storage: storage});
    }
    function query_models (req, res, next) {
      var query = req.query;

      // If "?count=" is present, use that number to decided how many to return.
      if (!query.count) {
        query.count = 10;
      }

      ctx.entries.list(query, function(err, entries) {
        res.entries = entries;
        res.entries_err = err;
        return next( );
      });
    }

    api.delete('/entries/:spec', function(req, res, next) {
      if (isId(req.params.id)) {
        prepReqModel(req, req.params.model);
        req.query = {find: {_id: req.params.spec}};
      } else {
        req.params.model = req.params.spec;
        prepReqModel(req, req.params.model);
      }
      next( );
    }, delete_records);


    function delete_records (req, res, next) {
      if (!req.model) {
        req.model = ctx.entries;
      }
      var query = req.query;
      if (!query.count) { query.count = 10 }
      req.model.remove(query, function(err, stat) {
        if (err) {
          return next(err);
        }
        res.json(stat);
        return next( );
      });
    }

    api.param('spec', function (req, res, next, spec) {
      if (isId(spec)) {
        prepReqModel(req, req.params.model);
        req.query = {find: {_id: req.params.spec}};
      } else {
        prepReqModel(req, req.params.model);
      }
      next( );
    });
    api.param('echo', function (req, res, next, echo) {
      console.log('echo', echo);
      if (!echo) {
        req.params.echo = 'entries';
      }
      next( );
    });
    api.get('/echo/:echo/:model?/:spec?', echo_query);

    // Allow previewing your post content, just echos everything you
    // posted back out.
    api.post('/entries/preview', function (req, res, next) {
      req.persist_entries = false;
      next( );
    }, insert_entries, format_entries);

    if (app.enabled('api')) {
      // Create and store new sgv entries
      api.post('/entries/', wares.verifyAuthorization, function (req, res, next) {
        req.persist_entries = true;
        next( );
      }, insert_entries, format_entries);
    }

    return api;
}
module.exports = configure;
