'use strict';

var _ = require('lodash');

var UPDATE_THROTTLE = 5000;

function boot (env, language) {

  //////////////////////////////////////////////////
  // Check Node version.
  // Latest Node 8 LTS and Latest Node 10 LTS are recommended and supported.
  // Latest Node version on Azure is tolerated, but not recommended
  // Latest Node (non LTS) version works, but is not recommended
  // Older Node versions or Node versions with known security issues will not work.
  // More explicit:
  // < 8        does not work, not supported
  // >= 8.15.1  works, supported and recommended
  // == 9.x     does not work, not supported
  // == 10.15.2 works, not fully supported and not recommended (Azure version)
  // >= 10.16.0 works, supported and recommended
  // == 11.x    does not work, not supported
  // >= 12.6.0  does work, not recommended, will not be supported. We only support Node LTS releases
  ///////////////////////////////////////////////////
  function checkNodeVersion (ctx, next) {
    var semver = require('semver');
    var nodeVersion = process.version;

    if ( semver.satisfies(nodeVersion, '^8.15.1') || semver.satisfies(nodeVersion, '^10.16.0')) {
      //Latest Node 8 LTS and Latest Node 10 LTS are recommended and supported.
      //Require at least Node 8 LTS and Node 10 LTS without known security issues
      console.debug('Node LTS version ' + nodeVersion + ' is supported');
      next();
    }
    else if ( semver.eq(nodeVersion, '10.15.2')) {
      //Latest Node version on Azure is tolerated, but not recommended
      console.log('WARNING: Node version v10.15.2 and Microsoft Azure are not recommended.');
      console.log('WARNING: Please migrate to another hosting provider. Your Node version is outdated and insecure');
      next();
    }
    else if ( semver.satisfies(nodeVersion, '^12.6.0')) {
        //Latest Node version
        console.debug('Node version ' + nodeVersion + ' is not a LTS version. Not recommended. Not supported');
        next();
    } else {
      // Other versions will not start
      console.log( 'ERROR: Node version ' + nodeVersion + ' is not supported. Please use a secure LTS version or upgrade your Node');
      process.exit(1);
    }
  }


  function checkEnv (ctx, next) {
    ctx.language = language;
    if (env.err) {
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'ENV Error', err: env.err});
    }
    next();
  }

  function hasBootErrors(ctx) {
    return ctx.bootErrors && ctx.bootErrors.length > 0;
  }

  function augmentSettings (ctx, next) {
    var configURL = env.IMPORT_CONFIG || null;
    var url = require('url');
    var href = null;
    try {
      href = url.parse(configURL).href;
    } catch (e) {
      console.error('Parsing config URL from IMPORT_CONFIG failed');
    }
    if(configURL && href) {
      var request = require('request');
      console.log('Getting settings from', href);
      request.get({url: href, json: true}, function (err, resp, body) {
        if (err) {
          console.log('Attempt to fetch config', href, 'failed.');
          console.error(err);
          throw err;
        } else {
          var settings = body.settings || body;
          console.log('extending settings with', settings);
          _.merge(env.settings, settings);
          if (body.extendedSettings) {
            console.log('extending extendedSettings with', body.extendedSettings);
            _.merge(env.extendedSettings, body.extendedSettings);
          }
        }
        next( );
      });
    } else {
      next( );
    }
  }

  function setupStorage (ctx, next) {

    if (hasBootErrors(ctx)) {
      return next();
    }

    try {
      if (_.startsWith(env.storageURI, 'openaps://')) {
        require('../storage/openaps-storage')(env, function ready (err, store) {
          if (err) {
            throw err;
          }

          ctx.store = store;
          console.log('OpenAPS Storage system ready');
          next();
        });
      } else {
        //TODO assume mongo for now, when there are more storage options add a lookup
        require('../storage/mongo-storage')(env, function ready(err, store) {
          // FIXME, error is always null, if there is an error, the index.js will throw an exception
          console.log('Mongo Storage system ready');
          ctx.store = store;

          next();
        });
      }
    } catch (err) {
      console.info('mongo err', err);
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'Unable to connect to Mongo', err: err});
      next();
    }
  }

  function setupAuthorization (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.authorization = require('../authorization')(env, ctx);
    ctx.authorization.storage.reload(function loaded (err) {
      if (err) {
        ctx.bootErrors = ctx.bootErrors || [ ];
        ctx.bootErrors.push({'desc': 'Unable to setup authorization', err: err});
      }
      next();
    });
  }

  function setupInternals (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.levels = require('../levels');
    ctx.levels.translate = ctx.language.translate;

    ///////////////////////////////////////////////////
    // api and json object variables
    ///////////////////////////////////////////////////
    ctx.plugins = require('../plugins')({
      settings: env.settings
      , language: ctx.language
    }).registerServerDefaults();

    ctx.pushover = require('../plugins/pushover')(env);
    ctx.maker = require('../plugins/maker')(env);
    ctx.pushnotify = require('./pushnotify')(env, ctx);
    ctx.loop = require('./loop')(env, ctx);

    ctx.activity = require('./activity')(env, ctx);
    ctx.entries = require('./entries')(env, ctx);
    ctx.treatments = require('./treatments')(env, ctx);
    ctx.devicestatus = require('./devicestatus')(env.devicestatus_collection, ctx);
    ctx.profile = require('./profile')(env.profile_collection, ctx);
    ctx.food = require('./food')(env, ctx);
    ctx.pebble = require('./pebble')(env, ctx);
    ctx.properties = require('../api/properties')(env, ctx);
    ctx.bus = require('../bus')(env.settings, ctx);
    ctx.ddata = require('../data/ddata')();
    ctx.dataloader = require('../data/dataloader')(env, ctx);
    ctx.notifications = require('../notifications')(env, ctx);

    if (env.settings.isEnabled('alexa')) {
      ctx.alexa = require('../plugins/alexa')(env, ctx);
    }

    if (env.settings.isEnabled('googlehome')) {
      ctx.googleHome = require('../plugins/googlehome')(env, ctx);
    }

    next( );
  }

  function ensureIndexes (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    console.info('Ensuring indexes');
    ctx.store.ensureIndexes(ctx.entries( ), ctx.entries.indexedFields);
    ctx.store.ensureIndexes(ctx.treatments( ), ctx.treatments.indexedFields);
    ctx.store.ensureIndexes(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
    ctx.store.ensureIndexes(ctx.profile( ), ctx.profile.indexedFields);
    ctx.store.ensureIndexes(ctx.food( ), ctx.food.indexedFields);
    ctx.store.ensureIndexes(ctx.activity( ), ctx.activity.indexedFields);

    next( );
  }

  function setupListeners (ctx, next) {
    if (hasBootErrors(ctx)) {
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
      console.info('reloading sandbox data');
      var sbx = require('../sandbox')().serverInit(env, ctx);
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
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.bridge = require('../plugins/bridge')(env, ctx.bus);
    if (ctx.bridge) {
      ctx.bridge.startEngine(ctx.entries);
    }
    next( );
  }

  function setupMMConnect (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.mmconnect = require('../plugins/mmconnect').init(env, ctx.entries, ctx.devicestatus, ctx.bus);
    if (ctx.mmconnect) {
      ctx.mmconnect.run();
    }
    next( );
  }

  function finishBoot (ctx, next) {
    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.bus.uptime( );

    next( );
  }

  return require('bootevent')( )
    .acquire(checkNodeVersion)
    .acquire(checkEnv)
    .acquire(augmentSettings)
    .acquire(setupStorage)
    .acquire(setupAuthorization)
    .acquire(setupInternals)
    .acquire(ensureIndexes)
    .acquire(setupListeners)
    .acquire(setupBridge)
    .acquire(setupMMConnect)
    .acquire(finishBoot);
}

module.exports = boot;
