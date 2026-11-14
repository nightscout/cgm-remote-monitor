'use strict';
// Actual Express IncomingMessage/ServerResponse dispatch without a listener.
const http = require('node:http');
const { PassThrough } = require('node:stream');
module.exports = function dispatch (app, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new PassThrough());
    req.method = 'GET'; req.url = path; req.headers = { accept: 'application/json', ...headers };
    const res = new http.ServerResponse(req), chunks = [];
    res.write = chunk => { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    res.end = function (chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.finished = true; this.emit('finish');
      const text = Buffer.concat(chunks).toString();
      let body = text; try { body = JSON.parse(text); } catch { /* error pages remain text */ }
      resolve({ status: this.statusCode, body });
    };
    app(req, res, error => error ? reject(error) : resolve({ status: 404 }));
  });
};
