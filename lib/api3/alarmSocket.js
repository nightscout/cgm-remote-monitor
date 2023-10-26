'use strict';

const apiConst = require('./const');
const forwarded = require('forwarded-for');

function getRemoteIP (req) {
  const address = forwarded(req, req.headers);
  return address.ip;
}

/**
 * Socket.IO broadcaster of alarm and annoucements
 */
function AlarmSocket (app, env, ctx) {

  const self = this;

  var levels = ctx.levels;

  const LOG_GREEN = '\x1B[32m'
    , LOG_MAGENTA = '\x1B[35m'
    , LOG_RESET = '\x1B[0m'
    , LOG = LOG_GREEN + 'ALARM SOCKET: ' + LOG_RESET
    , LOG_ERROR = LOG_MAGENTA + 'ALARM SOCKET: ' + LOG_RESET
    , NAMESPACE = '/alarm'
    ;


  /**
   * Initialize socket namespace and bind the events
   * @param {Object} io Socket.IO object to multiplex namespaces
   */
  self.init = function init (io) {
    self.io = io;

    self.namespace = io.of(NAMESPACE);
    self.namespace.on('connection', function onConnected (socket) {

      const remoteIP = getRemoteIP(socket.request);
      console.log(LOG + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      socket.on('disconnect', function onDisconnect () {
        console.log(LOG + 'Disconnected client ID: ', socket.client.id);
      });

      socket.on('subscribe', function onSubscribe (message, returnCallback) {
        self.subscribe(socket, message, returnCallback);
      });

    });

    // Turns all notifications on the event bus back into events to be
    // broadcast to clients.
    ctx.bus.on('notification', self.emitNotification);
  };


  /**
   * Authorize Socket.IO client and subscribe him to authorized rooms
   *
   * Support webclient authorization with api_secret is added
   *
   * @param {Object} socket
   * @param {Object} message input message from the client
   * @param {Function} returnCallback function for returning a value back to the client
   */
  self.subscribe = function subscribe (socket, message, returnCallback) {
    const shouldCallBack = typeof(returnCallback) === 'function';

    // Native client
    if (message && message.accessToken) {
      return ctx.authorization.resolveAccessToken(message.accessToken, function resolveFinishForToken (err, auth) {
        if (err) {
          console.log(`${LOG_ERROR} Authorization failed for accessToken:`, message.accessToken);

          if (shouldCallBack) {
            returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
          }
          return err;
        } else {
      // Subscribe for acking alarms
      // Client sends ack, which sends a notificaiton through our internal bus
      socket.on('ack', function onAck (level, group, silenceTime) {
      ctx.notifications.ack(level, group, silenceTime, true);
          console.info(LOG + 'ack received ' + level + ' ' + group + ' ' + silenceTime);
        });

      var okResponse = { success: true, message: 'Subscribed for alarms' }
          if (shouldCallBack) {
            returnCallback(okResponse);
          }
          return okResponse;
        }
      });
    }

    if (!message) { message = {}; }
    // Web client (jwt access token or api_hash)
    /*
    * On the web: a client may have saved a secret or using a jwtToken, or may have none.
    * Some pages will automatically prompt for authorization, when needed.
    * To make the main homepage require authorization as well, set
    * AUTHENTICATION_PROMPT_ON_LOAD=true.
    *
    * If there is missing authorization when authorization is required,
    * rejecting the attempt in order to trigger a prompt on the client.
    * If there is no authorization required, or there are available
    * credentials, attempt to resolve the available permissions.
    * When processing ACK messages that dismiss alarms, Authorization should be
    * required.
    */
    var shouldTry = true;
    if (env.settings.authenticationPromptOnLoad) {
      if (!message.jwtToken && !message.secret) {
        shouldTry = false;
      }
    }

    if (message && shouldTry) {
      return ctx.authorization.resolve({ api_secret: message.secret, token: message.jwtToken, ip: getRemoteIP(socket.request) }, function resolveFinish (err, auth) {

        if (err) {
          console.log(`${LOG_ERROR} Authorization failed for jwtToken:`, message.jwtToken);

          if (shouldCallBack) {
            returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
          }
          return err;
        } else {
          var perms = {
            read: ctx.authorization.checkMultiple('api:*:read', auth.shiros)
          , ack: ctx.authorization.checkMultiple('notifications:*:ack', auth.shiros)
          };
          // Subscribe for acking alarms
          // TODO: does this produce double ACK after the authorizing? Only if reconnecting?
          // TODO: how will perms get updated after authorizing?
          socket.on('ack', function onAck (level, group, silenceTime) {
            if (perms.ack) {
              // This goes through the server-wide event bus.
              ctx.notifications.ack(level, group, silenceTime, true);
              console.info(LOG + 'ack received ' + level + ' ' + group + ' ' + silenceTime);
            } else {
              // TODO: send a message to client to silence locally, but not
              // globally, and request authorization.
              // This won't go through th event bus.
              // var acked = { silenceTime, group, level };
              // socket.emit('authorization_needed', acked);
            }
          });
          /* TODO: need to know when to update the permissions.
          // Can we use
          socket.on('resubscribe', function update_permissions ( ) {
            // perms = { ... };
          });
          */

          var okResponse = { success: true, message: 'Subscribed for alarms', ...perms };
          if (shouldCallBack) {
            returnCallback(okResponse);
          }
          return okResponse;
        }
      });
    }

    console.log(`${LOG_ERROR} Authorization failed for message:`, message);
    if (shouldCallBack) {
      returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN});
    }
  };


  /**
   * Emit alarm to subscribed clients
   * @param {Object} notofication to emit
   */
   
  self.emitNotification = function emitNotification (notify) {
    if (notify.clear) {
      self.namespace.emit('clear_alarm', notify);
      console.info(LOG + 'emitted clear_alarm to all clients');
    } else if (notify.level === levels.WARN) {
      self.namespace.emit('alarm', notify);
      console.info(LOG + 'emitted alarm to all clients');
    } else if (notify.level === levels.URGENT) {
      self.namespace.emit('urgent_alarm', notify);
      console.info(LOG + 'emitted urgent_alarm to all clients');
    } else if (notify.isAnnouncement) {
      self.namespace.emit('announcement', notify);
      console.info(LOG + 'emitted announcement to all clients');
    } else {
      self.namespace.emit('notification', notify);
      console.info(LOG + 'emitted notification to all clients');
    }
  };
}

module.exports = AlarmSocket;
