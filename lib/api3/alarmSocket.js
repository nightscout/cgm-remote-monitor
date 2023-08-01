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
	
	// Web client (jwt access token or api_hash)
    if (message && (message.jwtToken || message.secret)) {
      return ctx.authorization.resolve({ api_secret: message.secret, token: message.jwtToken, ip: getRemoteIP(socket.request) }, function resolveFinish (err, auth) {
        if (err) {
          console.log(`${LOG_ERROR} Authorization failed for jwtToken:`, message.jwtToken);

          if (shouldCallBack) {
            returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
          }
          return err;
        } else {
		  // Subscribe for acking alarms
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
