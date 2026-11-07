'use strict';
// Root-owned plain HTTP same-origin reference only. No trusted proxy/TLS claim.
const http = require('node:http');
const net = require('node:net');
module.exports = async function ingress ({ apiPort, realtimePort, timeoutMs, onBirth = () => {} }) {
  if (![apiPort, realtimePort].every(n => Number.isSafeInteger(n) && n > 0 && n < 65536) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Explicit owned local listeners and deadline required');
  const sockets = new Set(); let closed = false;
  const destination = req => req.url.split('?')[0].startsWith('/socket.io/') ? realtimePort : apiPort;
  const server = http.createServer((req, res) => {
    if (closed) { res.destroy(); return; }
    const upstream = http.request({ host: '127.0.0.1', port: destination(req), method: req.method, path: req.url,
      headers: req.headers, timeout: timeoutMs }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    const timer = setTimeout(() => upstream.destroy(), timeoutMs);
    upstream.once('close', () => clearTimeout(timer)); upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (closed || destination(req) !== realtimePort) { socket.destroy(); return; }
    const upstream = net.connect({ host: '127.0.0.1', port: realtimePort }); sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream)); upstream.setTimeout(timeoutMs, () => upstream.destroy());
    upstream.once('connect', () => {
      upstream.setTimeout(0); // authenticated role owns its long-lived socket lifecycle
      upstream.write(req.method + ' ' + req.url + ' HTTP/' + req.httpVersion + '\r\n' +
        req.rawHeaders.reduce((lines, value, i, all) => i % 2 ? lines : lines + value + ': ' + all[i + 1] + '\r\n', '') + '\r\n');
      if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.once('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; onBirth({ kind: 'same-origin-ingress', pid: process.pid, host: '127.0.0.1', port });
  return Object.freeze({ port,
    async close () { closed = true; for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
};
