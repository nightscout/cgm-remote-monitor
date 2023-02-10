

const fs = require('fs');
const path = require('path');

function asset (opts) {

  var info = require(opts.stats || '.cache/_ns_cache/public/stats.json');
  console.log("INFO entrypoints", info.entrypoints);
  function middleware (req, res, next) {
    res.locals.assets = info.entrypoints[res.locals.page.asset]
    next( );
  }

  function render (req, res, next) {

    next( );
  }

  function page (name, config) {

    function assign (req, res, next) {
      res.locals.page = config;

      next( );
    }

    return [assign, middleware, ];
  }
  page.middleware = middleware;
  page.render = render;
  return page;


}

exports = module.exports = asset;

