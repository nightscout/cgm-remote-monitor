'use strict';

// The realtime role's Socket.IO server on its HTTP listener (BF-233).
// Shutdown closes the transports (engine.close via io.close), never each
// socket from the server side. A server-side disconnect makes socket.io-client
// stop for good ("io server disconnect"), which left every stock browser dark
// after a restart; and each such polling socket kept its engine connection and
// two timers waiting for a client that no longer polls, which held the process
// past the 10 s shutdown bound (measured: 829 TCP sockets and 1,656 timers left
// after stop() for 828 disconnected sockets). A transport close makes the
// client reconnect with its own backoff.
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
      closing = io.close(); // namespaces, then engine.close(): every transport closes
      return closing;
    } });
}
module.exports = { attach, NAMESPACES };
