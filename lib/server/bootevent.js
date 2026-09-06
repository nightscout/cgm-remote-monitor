'use strict';

const UPDATE_DEBOUNCE_WAIT = 1000;
const UPDATE_MAX_WAIT = 5000;
const debounce = require('../utils/debounce');
const bridgeConnectCompat = require('./bridge-connect-compat');
const mmconnectCompat = require('./mmconnect-connect-compat');

function boot (env, language) {

  function startBoot(ctx, next) {

    console.log('++++++++++++++++++++++++++++++');
    console.log('Nightscout Executing startBoot');
    console.log('++++++++++++++++++++++++++++++');

    ctx.bootErrors = [ ];
    ctx.moment = require('moment-timezone');
    ctx.runtimeState = 'booting';
    ctx.settings = env.settings;
    ctx.bus = require('../bus')(env.settings, ctx);
    ctx.adminnotifies = require('../adminnotifies')(ctx);
    if (env.notifies) {
      for (var i = 0; i < env.notifies.length; i++) {
        ctx.adminnotifies.addNotify(env.notifies[i]);
      }
    }
    next();
  }

  function checkNodeVersion (ctx, next) {
    require('./runtime-policy')();
    next();
  }

  function checkEnv (ctx, next) {

    console.log('Executing checkEnv');

    ctx.language = language;
    if (env.err.length > 0) {
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'ENV Error', err: env.err});
    }
    next();
  }

  function hasBootErrors(ctx) {
    return ctx.bootErrors && ctx.bootErrors.length > 0;
  }

  function migrateBridgeToConnect () {
    var result = bridgeConnectCompat.applyBridgeToConnectCompatibility(env);
    if (result.migrated) {
      console.log('BRIDGE credentials are served by Nightscout Connect; the legacy Dexcom bridge is retired in 15.0.9.');
    }
    return result;
  }

  function augmentSettings (ctx, next) {
    const deepMerge = require('../utils/deepMerge')
    console.log('Executing augmentSettings');

    var configURL = env.IMPORT_CONFIG || null;
    var url = require('url');
    var href = null;

    if (configURL) {
      try {
        href = url.parse(configURL).href;
      } catch (e) {
        console.error('Parsing config URL from IMPORT_CONFIG failed');
      }
    }

    if(configURL && href) {
      var axios_default = { headers: { 'Accept': 'application/json' } };
      var axios = require('axios').create(axios_default);
      console.log('Getting settings from IMPORT_CONFIG');
      return axios.get(href).then(function (resp) {
        var body = resp.data;
        var settings = body.settings || body;
        deepMerge(env.settings, settings);
        if (body.extendedSettings) {
          deepMerge(env.extendedSettings, body.extendedSettings);
        }
        next( );
      }).catch(function (err) {
        // URLs, headers and response bodies can contain credentials or settings.
        // Keep only a numeric HTTP status for logs and the rendered boot error.
        var failure = {message: 'Configuration request failed'};
        if (err.response && Number.isInteger(err.response.status)) {
          failure.response = {status: err.response.status};
        }
        console.log('Attempt to fetch IMPORT_CONFIG failed.', failure);
        ctx.bootErrors.push({desc: 'Attempt to fetch IMPORT_CONFIG failed.', err: failure});
        next( );

      });
    } else {
      next( );
    }
  }

  function checkSettings (ctx, next) {

    console.log('Executing checkSettings');

    ctx.bootErrors = ctx.bootErrors || [];

    console.log('Checking settings');

    if (!env.storageURI) {
      ctx.bootErrors.push({'desc': 'Mandatory setting missing',
      err: 'MONGODB_URI setting is missing, cannot connect to database'});
    }

    if (!env.enclave.isApiKeySet()) {
      ctx.bootErrors.push({'desc': 'Mandatory setting missing',
      err: 'API_SECRET setting is missing, cannot enable REST API'});
    }

    if (env.settings.authDefaultRoles == 'readable') {
      const message = {
        title: "Nightscout readable by world"
        ,message: "Your Nightscout installation is readable by anyone who knows the web page URL. Please consider closing access by following the Nightscout documentation: https://nightscout.github.io/nightscout/security/#how-to-turn-off-unauthorized-access"
        ,persistent: true
      };
      ctx.adminnotifies.addNotify(message);
    }

    next();
  }

  function setupStorage (ctx, next) {

    console.log('Executing setupStorage');

    if (hasBootErrors(ctx)) {
      return next();
    }

    try {
        //TODO assume mongo for now, when there are more storage options add a lookup
        require('../storage/mongo-storage')(env, function ready(err, store) {
          // FIXME, error is always null, if there is an error, the index.js will throw an exception
          if (err) {
            console.info('ERROR CONNECTING TO MONGO', err);
            ctx.bootErrors = ctx.bootErrors || [ ];
            ctx.bootErrors.push({'desc': 'Unable to connect to Mongo', err: err.message});
          }
          console.log('Mongo Storage system ready');
          ctx.store = store;
          next();
        });
    } catch (err) {
      console.info('ERROR CONNECTING TO MONGO', err);
      ctx.bootErrors = ctx.bootErrors || [ ];
      ctx.bootErrors.push({'desc': 'Unable to connect to Mongo', err: err.message});
      next();
    }
  }

  function setupAuthorization (ctx, next) {

    console.log('Executing setupAuthorization');

    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.authorization = require('../authorization')(env, ctx);
    ctx.authorization.storage.ensureIndexes();
    ctx.authorization.storage.reload(function loaded (err) {
      if (err) {
        ctx.bootErrors = ctx.bootErrors || [ ];
        ctx.bootErrors.push({'desc': 'Unable to setup authorization', err: err});
      }
      next();
    });
  }

  function setupInternals (ctx, next) {

    console.log('Executing setupInternals');

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
      , levels: ctx.levels
      , moment: ctx.moment
    }).registerServerDefaults();

    ctx.wares = require('../middleware/')(env);

    ctx.pushover = require('../plugins/pushover')(env, ctx);
    ctx.maker = require('../plugins/maker')(env);
    ctx.pushnotify = require('./pushnotify')(env, ctx);
    ctx.loop = require('./loop')(env, ctx);

    // Configure the write sanitizer before constructing storage adapters.
    // Importers and legacy bridges call those adapters without going through
    // an HTTP route, so the storage layer must be able to fail closed.
    ctx.purifier = require('./purifier')(env,ctx);

    ctx.activity = require('./activity')(env, ctx);
    ctx.entries = require('./entries')(env, ctx);
    ctx.treatments = require('./treatments')(env, ctx);
    ctx.devicestatus = require('./devicestatus')(env, ctx);
    ctx.profile = require('./profile')(env.profile_collection, ctx);
    ctx.food = require('./food')(env, ctx);
    ctx.pebble = require('./pebble')(env, ctx);
    ctx.properties = require('../api2/properties')(env, ctx);
    ctx.ddata = require('../data/ddata')();
    ctx.cache = require('./cache')(env,ctx);
    ctx.dataloader = require('../data/dataloader')(env, ctx);
    ctx.notifications = require('../notifications')(env, ctx);
    if (env.settings.isEnabled('alexa') || env.settings.isEnabled('googlehome')) {
      ctx.virtAsstBase = require('../plugins/virtAsstBase')(env, ctx);
    }

    if (env.settings.isEnabled('alexa')) {
      ctx.alexa = require('../plugins/alexa')(env, ctx);
    }

    if (env.settings.isEnabled('googlehome')) {
      ctx.googleHome = require('../plugins/googlehome')(env, ctx);
    }

    next( );
  }

  function ensureIndexes (ctx, next) {

    console.log('Executing ensureIndexes');

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

    console.log('Executing setupListeners');

    if (hasBootErrors(ctx)) {
      return next();
    }

    // Strategy C: Leading-edge debounce + concurrency guard
    // - First event fires immediately (no delay for normal single updates)
    // - Rapid events (AAPS batch upload) are coalesced by debounce
    // - Concurrency guard prevents overlapping dataloader runs on shared ddata
    // - maxWait ensures data appears within 5s even under sustained load
    var dataloadRunning = false;
    var dataloadPending = false;

    function runDataLoad () {
      if (dataloadRunning) {
        dataloadPending = true;
        return;
      }
      dataloadRunning = true;
      ctx.dataloader.update(ctx.ddata, function dataUpdated () {
        dataloadRunning = false;
        ctx.bus.emit('data-loaded');
        if (dataloadPending) {
          dataloadPending = false;
          runDataLoad();
        }
      });
    }

    var updateData = debounce(runDataLoad, UPDATE_DEBOUNCE_WAIT, { leading: true, trailing: true, maxWait: UPDATE_MAX_WAIT });

    ctx.bus.on('tick', function timedReloadData (tick) {
      console.info('tick', tick.now);
      updateData();
    });

    ctx.bus.on('data-received', function forceReloadData ( ) {
      console.info('got data-received event, requesting reload');
      updateData();
    });

    ctx.bus.on('data-loaded', function updatePlugins ( ) {
      console.info('data loaded: reloading sandbox data and updating plugins');
      var sbx = require('../sandbox')().serverInit(env, ctx);
      ctx.plugins.setProperties(sbx);
      ctx.notifications.initRequests();
      ctx.plugins.checkNotifications(sbx);
      ctx.notifications.process(sbx);
      ctx.sbx = sbx;
      ctx.bus.emit('data-processed', sbx);
    });

    ctx.bus.on('data-processed', function processed ( ) {
      ctx.runtimeState = 'loaded';
    });

    ctx.bus.on('notification', ctx.pushnotify.emitNotification);

    next( );
  }

  function setupConnect (ctx, next) {
    console.log('Executing setupConnect');
    const migration = migrateBridgeToConnect();
    if (migration.error) {
      ctx.bootErrors.push({desc: migration.error});
      return next();
    }
    const miniMedMigration = mmconnectCompat.applyMmconnectToConnectCompatibility(env);
    if (miniMedMigration.error) {
      ctx.bootErrors.push({desc: miniMedMigration.error});
      return next();
    }
    if (miniMedMigration.migrated) {
      console.log('MMCONNECT credentials are served by Nightscout Connect; the legacy MiniMed bridge is retired in 15.0.9.');
    }
    // Legacy credential migration may enable CONNECT implicitly.
    const connect = env.extendedSettings && env.extendedSettings.connect;
    if (!connect || !connect.source) {
      ctx.nightscoutConnect = undefined;
      console.log('Skipping disabled nightscout-connect');
      return next();
    }
    ctx.nightscoutConnect = require('nightscout-connect')(env, ctx);
    if (ctx.nightscoutConnect) {
      // The connector listens for tearDown, but Nightscout emits teardown.
      const connector = ctx.nightscoutConnect;
      ctx.bus.once('teardown', function stopConnect () {
        connector.stop();
      });
    }
    return next( );
  }

  function finishBoot (ctx, next) {

    console.log('Executing finishBoot');

    if (hasBootErrors(ctx)) {
      return next();
    }
    ctx.bus.emit('finishBoot');

    ctx.runtimeState = 'booted';
    ctx.bus.uptime( );

    next( );
  }

  return require('../utils/boot-sequence')([
    checkNodeVersion, startBoot, checkEnv, augmentSettings, checkSettings,
    setupStorage, setupAuthorization, setupInternals, ensureIndexes,
    setupListeners, setupConnect, finishBoot
  ]);
}

module.exports = boot;
