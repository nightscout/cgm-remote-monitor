'use strict';

var _ = require('lodash');

var UPDATE_THROTTLE = 1000;

function boot (env) {

  function checkEnv (ctx, next) {
    if (env.err) {
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'ENV Error', err: env.err});
    }
    next();
  }

  function setupMongo (ctx, next) {

    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    try {
      require('./storage')(env, function ready ( err, store ) {
        // FIXME, error is always null, if there is an error, the storage.js will throw an exception
        console.log('Storage system ready');
        ctx.store = store;

        next();
      });
    } catch (err) {
      console.info('mongo err', err);
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'Unable to connect to Mongo', err: err});
      next();
    }
  }

  function setupInternals (ctx, next) {
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

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
    ctx.food = require('./food')(env, ctx);
    ctx.pebble = require('./pebble')(env, ctx);
    ctx.properties = require('./api/properties')(env, ctx);
    ctx.bus = require('./bus')(env.settings, ctx);
    ctx.ddata = require('./data/ddata')();
    ctx.dataloader = require('./data/dataloader')(env, ctx);
    ctx.notifications = require('./notifications')(env, ctx);

    next( );
  }

  function ensureIndexes (ctx, next) {
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    console.info('Ensuring indexes');
    ctx.store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
    ctx.store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
    ctx.store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
    ctx.store.ensureIndexes(ctx.profile( ), ctx.profile.indexedFields);
    ctx.store.ensureIndexes(ctx.food( ), ctx.food.indexedFields);

    next( );
  }

  function setupListeners (ctx, next) {
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    var updateData = _.debounce(function debouncedUpdateData ( ) {
      ctx.dataloader.update(ctx.ddata, function dataUpdated () {
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
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    ctx.bridge = require('./plugins/bridge')(env);
    if (ctx.bridge) {
      ctx.bridge.startEngine(ctx.entries);
    }
    next( );
  }

  function setupMMConnect (ctx, next) {
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    ctx.mmconnect = require('./plugins/mmconnect').init(env, ctx.entries, ctx.devicestatus);
    if (ctx.mmconnect) {
      ctx.mmconnect.run();
    }
    next( );
  }

  function finishBoot (ctx, next) {
    if (ctx.bootErrors && ctx.bootErrors.length > 0) {
      return next();
    }

    ctx.bus.uptime( );

    next( );
  }

  return require('bootevent')( )
    .acquire(checkEnv)
    .acquire(setupMongo)
    .acquire(setupInternals)
    .acquire(ensureIndexes)
    .acquire(setupListeners)
    .acquire(setupBridge)
    .acquire(setupMMConnect)
    .acquire(finishBoot);
}

module.exports = boot;
