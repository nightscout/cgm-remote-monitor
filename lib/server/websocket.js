'use strict';

const { createHandlers, isDocument, onceReply } = require('./socket-write-handlers');

var calcData = require('../data/calcdelta');
const { clientIPFor } = require('./client-ip');

function init (env, ctx, server) {
  const getRemoteIP = clientIPFor(env);

  function websocket () {
    return websocket;
  }

  //var log_yellow = '\x1B[33m';
  var log_green = '\x1B[32m';
  var log_reset = '\x1B[0m';
  var LOG_WS = log_green + 'WS: ' + log_reset;

  var io;
  var watchers = 0;
  var lastData = {};
  var lastProfileSwitch = null;

  // This is little ugly copy but I was unable to pass testa after making module from status and share with /api/v1/status
  function status () {
    var versionNum = 0;
    const vString = '' + env.version;
    const verParse = vString.split('.');
    if (verParse) {
      versionNum = 10000 * Number(verParse[0]) + 100 * Number(verParse[1]) + 1 * Number(verParse[2]);
    }

    var apiEnabled = env.enclave.isApiKeySet();

    var activeProfile = ctx.ddata.lastProfileFromSwitch;

    var info = {
      status: 'ok'
      , name: env.name
      , version: env.version
      , versionNum: versionNum
      , serverTime: new Date().toISOString()
      , apiEnabled: apiEnabled
      , careportalEnabled: apiEnabled && env.settings.enable.indexOf('careportal') > -1
      , boluscalcEnabled: apiEnabled && env.settings.enable.indexOf('boluscalc') > -1
      , settings: env.settings
      , extendedSettings: ctx.plugins && ctx.plugins.extendedClientSettings ? ctx.plugins.extendedClientSettings(env.extendedSettings) : {}
    };

    if (activeProfile) {
      info.activeProfile = activeProfile;
    }
    return info;
  }

  function start () {
    io = require('socket.io')({
      'log level': 0
    }).listen(server, {
      //these only effect the socket.io.js file that is sent to the client, but better than nothing
      // compat with v2 client
      allowEIO3: true
      , 'browser client minification': true
      , 'browser client etag': true
      , 'browser client gzip': false
      , 'perMessageDeflate': {
        threshold: 512
      }
      , transports: ["polling", "websocket"]
      , httpCompression: {
        threshold: 512
      }
    });

    ctx.bus.on('teardown', function serverTeardown () {
      Object.keys(io.sockets.sockets).forEach(function(s) {
        io.sockets.sockets[s].disconnect(true);
      });
      io.close();
    });

    ctx.bus.on('data-processed', function() {
      update();
    });

  }

  function verifyAuthorization (message, ip, callback) {

    if (!message) message = {};

    ctx.authorization.resolve({ api_secret: message.secret, token: message.token, ip: ip }, function resolved (err, result) {

      if (err) {
        return callback(err, {
          read: false
          , write: false
          , write_treatment: false
          , error: true
        });
      }

      return callback(null, {
        read: ctx.authorization.checkMultiple('api:*:read', result.shiros)
        , write: ctx.authorization.checkMultiple('api:*:create,update,delete', result.shiros)
        , write_treatment: ctx.authorization.checkMultiple('api:treatments:create,update,delete', result.shiros)
      });
    });
  }

  function emitData (delta) {
    if (lastData.cals) {
      // console.log(LOG_WS + 'running websocket.emitData', ctx.ddata.lastUpdated);
      if (lastProfileSwitch !== ctx.ddata.lastProfileFromSwitch) {
        // console.log(LOG_WS + 'profile switch detected OLD: ' + lastProfileSwitch + ' NEW: ' + ctx.ddata.lastProfileFromSwitch);
        delta.status = status(ctx.ddata.profiles);
        lastProfileSwitch = ctx.ddata.lastProfileFromSwitch;
      }
      io.to('DataReceivers').compress(true).emit('dataUpdate', delta);
    }
  }

  function listeners () {
    io.sockets.on('connection', function onConnection (socket) {
      var socketAuthorization = null;
      // What this socket authorized with, redacted from refusal payloads.
      var socketCredentials = [];

      const remoteIP = getRemoteIP(socket.request);
      console.log(LOG_WS + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      io.emit('clients', ++watchers);
      socket.on('disconnect', function onDisconnect () {
        io.emit('clients', --watchers);
        console.log(LOG_WS + 'Disconnected client ID: ', socket.client.id);
      });

      /* Resolve read access for a socket that may never have sent `authorize`.
       *
       * An authorized socket already carries the decision the `authorize`
       * handler made. An anonymous one carries nothing, and asking
       * verifyAuthorization with an empty message resolves exactly the default
       * permissions `authorize` would have resolved for it - the same
       * AUTH_DEFAULT_ROLES shiros the REST surface answers with. So an instance
       * left on the documented `readable` default keeps serving anonymous
       * clients, and one on `denied` refuses them here as it does everywhere
       * else.
       */
      function resolveReadAccess (next) {
        if (socketAuthorization) return next(Boolean(socketAuthorization.read));

        verifyAuthorization({}, remoteIP, function resolved (err, authorization) {
          next(!err && Boolean(authorization && authorization.read));
        });
      }

      socket.on('loadRetro', function loadRetro (opts, callback) {
        var reply = onceReply(callback);

        resolveReadAccess(function withReadAccess (permitted) {
          if (!permitted) {
            console.log(LOG_WS + 'loadRetro: ', 'Not permitted');
            if (reply) reply({ result: 'Not permitted' });
            return;
          }

          if (reply) reply({ result: 'success' });
          //TODO: use opts to only send delta for retro data
          socket.compress(true).emit('retroUpdate', { devicestatus: lastData.devicestatus });
          console.info('sent retroUpdate', opts);
        });
      });

      const writeHandlers = createHandlers({ env, ctx,
        authorizationFor: () => socketAuthorization,
        credentialsFor: () => socketCredentials,
        clientId: socket.client.id, logPrefix: LOG_WS });
      for (const [event, handler] of Object.entries(writeHandlers)) socket.on(event, handler);

      // Authorization message
      // {
      //  client: 'web' | 'phone' | 'pump'
      //  , secret: 'secret_hash'
      //  [, history : history_in_hours ]
      //  [, status : true ]
      // }
      socket.on('authorize', function authorize (message, callback) {
        var authMessage = isDocument(message) ? message : {};
        socketCredentials = [authMessage.secret, authMessage.token];
        var reply = onceReply(callback);
        const remoteIP = getRemoteIP(socket.request);
        verifyAuthorization(authMessage, remoteIP, function verified (err, authorization) {

          if (err) {
            console.log('Websocket authorization failed:', err);
            socket.disconnect();
            return;
          }

          socket.emit('connected');

          socketAuthorization = authorization;
          if (socketAuthorization.read) {
            socket.join('DataReceivers');

            if (lastData && lastData.dataWithRecentStatuses) {
              let data = lastData.dataWithRecentStatuses();

              if (authMessage.status) {
                data.status = status(data.profiles);
              }

              socket.emit('dataUpdate', data);
            }
          }
          if (reply) reply(socketAuthorization);
        });
      });
    });
  }

  function update () {
    // console.log(LOG_WS + 'running websocket.update');
    if (lastData.sgvs) {
      var delta = calcData(lastData, ctx.ddata);
      if (delta.delta) {
        // console.log('lastData full size', JSON.stringify(lastData).length,'bytes');
        // if (delta.sgvs) { console.log('patientData update size', JSON.stringify(delta).length,'bytes'); }
        emitData(delta);
      } // else { console.log('delta calculation indicates no new data is present'); }
    }
    lastData = ctx.ddata.clone();
  }

  start();
  listeners();

  if (ctx.storageSocket) {
    ctx.storageSocket.init(io);
  }

  if (ctx.alarmSocket) {
    ctx.alarmSocket.init(io);
  }

  return websocket();
}

module.exports = init;
