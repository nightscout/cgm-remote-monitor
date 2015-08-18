'use strict';

var _ = require('lodash');

var UPDATE_THROTTLE = 1000;

function boot (env) {

  function setupMongo (ctx, next) {
    require('./storage')(env, function ready ( err, store ) {
      // FIXME, error is always null, if there is an error, the storage.js will throw an exception
      console.log('Storage system ready');
      ctx.store = store;

      next( );
    });
  }

  function setupInternals (ctx, next) {
    ///////////////////////////////////////////////////
    // api and json object variables
    ///////////////////////////////////////////////////
    ctx.plugins = require('./plugins')().registerServerDefaults().init(env.settings);

    ctx.pushover = require('./plugins/pushover')(env);
    ctx.maker = require('./plugins/maker')(env);
    ctx.pushnotify = require('./pushnotify')(env, ctx);

    ctx.entries = require('./entries')(env, ctx);
    ctx.treatments = require('./treatments')(env, ctx);
    ctx.devicestatus = require('./devicestatus')(env.devicestatus_collection, ctx);
    ctx.profile = require('./profile')(env.profile_collection, ctx);
    ctx.pebble = require('./pebble')(env, ctx);
    ctx.bus = require('./bus')(env, ctx);
    ctx.data = require('./data')(env, ctx);
    ctx.notifications = require('./notifications')(env, ctx);

    next( );
  }

  function ensureIndexes (ctx, next) {
    console.info('Ensuring indexes');
    ctx.store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
    ctx.store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
    ctx.store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
    ctx.store.ensureIndexes(ctx.profile( ), ctx.profile.indexedFields);

    next( );
  }

  function setupListeners (ctx, next) {
    var updateData = _.debounce(function debouncedUpdateData ( ) {
      ctx.data.update(function dataUpdated () {
        ctx.bus.emit('data-loaded');
      });
    }, UPDATE_THROTTLE);

    ctx.bus.on('tick', function timedReloadData (tick) {
      console.info('tick', tick.now);
      updateData();
    });

    ctx.bus.on('data-received', function forceReloadData ( ) {
      console.info('got data-received event, requesting reload');
      updateData();
    });

    ctx.bus.on('data-loaded', function updatePlugins ( ) {
      var sbx = require('./sandbox')().serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      ctx.notifications.initRequests();
      ctx.plugins.checkNotifications(sbx);
      ctx.notifications.process(sbx);
      ctx.bus.emit('data-processed');
    });

    ctx.bus.on('notification', ctx.pushnotify.emitNotification);

    next( );
  }

  function setupBridge (ctx, next) {
    ctx.bridge = require('./plugins/bridge')(env);
    if (ctx.bridge) {
      ctx.bridge.startEngine(ctx.entries);
    }
    next( );
  }

  function finishBoot (ctx, next) {
    ctx.bus.uptime( );

    next( );
  }

  return require('bootevent')( )
    .acquire(setupMongo)
    .acquire(setupInternals)
    .acquire(ensureIndexes)
    .acquire(setupListeners)
    .acquire(setupBridge)
    .acquire(finishBoot);
}

module.exports = boot;
