'use strict';

// The realtime role's Socket.IO server on its HTTP listener (BF-233).
// Shutdown closes the transports (engine), not each socket from the server
// side: a server-side disconnect makes socket.io-client stop for good ("io
// server disconnect"), which left every stock browser dark after a restart;
// a transport close makes it reconnect with its own backoff. Shutdown also
// ends the listener's remaining HTTP connections at once: socket.io's
// close callback waits for httpServer.close(), which otherwise waits for
// every keep-alive polling connection and overran the 10 s shutdown bound.
const protocolFactory = require('./protocol');
const NAMESPACES = Object.freeze(['/', '/storage', '/alarm']);
function attach (server, { protocol, admission, maxMessageBytes }) {
  if (typeof server?.listen !== 'function' || typeof protocol?.bind !== 'function' || typeof admission?.resolve !== 'function') throw new TypeError('Realtime socket server requires a listener, protocol and admission');
  const io = require('socket.io')({}).listen(server, { allowEIO3: true, transports: ['polling', 'websocket'], maxHttpBufferSize: maxMessageBytes,
    allowRequest: (request, callback) => {
      if (!protocolFactory.origin(request)) return callback(null, false);
      admission.resolve(request).then(() => callback(null, true), () => callback(null, false));
    } });
  for (const namespace of NAMESPACES) {
    const channel = io.of(namespace);
    channel.use((socket, next) => protocol.prepare(socket).then(() => next(), () => next(new Error('REALTIME_HANDSHAKE_REFUSED'))));
    channel.on('connection', socket => protocol.bind(socket, namespace));
  }
  let closing;
  return Object.freeze({ io,
    close () {
      if (closing) return closing;
      closing = (async () => {
        const closed = io.close(); // namespaces, then engine.close(): every transport closes
        await new Promise(resolve => setImmediate(resolve));
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await closed;
      })();
      return closing;
    } });
}
module.exports = { attach, NAMESPACES };
