
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
      ctx.plugins = require('./plugins')().registerServerDefaults().init(env);
      ctx.pushover = require('./pushover')(env);
      ctx.entries = require('./entries')(env, ctx);
      ctx.treatments = require('./treatments')(env, ctx);
      ctx.devicestatus = require('./devicestatus')(env.devicestatus_collection, ctx);
      ctx.profile = require('./profile')(env.profile_collection, ctx);
      ctx.pebble = require('./pebble')(env, ctx);

      console.info("Ensuring indexes");
      store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
      store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
      store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
      store.ensureIndexes(ctx.profile( ), ctx.profile.indexedFields);
      
      ctx.heartbeat = require('./ticker')(env, ctx);

      ctx.data = require('./data')(env, ctx);
      ctx.notifications = require('./notifications')(env, ctx);

      ctx.heartbeat.on('tick', function(tick) {
        console.info('tick', tick.now);
        ctx.data.update(function dataUpdated () {
          ctx.heartbeat.emit('data-loaded');
        });
      });

      ctx.heartbeat.on('data-loaded', function() {
        ctx.notifications.processData(env, ctx);
      });

      ctx.heartbeat.uptime( );

      next( );
    })
    ;
  return proc;

}
module.exports = boot;
