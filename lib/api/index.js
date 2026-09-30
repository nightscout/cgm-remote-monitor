'use strict';

var countParam = require('../server/count');

function create (env, ctx) {
  var express = require('express')
    ,  app = express( )
    ;

  const wares = ctx.wares;

  // set up express app with our options
  app.set('name', env.name);
  app.set('version', env.version);

  app.set('units', env.DISPLAY_UNITS);
  // Only allow access to the API if API KEY is set on the server.
  app.disable('api');
  if (env.enclave.isApiKeySet()) {
    console.log('API KEY present, enabling API');
    app.enable('api');
  } else {
    console.log('API KEY has not been set, API disabled');
  }
  if (env.settings.enable) {
    app.extendedClientSettings = ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {};
    env.settings.enable.forEach(function (enable) {
      console.info('enabling feature:', enable);
      app.enable(enable);
    });
  }

  app.set('title', [app.get('name'),  'API', app.get('version')].join(' '));

 // Start setting up routes
  if (app.enabled('api')) {
    // experiments
    app.use('/experiments', require('./experiments/')(app, wares, ctx));
  }


  app.use(wares.extensions([
    'json', 'svg', 'csv', 'txt', 'png', 'html', 'tsv'
  ]));

  // `?count=` says how many documents a read wants.  Refuse anything that is
  // not a whole number of documents rather than letting `parseInt` guess: `0`
  // is the dangerous one, because MongoDB defines `.limit(0)` as *no limit*,
  // so a request for zero documents would be answered with the whole
  // collection.  `-3`, `abc` and `1e2` all read as some other number too.
  //
  // On a read, `count=0` never reaches the storage layer as a zero: it is
  // rewritten below, either to no count at all or, inside a date window, to
  // no limit. The storage layer (lib/server/count.js) still answers a zero it
  // is handed directly with an empty list, never with the whole collection.
  //
  // A save or an update does not use `count`, so one that happens to carry
  // one must not be refused because of it.
  //
  // A delete does not use `count` either: it removes everything its filter
  // matches.  But a delete that carries a count it cannot read - `count=0`
  // included, which does not mean "delete nothing" - is refused as before,
  // rather than carried out as though the count were not there.
  function refuseCount (res, description) {
    return res.status(400).json({
      status: 400
      , message: 'Bad count'
      , description: description
    });
  }

  // Two shapes real clients send are still read the way 15.0.8 read them, so
  // that 15.0.9 does not break them; both are answered with a deprecation
  // warning, and are logged once per process. Each has its own setting, on by
  // default (lib/server/env.js); with it off, that shape meets the rule above:
  // `1?...` is refused, and `count=0` is answered with an empty list.
  //
  // - oref0 sends `count=1?<credential>`, because its `ns-get.sh` appends the
  //   credential with a second `?`. The leading number is the count. Neither
  //   the value nor the credential in it is ever logged or echoed.
  // - GluPredKit sends `count=0` with a date range, meaning "everything in
  //   the range". A read with `count=0` and a `find` that bounds a date field
  //   from both sides is answered with everything in it, as 15.0.8 did.
  //   `count=0` without such a window reads as if no count had been given,
  //   which is the endpoint's default.
  const warned = { };

  function deprecate (res, kind, warning) {
    res.set('Deprecation', 'true');
    res.set('Warning', '299 - "' + warning + '"');
    if (!warned[kind]) {
      warned[kind] = true;
      console.warn('API v1: ' + warning + ' (logged once)');
    }
  }

  function tolerateCount (req, res) {
    const requested = req.query.count;
    const leading = env.apiV1CountLeadingNumber === false ? null : countParam.leadingCount(requested);

    if (leading !== null) {
      req.query.count = leading;
      deprecate(res, 'leading', 'a count followed by other text is deprecated (API_V1_COUNT_LEADING_NUMBER) and may be refused by a future major release; send count as a whole number only');
    }

    if (env.apiV1CountZeroWindow !== false && countParam.isZeroCount(req.query.count)) {
      if (countParam.hasDateWindow(req.query.find)) {
        req.query.count = countParam.NO_LIMIT_COUNT;
      } else {
        delete req.query.count;
      }
      deprecate(res, 'zero', 'count=0 is deprecated (API_V1_COUNT_ZERO_WINDOW) and may be refused by a future major release; send a whole number of documents, 1 or greater');
    }
  }

  app.use(function validateCount (req, res, next) {
    const requested = req.query && req.query.count;

    if (!countParam.hasCount(requested)) {
      return next( );
    }

    if (req.method === 'DELETE') {
      if (countParam.parseCount(requested) === null) {
        return refuseCount(res, 'count must be a whole number of documents, 1 or greater');
      }
      return next( );
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next( );
    }

    tolerateCount(req, res);

    if (!countParam.isZeroCount(req.query.count) && countParam.hasCount(req.query.count) && countParam.parseCount(req.query.count) === null) {
      return refuseCount(res, 'count must be a whole number of documents, 0 or greater');
    }

    next( );
  });

  var entriesRouter = require('./entries/')(app, wares, ctx, env);
  // Entries and settings
  app.all('/entries*', entriesRouter);
  app.all('/echo/*', entriesRouter);
  app.all('/times/*', entriesRouter);
  app.all('/slice/*', entriesRouter);
  app.all('/count/*', entriesRouter);

  app.all('/treatments*', require('./treatments/')(app, wares, ctx, env));
  app.all('/profile*', require('./profile/')(app, wares, ctx));
  app.all('/devicestatus*', require('./devicestatus/')(app, wares, ctx, env));
  app.all('/notifications*', require('./notifications-api')(app, wares, ctx));

  app.all('/activity*', require('./activity/')(app, wares, ctx));

  app.use('/', wares.sendJSONStatus, require('./verifyauth')(ctx));

  app.use('/', wares.sendJSONStatus, require('./adminnotifiesapi')(ctx));

  app.all('/food*', require('./food/')(app, wares, ctx));
  app.all('/insulin*', require('./insulin/')(app, wares, ctx));

  // Status first
  app.all('/status*', require('./status')(app, wares, env, ctx));

  if (ctx.alexa) {
    app.all('/alexa*', require('./alexa/')(app, wares, ctx, env));
  }

  if (ctx.googleHome) {
    app.all('/googlehome*', require('./googlehome/')(app, wares, ctx, env));
  }

  return app;
}

module.exports = create;
