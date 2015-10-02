'use strict';

var consts = require('../../constants');
var es = require('event-stream');
var sgvdata = require('sgvdata');

/**********\
 * Entries
\**********/
function configure (app, wares, entries) {
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

    // Middleware to format any response involving entries.
    function format_entries (req, res, next) {
      var output = es.readArray(res.entries || [ ]);
      if (res.entries_err) {
        return res.sendJSONStatus(res, consts.HTTP_INTERNAL_ERROR, 'Mongo Error', res.entries_err);
      }
      return res.format({
        text: function ( ) {
          es.pipeline(output, sgvdata.format( ), res);
        },
        json: function ( ) {
          es.pipeline(output, entries.map( ), es.writeArray(function (err, out) {
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

    api.get('/entries', function(req, res, next) {
      // If "?count=" is present, use that number to decided how many to return.
      var query = req.query;
      if (!query.count) { query.count = 10 };
      entries.list(query, function(err, entries) {
        res.entries = entries;
        res.entries_err = err;
        return next( );
      });
    }, format_entries);

    api.get('/entries/current', function(req, res, next) {
      entries.list({count: 1}, function(err, records) {
        res.entries = records;
        res.entries_err = err;
        return next( );
      });
    }, format_entries);


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

    // Fetch one entry by id
    api.get('/entries/:id', function(req, res, next) {
      entries.getEntry(req.params.id, function(err, entry) {
        res.entries = [entry];
        res.entries_err = err;
        next()
      });
    }, format_entries);


    return api;
}
module.exports = configure;
