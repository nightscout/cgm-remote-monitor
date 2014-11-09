
var bootevent = require('bootevent');

// TODO: move much of this to core.js
function boot (env) {
  var store = require('./storage')(env);
  var proc = bootevent( )
    .acquire(function db (ctx, next) {
      // initialize db connections
      store( function ready ( ) {
        console.log('storage system ready');
        ctx.store = store;
        next( );
      });
    })
    .acquire(function data (ctx, next) {
      var core = require('./core')(env, ctx);
      core.init(ctx);

      next( );
    })
    // .acquire(function data (ctx, next) { next( ); })
    ;
  return proc;

}
module.exports = boot;
