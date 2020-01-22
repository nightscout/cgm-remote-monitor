'use strict';

const apiConst = require('./const');

/**
 * Socket.IO broadcaster of any storage change
 */
function StorageSocket (app, env, ctx) {

  const self = this;

  const LOG_GREEN = '\x1B[32m'
    , LOG_MAGENTA = '\x1B[35m'
    , LOG_RESET = '\x1B[0m'
    , LOG = LOG_GREEN + 'STORAGE SOCKET: ' + LOG_RESET
    , LOG_ERROR = LOG_MAGENTA + 'STORAGE SOCKET: ' + LOG_RESET
    , NAMESPACE = '/storage'
    ;


  /**
   * Initialize socket namespace and bind the events
   * @param {Object} io Socket.IO object to multiplex namespaces
   */
  self.init = function init (io) {
    self.io = io;

    self.namespace = io.of(NAMESPACE);
    self.namespace.on('connection', function onConnected (socket) {

      const remoteIP = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
      console.log(LOG + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      socket.on('disconnect', function onDisconnect () {
        console.log(LOG + 'Disconnected client ID: ', socket.client.id);
      });

      socket.on('subscribe', function onSubscribe (message, returnCallback) {
        self.subscribe(socket, message, returnCallback);
      });
    });

    ctx.bus.on('storage-socket-create', self.emitCreate);
    ctx.bus.on('storage-socket-update', self.emitUpdate);
    ctx.bus.on('storage-socket-delete', self.emitDelete);
  };


  /**
   * Authorize Socket.IO client and subscribe him to authorized rooms
   * @param {Object} socket
   * @param {Object} message input message from the client
   * @param {Function} returnCallback function for returning a value back to the client
   */
  self.subscribe = function subscribe (socket, message, returnCallback) {
    const shouldCallBack = typeof(returnCallback) === 'function';

    if (message && message.accessToken) {
      return ctx.authorization.resolveAccessToken(message.accessToken, function resolveFinish (err, auth) {
        if (err) {
          console.log(`${LOG_ERROR} Authorization failed for accessToken:`, message.accessToken);

          if (shouldCallBack) {
            returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN });
          }
          return err;
        }
        else {
          return self.subscribeAuthorized(socket, message, auth, returnCallback);
        }
      });
    }

    console.log(`${LOG_ERROR} Authorization failed for message:`, message);
    if (shouldCallBack) {
      returnCallback({ success: false, message: apiConst.MSG.SOCKET_MISSING_OR_BAD_ACCESS_TOKEN});
    }
  };


  /**
   * Subscribe already authorized Socket.IO client to his rooms
   * @param {Object} socket
   * @param {Object} message input message from the client
   * @param {Object} auth authorization of the client
   * @param {Function} returnCallback function for returning a value back to the client
   */
  self.subscribeAuthorized = function subscribeAuthorized (socket, message, auth, returnCallback) {
    const shouldCallBack = typeof(returnCallback) === 'function';
    const enabledCols = app.get('enabledCollections');
    const cols = Array.isArray(message.collections) ? message.collections : enabledCols;
    const subscribed = [];

    for (const col of cols) {
      if (enabledCols.includes(col)) {
        const permission = (col === 'settings') ? `api:${col}:admin` : `api:${col}:read`;

        if (ctx.authorization.checkMultiple(permission, auth.shiros)) {
          socket.join(col);
          subscribed.push(col);
        }
      }
    }

    const doc = subscribed.length > 0
      ? { success: true, collections: subscribed }
      : { success: false, message: apiConst.MSG.SOCKET_UNAUTHORIZED_TO_ANY };
    if (shouldCallBack) {
      returnCallback(doc);
    }
    return doc;
  };


  /**
   * Emit create event to the subscribers (of the collection's room)
   * @param {Object} event
   */
  self.emitCreate = function emitCreate (event) {
    self.namespace.to(event.colName)
      .emit('create', event);
  };


  /**
   * Emit update event to the subscribers (of the collection's room)
   * @param {Object} event
   */
  self.emitUpdate = function emitUpdate (event) {
    self.namespace.to(event.colName)
      .emit('update', event);
  };


  /**
   * Emit delete event to the subscribers (of the collection's room)
   * @param {Object} event
   */
  self.emitDelete = function emitDelete (event) {
    self.namespace.to(event.colName)
      .emit('delete', event);
  }
}

module.exports = StorageSocket;