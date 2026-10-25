'use strict';

var moment = require('moment');

function get_time_spec (spec) {
  return moment(spec).toDate();
}

function ddata_at (at, ctx, callback) {
  var ddata = ctx.ddata.clone( );
  if (Math.abs(at - ddata.lastUpdated) < 1000 * 60 * 5) {
    return callback(null, ctx.ddata);
  }
  ctx.dataloader.update(ddata, {lastUpdated: at, frame: true}, function (err) {
    // console.log('results', err, result);
    // console.log('ddata', ddata);
    callback(err, ddata);
  });
}
function get_ddata (req, res, next) {
  ddata_at(req.at.getTime( ), req.ctx, function (err, data) {
    res.data = data;
    // console.log('fetched results', err, data);
    console.error(err);
    next(err);
  });
}

function ensure_at (req, res, next) {
  if (!req.at) {
    req.at = new Date( );
  }
  next( );
}

function format_result (req, res, next) {
  res.json(res.data);
  next( );
}

/**
  * @method configure
  * Configure the ddata endpoints module, given an existing express app, common
  * middlewares, and the global app's `ctx`.
  * @param Express app  The express app we'll mount onto.
  * @param Object ctx The global ctx with all modules, storage, and event buses
  * configured.
  */

function configure (app, ctx) {
  // default storage biased towards entries.
  // var entries = ctx.entries;
  var express = require('express'),
      api = express.Router( )
    ;

  api.param('at', function (req, res, next, at) {
    req.at = get_time_spec(at);
    next( );
  });

  api.use(function (req, res, next) {
    req.ctx = ctx;
    next( );
  });

  api.use(ctx.authorization.isPermitted('api:entries:read'),
    ctx.authorization.isPermitted('api:treatments:read'));
  api.get('/at/:at?', ensure_at, get_ddata, format_result);

  return api;
}

// expose module
module.exports = configure;
