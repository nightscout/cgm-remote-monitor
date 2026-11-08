'use strict';

// Actual Express middleware/parser dispatch over Node's HTTP message classes.
// No bound socket, server, network HTTP, cookie or browser behavior is claimed.
const { IncomingMessage, ServerResponse } = require('node:http');
const { Socket } = require('node:net');
module.exports = function dispatch (app, { method, path, body, credential = 'synthetic-management', host = 'one.example.test' }) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(), req = new IncomingMessage(socket);
    req.method = method; req.url = path;
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    req.headers = { host, ...(credential === null ? {} : { authorization: 'Bearer ' + credential }),
      ...(encoded === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) }) };
    req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
    const res = new ServerResponse(req);
    res.end = data => {
      try {
        const text = data === undefined ? '' : String(data);
        resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : undefined });
      } catch (error) { reject(error); }
      finally { res.emit('finish'); socket.destroy(); }
      return res;
    };
    app.handle(req, res, error => { if (error) reject(error); else reject(new Error('Unanswered request')); });
    if (encoded !== undefined) req.push(encoded);
    req.push(null);
  });
};
