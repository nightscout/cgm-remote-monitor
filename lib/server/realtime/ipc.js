'use strict';

// One-machine reference transport. Filesystem/service-UID trust only; no bearer,
// public listener, generic proxy, process identity or multi-node claim.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const c = require('./contract');
function options (value) {
  if (!c.exact(value, ['socketPath', 'maxBytes', 'timeoutMs']) || typeof value.socketPath !== 'string' || !path.isAbsolute(value.socketPath) ||
      Buffer.byteLength(value.socketPath) > 100 || !c.integer(value.maxBytes) || !c.integer(value.timeoutMs, 2147483647)) c.fail('SOCKET_IPC_CONFIG_REFUSED');
  return value;
}
function directory (socketPath) {
  const parent = path.dirname(socketPath), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  if (fs.realpathSync(parent) !== parent) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  return stat;
}
function handler ({ operations, maxBytes, timeoutMs, admitted, token }) {
  if (!c.object(operations) || !Object.values(operations).every(fn => typeof fn === 'function') || typeof admitted !== 'function' || typeof token !== 'symbol') throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
  return async (req, res) => {
    let timer;
    try {
      if (admitted(req) !== true || req.method !== 'POST' || !Object.hasOwn(operations, req.url) ||
          !['application/json', 'application/json; charset=utf-8'].includes((req.headers['content-type'] || '').toLowerCase())) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      timer = setTimeout(() => req.destroy(), timeoutMs);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      const result = await operations[req.url](Object.freeze({ transport: token, raw: req }), body);
      if (admitted(req) !== true) c.fail('SOCKET_IPC_CLOSED');
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > maxBytes) c.fail('SOCKET_IPC_RESPONSE_REFUSED');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(bytes);
    } catch {
      if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"SOCKET_IPC_UNAVAILABLE"}'); }
      else res.destroy();
    } finally { clearTimeout(timer); }
  };
}
async function open (input, makeOperations) {
  const opts = options(input); directory(opts.socketPath);
  try { fs.lstatSync(opts.socketPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof makeOperations !== 'function') throw new TypeError('Private transport requires a trusted operation factory');
  const token = Symbol('owned-private-socket');
  const operations = makeOperations(token);
  let closed = false, own, closing; const sockets = new Set(), jobs = new Set();
  const serve = handler({ ...opts, operations, token, admitted: req => !closed && sockets.has(req.socket) });
  const server = http.createServer({ headersTimeout: opts.timeoutMs, requestTimeout: opts.timeoutMs }, (req, res) => {
    const job = serve(req, res); jobs.add(job); job.then(() => jobs.delete(job), () => jobs.delete(job));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  function close () {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
    const stopped = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    for (const socket of sockets) socket.destroy();
    await stopped; await Promise.allSettled([...jobs]);
    // Node may unlink its own socket on close. Never remove a replacement inode.
    if (own && fs.existsSync(opts.socketPath)) {
      const current = fs.lstatSync(opts.socketPath);
      if (current.dev === own.dev && current.ino === own.ino && current.isSocket()) fs.unlinkSync(opts.socketPath);
    }
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.socketPath, resolve); });
    fs.chmodSync(opts.socketPath, 0o600); own = fs.lstatSync(opts.socketPath);
    if (!own.isSocket() || own.uid !== process.getuid() || (own.mode & 0o077)) c.fail('SOCKET_IPC_OWNERSHIP_REFUSED');
    return Object.freeze({ close });
  } catch (error) { await close(); throw error; }
}
function client (input, request = http.request) {
  const opts = options(input);
  return async function invoke (operation, body, signal) {
    if (!['/authorize', '/mutate', '/alarm'].includes(operation) || !c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
    directory(opts.socketPath);
    const target = fs.lstatSync(opts.socketPath);
    if (!target.isSocket() || target.uid !== process.getuid() || (target.mode & 0o077)) c.fail('SOCKET_IPC_OWNERSHIP_REFUSED');
    const bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > opts.maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED');
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('SOCKET_IPC_UNAVAILABLE'));
      const req = request({ socketPath: opts.socketPath, path: operation, method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
        let length = 0; const chunks = [];
        res.on('data', chunk => { length += chunk.length; if (length > opts.maxBytes) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200 || !/^application\/json/.test(res.headers['content-type'] || '')) throw new Error();
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!c.object(value)) throw new Error(); resolve(value);
          } catch { fail(); }
        });
      });
      const deadline = setTimeout(() => req.destroy(), opts.timeoutMs);
      req.once('close', () => clearTimeout(deadline));
      req.setTimeout(opts.timeoutMs, () => req.destroy()); req.on('error', fail); req.end(bytes);
    });
  };
}
module.exports = { options, directory, handler, open, client };
