
var bootevent = require('bootevent');

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
      ///////////////////////////////////////////////////
      // api and json object variables
      ///////////////////////////////////////////////////
      ctx.pushover = require('./pushover')(env);
      ctx.entries = require('./entries')(env.mongo_collection, ctx.store, ctx.pushover);
      ctx.settings = require('./settings')(env.settings_collection, ctx.store);
      ctx.treatments = require('./treatments')(env.treatments_collection, ctx.store, ctx.pushover);
      ctx.devicestatus = require('./devicestatus')(env.devicestatus_collection, ctx.store);
      ctx.profiles = require('./profile')(env.profile_collection, ctx.store);
      ctx.pebble = require('./pebble');

      console.info("Ensuring indexes");
      store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
      store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
      store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
      store.ensureIndexes(ctx.profiles( ), ctx.profiles.indexedFields);

      next( );
    })
    ;
  return proc;

}
module.exports = boot;
