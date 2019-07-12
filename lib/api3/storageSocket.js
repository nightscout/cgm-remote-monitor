'use strict';

/**
 * Socket.IO broadcaster of any storage change
 */
function StorageSocket () {

  const self = this;

  const LOG_GREEN = '\x1B[32m'
    , LOG_RESET = '\x1B[0m'
    , LOG = LOG_GREEN + 'STORAGE SOCKET: ' + LOG_RESET
    , NAMESPACE = '/storage'
    ;


  /**
   * Initialize socket namespace and bind the events
   */
  self.init = function init (io) {
    self.io = io;

    const namespace = io.of(NAMESPACE);
    namespace.on('connection', function onConnected (socket) {

      const remoteIP = socket.request.headers['x-forwarded-for'] || socket.request.connection.remoteAddress;
      console.log(LOG + 'Connection from client ID: ', socket.client.id, ' IP: ', remoteIP);

      socket.on('disconnect', function onDisconnect () {
        console.log(LOG + 'Disconnected client ID: ',socket.client.id);
      });
    });
  }


}

module.exports = StorageSocket;