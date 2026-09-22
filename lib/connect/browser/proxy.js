'use strict';

const http = require('node:http');
const net = require('node:net');
const { allowedHost } = require('./policy');
const { publicLookup } = require('../sources/carelink/http');

module.exports = async function egress(onBlocked = () => {}) {
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(403); res.end(); });
  server.on('connection', socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(180000, () => socket.destroy());
    if (sockets.size > 128) socket.destroy();
  });
  server.on('connect', (req, client, head) => {
    const match = /^([a-z0-9.-]+):443$/.exec(req.url);
    if (!match || !allowedHost(match[1])) {
      if (match) onBlocked(match[1]);
      return client.destroy();
    }
    publicLookup(match[1], {}, (err, address) => {
      if (err || client.destroyed) return client.destroy();
      const remote = net.connect({ host: address, port: 443 });
      sockets.add(remote);
      remote.on('close', () => sockets.delete(remote));
      remote.on('error', () => client.destroy());
      client.on('close', () => remote.destroy());
      remote.setTimeout(180000, () => remote.destroy());
      remote.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) remote.write(head);
        remote.pipe(client); client.pipe(remote);
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
};
