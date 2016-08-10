

var date = require('date.js');


function get_time_spec (spec) {

  // req.query.at
  return date(spec);
}

function get_context (req, res, next) {
  res.data = req.ctx;
  // res.send(req.ctx.ddata);
  next( );
}

function ddata_at (at, ctx, callback) {
  var ddata = ctx.ddata.clone( );
  if (Math.abs(at - ddata.lastUpdated) < 1000 * 60 * 5) {
    return callback(null, ctx.ddata);
  }
  ctx.dataloader.update(ddata, {lastUpdated: at}, function (err, result) {
    console.log('results', err, result);
    console.log('ddata', ddata);
    callback(err, ddata);
  });
}
function get_ddata (req, res, next) {
  ddata_at(req.at, req.ctx, function (err, data) {
    res.data = data;
    console.log('fetched results', err, data);
    console.error(err);
    next(err);
  });
}

function format_result (req, res, next) {
  res.json(res.data);
}

/**
  * @method configure
  * Configure the ddata endpoints module, given an existing express app, common
  * middlewares, and the global app's `ctx`.
  * @param Express app  The express app we'll mount onto.
  * @param Object wares Common middleware used by lots of apps.
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

    api.get('/ctx/:at', get_context, format_result);
    api.get('/at/:at', get_ddata, format_result);

    return api;
}

// expose module
module.exports = configure;
