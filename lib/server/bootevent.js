'use strict';

const UPDATE_DEBOUNCE_WAIT = 1000;
const UPDATE_MAX_WAIT = 5000;
const debounce = require('../utils/debounce');
const bridgeConnectCompat = require('./bridge-connect-compat');
const defaultRoles = require('../authorization/defaultroles');

const SECURITY_DOC_URL = 'https://nightscout.github.io/nightscout/security/#how-to-turn-off-unauthorized-access';

// Which persistent admin notice, if any, describes what unauthenticated
// visitors can do with this site. Returns null when nothing needs saying.
//
// The setting is a role list, so it is read as one. 'readable careportal',
// which is what AUTH_DEFAULT_ROLES=readable plus the deprecated
// TREATMENTS_AUTH=off resolves to, is strictly wider than 'readable' and
// gets its own wording. 'careportal' without 'readable' is not warned
// about here: the treatments API applies a read check before the per-route
// create check, so that combination does not in fact accept anonymous
// treatment entry.
function worldReadableNotify (settings) {
  const roles = settings && settings.authDefaultRoles;

  if (!defaultRoles.has(roles, 'readable')) return null;

  if (defaultRoles.has(roles, 'careportal')) {
    return {
      title: "Nightscout readable by world and open to treatment entry"
      , message: "Your Nightscout installation is readable by anyone who knows the web page URL, and it also accepts new treatment entries - carbs, insulin, notes and similar - from anyone who knows the URL, without a password. This happens when the careportal role is part of AUTH_DEFAULT_ROLES, either because you set it there or because the deprecated TREATMENTS_AUTH=off setting adds it. If this is not what you intended, please consider closing access by following the Nightscout documentation: " + SECURITY_DOC_URL
      , persistent: true
    };
  }

  return {
    title: "Nightscout readable by world"
    , message: "Your Nightscout installation is readable by anyone who knows the web page URL. Please consider closing access by following the Nightscout documentation: " + SECURITY_DOC_URL
    , persistent: true
  };
}
const mmconnectCompat = require('./mmconnect-connect-compat');

// Index setup on an empty or already indexed database takes well under a
// second. Building a new index on a large existing collection can take much
// longer; boot stops waiting after this long and the build carries on.
const INDEX_WAIT_MS = 20000;

// Resolves when every requested index has settled, or after waitMs with a
// warning. Never rejects: ensureIndexes logs its own failures.
function awaitIndexes (requested, label, waitMs) {
  const limit = waitMs === undefined ? INDEX_WAIT_MS : waitMs;
  let timer;
  const settled = Promise.all(requested).then(function () { return true; });
  const expired = new Promise(function (resolve) {
    timer = setTimeout(function () { resolve(false); }, limit);
  });
  return Promise.race([settled, expired]).then(function (done) {
    clearTimeout(timer);
    if (!done) {
      console.warn('Index setup for ' + label + ' is still running after ' + limit + ' ms; continuing start-up while it finishes.');
    }
    return done;
  });
}

function boot (env, language, options) {

  // The context every role starts from. `bus` is what the role's in-process
  // events go through: the heartbeat bus for `single`, a plain emitter for a
  // role that has no ticker (see startApiBoot).
  function beginContext (ctx, makeBus) {
    ctx.bootErrors = [ ];
    ctx.moment = require('moment-timezone');
    ctx.runtimeState = 'booting';
    ctx.settings = env.settings;
    ctx.bus = makeBus();
    ctx.adminnotifies = require('../adminnotifies')(ctx);
    if (env.notifies) {
      for (var i = 0; i < env.notifies.length; i++) {
        ctx.adminnotifies.addNotify(env.notifies[i]);
      }
    }
  }

  function startBoot(ctx, next) {

    console.log('++++++++++++++++++++++++++++++');
    console.log('Nightscout Executing startBoot');
    console.log('++++++++++++++++++++++++++++++');

    beginContext(ctx, function heartbeatBus () { return require('../bus')(env.settings, ctx); });
    next();
  }

  // the api profile: no heartbeat bus. API v3 and authorization emit change and
  // admin events on ctx.bus unconditionally (storage-socket-*, data-received,
  // storage-write-committed, admin-notify); with no data loader, cache or
  // websocket in the process, a plain emitter with no timer receives them,
  // and only adminnotifies listens.
  function startApiBoot (ctx, next) {
    console.log('Nightscout Executing startBoot (role api)');
    beginContext(ctx, function localEvents () {
      const EventEmitter = require('events');
      const events = new EventEmitter();
      events.local = true;
      // The heartbeat bus's shutdown hook, without a timer to clear.
      events.teardown = function teardown () { events.emit('teardown'); };
      return events;
    });
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
    if (bridgeConnectCompat.legacyBridgeRequested(env.extendedSettings && env.extendedSettings.bridge)) {
      console.log('DEPRECATION WARNING', bridgeConnectCompat.LEGACY_OVERRIDE_IGNORED);
    }
    var result = bridgeConnectCompat.applyBridgeToConnectCompatibility(env);
    if (result.migrated) {
      console.log('BRIDGE credentials are served by Nightscout Connect; the legacy Dexcom bridge has been removed.');
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
      } catch {
        console.error('Parsing config URL from IMPORT_CONFIG failed');
      }
    }

    if(configURL && href) {
      var axios_default = { headers: { 'Accept': 'application/json' },
        redact: ['password', 'authorization', 'proxy-authorization'] };
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

    const worldReadable = worldReadableNotify(env.settings);
    if (worldReadable) {
      ctx.adminnotifies.addNotify(worldReadable);
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

  function restoreHistoryClock (ctx, next) {
    if (hasBootErrors(ctx)) return next();
    require('./srv-dates').restore(ctx.store, env).then(function () {
      next();
    }, function (err) {
      // Do not admit writers with a clock behind an already issued cursor.
      ctx.bootErrors.push({ desc: 'Unable to restore history clock', err: err.message });
      next();
    });
  }

  function setupAuthorization (ctx, next) {

    console.log('Executing setupAuthorization');

    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.authorization = require('../authorization')(env, ctx);
    const indexes = ctx.authorization.storage.ensureIndexes();
    awaitIndexes([indexes], 'authorization').then(function () {
      ctx.authorization.storage.reload(function loaded (err) {
        if (err) {
          ctx.bootErrors = ctx.bootErrors || [ ];
          ctx.bootErrors.push({'desc': 'Unable to setup authorization', err: err});
        }
        next();
      });
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
      , webhook: env.webhook
      , language: ctx.language
      , levels: ctx.levels
      , moment: ctx.moment
    }).registerServerDefaults();

    ctx.wares = require('../middleware/')(env);

    ctx.pushover = require('../plugins/pushover')(env, ctx);
    ctx.maker = require('../plugins/maker')(env);
    ctx.pushnotify = require('./pushnotify')(env, ctx);
    ctx.loop = require('./loop')(env, ctx);
    // Always constructed, even with no credentials set: unlike a plugin, this has to exist so
    // it can report its own misconfiguration. Half its configuration - the device token, bundle
    // id and environment - arrives later, in a document written by each iOS client.
    ctx.apnspush = require('./apnspush')(env, ctx);

    // Configure the write sanitizer before constructing storage adapters.
    // Importers and legacy bridges call those adapters without going through
    // an HTTP route, so the storage layer must be able to fail closed.
    ctx.purifier = require('./purifier')(env,ctx);

    ctx.activity = require('./activity')(env, ctx);
    ctx.entries = require('./entries')(env, ctx);
    ctx.treatments = require('./treatments')(env, ctx);
    ctx.devicestatus = require('./devicestatus')(env, ctx);
    ctx.profile = require('./profile')(env.profile_collection, ctx, env);
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

  // What API v3 and its write path take from ctx beyond storage and
  // authorization: alarm levels (alarmSocket is constructed with the v3 app)
  // and the write sanitizer (writePurifier refuses writes without it).
  function setupApiInternals (ctx, next) {

    console.log('Executing setupInternals (role api)');

    if (hasBootErrors(ctx)) {
      return next();
    }

    ctx.levels = require('../levels');
    ctx.levels.translate = ctx.language.translate;
    ctx.purifier = require('./purifier')(env, ctx);

    next( );
  }

  // API v3 is mounted after boot and asks for its own indexes on these
  // collections and on settings; ask here so its first write does not wait.
  function wantApi3Indexes (ctx, want) {
    const api3Fields = require('../api3/storage/mongoCollection').indexedFields;
    const api3Names = require('../api3/generic/setup').storageColNames(env);
    Object.values(api3Names).forEach(function (name) {
      want(ctx.store.collection(name), api3Fields);
    });
  }

  // the api profile: API v3's indexes only. The v1 modules that declare the
  // other indexes (lib/server/entries.js and its siblings) are not built.
  function ensureApiIndexes (ctx, next) {

    console.log('Executing ensureIndexes (role api)');

    if (hasBootErrors(ctx)) {
      return next();
    }

    const requested = [];
    wantApi3Indexes(ctx, function want (collection, fields) {
      requested.push(ctx.store.ensureIndexes(collection, fields));
    });
    awaitIndexes(requested, 'API v3 collections').then(function () {
      next( );
    });
  }

  function ensureIndexes (ctx, next) {

    console.log('Executing ensureIndexes');

    if (hasBootErrors(ctx)) {
      return next();
    }

    console.info('Ensuring indexes');
    // One request per collection, so its indexes are built together.
    const wanted = new Map();
    function want (collection, fields) {
      const entry = wanted.get(collection.collectionName) || { collection, fields: [] };
      entry.fields = entry.fields.concat(fields);
      wanted.set(collection.collectionName, entry);
    }
    want(ctx.entries( ), ctx.entries.indexedFields);
    want(ctx.treatments( ), ctx.treatments.indexedFields);
    want(ctx.devicestatus( ), ctx.devicestatus.indexedFields);
    want(ctx.profile( ), ctx.profile.indexedFields);
    want(ctx.food( ), ctx.food.indexedFields);
    want(ctx.activity( ), ctx.activity.indexedFields);
    wantApi3Indexes(ctx, want);

    const requested = Array.from(wanted.values()).map(function (entry) {
      return ctx.store.ensureIndexes(entry.collection, entry.fields);
    });

    awaitIndexes(requested, 'data collections').then(function () {
      next( );
    });
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
      if (env.debug && env.debug.logging) console.debug('tick', tick.now);
      updateData();
    });

    ctx.bus.on('data-received', function forceReloadData ( ) {
      if (env.debug && env.debug.logging) console.debug('got data-received event, requesting reload');
      updateData();
    });

    ctx.bus.on('data-loaded', function updatePlugins ( ) {
      if (env.debug && env.debug.logging) console.debug('data loaded: reloading sandbox data and updating plugins');
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
    if (hasBootErrors(ctx)) return next();
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
      console.log('MMCONNECT credentials are served by Nightscout Connect; the legacy MiniMed bridge has been removed.');
    }
    // Legacy credential migration may enable CONNECT implicitly.
    const connect = env.extendedSettings && env.extendedSettings.connect;
    if (!connect || !connect.source) {
      ctx.nightscoutConnect = undefined;
      console.log('Skipping disabled nightscout-connect');
      return next();
    }
    // nightscout-connect 0.1.0 registers its own stop() on the bus's
    // tearDown/teardown events, so boot adds no teardown listener for it.
    ctx.nightscoutConnect = require('nightscout-connect')(env, ctx);
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

  function finishApiBoot (ctx, next) {
    console.log('Executing finishBoot (role api)');
    if (hasBootErrors(ctx)) {
      return next();
    }
    ctx.runtimeState = 'booted';
    next( );
  }

  const stages = {
    checkNodeVersion, startBoot, startApiBoot, checkEnv, augmentSettings,
    checkSettings, setupStorage, restoreHistoryClock, setupAuthorization,
    setupInternals, setupApiInternals, ensureIndexes, ensureApiIndexes,
    setupListeners, setupConnect, finishBoot, finishApiBoot
  };

  const profile = (options && options.profile) || 'single';
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) {
    throw new Error('Unknown boot profile: ' + profile);
  }
  return require('../utils/boot-sequence')(PROFILES[profile].map(function (name) {
    return stages[name];
  }));
}

// Each boot profile is a selection of the stages above, in order. `single` is
// the full chain every existing start path runs. `api` is the api role (today the headless test server): env,
// storage, the history clock, authorization and what API v3 takes from ctx;
// no heartbeat bus, ddata, data loader, cache, plugins, notifications,
// websocket, connect or v1/v2 modules.
const PROFILES = {
  single: [
    'checkNodeVersion', 'startBoot', 'checkEnv', 'augmentSettings', 'checkSettings',
    'setupStorage', 'restoreHistoryClock', 'setupAuthorization', 'setupInternals',
    'ensureIndexes', 'setupListeners', 'setupConnect', 'finishBoot'
  ]
  , api: [
    'checkNodeVersion', 'startApiBoot', 'checkEnv', 'augmentSettings', 'checkSettings',
    'setupStorage', 'restoreHistoryClock', 'setupAuthorization', 'setupApiInternals',
    'ensureApiIndexes', 'finishApiBoot'
  ]
};

module.exports = boot;
module.exports.worldReadableNotify = worldReadableNotify;
module.exports.awaitIndexes = awaitIndexes;
module.exports.INDEX_WAIT_MS = INDEX_WAIT_MS;
module.exports.PROFILES = PROFILES;
