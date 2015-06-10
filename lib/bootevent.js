
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
      ctx.pushnotify = require('./pushnotify')(env, ctx);
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

      ctx.bus = require('./bus')(env, ctx);

      ctx.data = require('./data')(env, ctx);
      ctx.notifications = require('./notifications')(env, ctx);

      function updateData ( ) {
        ctx.data.update(function dataUpdated () {
          ctx.bus.emit('data-loaded');
        });
      }

      ctx.bus.on('tick', function timedReloadData (tick) {
        console.info('tick', tick.now);
        updateData();
      });

      ctx.bus.on('data-received', function forceReloadData ( ) {
        console.info('got data-received event, reloading now');
        updateData();
      });

      ctx.bus.on('data-loaded', function updatePlugins ( ) {
        var sbx = require('./sandbox')().serverInit(env, ctx);
        ctx.plugins.setProperties(sbx);
        ctx.notifications.initRequests();
        ctx.plugins.checkNotifications(sbx);
        ctx.notifications.process(env, ctx);
        ctx.bus.emit('data-processed');
      });

      ctx.bus.on('notification', ctx.pushnotify.emitNotification);

      ctx.bus.uptime( );

      next( );
    })
    ;
  return proc;

}

module.exports = boot;
