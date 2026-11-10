'use strict';

// One-machine reference transport. Filesystem/service-UID trust only; no bearer,
// public listener, generic proxy, process identity or multi-node claim.
const http = require('node:http');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
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
function handler ({ operations, maxBytes, timeoutMs, admitted, token, operationWindow, resolveTenant }) {
  if (!c.object(operations) || !Object.values(operations).every(fn => typeof fn === 'function') || typeof admitted !== 'function' || typeof token !== 'symbol') throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
  if (operationWindow && (typeof operationWindow.run !== 'function' || typeof resolveTenant !== 'function')) throw new TypeError('Private operation lifetime requires tenant resolution');
  // The dispatch table is fixed here, once, from the trusted factory's own enumerable
  // entries; a request path only ever selects a Map entry, never an object property.
  const table = new Map(Object.entries(operations));
  return async (req, res) => {
    let timer;
    try {
      const operation = table.get(req.url);
      if (admitted(req) !== true || req.method !== 'POST' || typeof operation !== 'function' ||
          !['application/json', 'application/json; charset=utf-8'].includes((req.headers['content-type'] || '').toLowerCase())) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      timer = setTimeout(() => req.destroy(), timeoutMs);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      const respond = async () => {
      const result = await operation(Object.freeze({ transport: token, raw: req }), body);
      if (admitted(req) !== true) c.fail('SOCKET_IPC_CLOSED');
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > maxBytes) c.fail('SOCKET_IPC_RESPONSE_REFUSED');
      const finished = new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        function cleanup () { res.removeListener('finish', done); res.removeListener('close', done); res.removeListener('error', failed); }
        res.once('finish', done); res.once('close', done); res.once('error', failed);
      });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(bytes);
      await finished;
      };
      if (operationWindow) await operationWindow.run(await resolveTenant(body), respond, {onInvalidated: () => res.destroy()});
      else await respond();
    } catch {
      if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"SOCKET_IPC_UNAVAILABLE"}'); }
      else res.destroy();
    } finally { clearTimeout(timer); }
  };
}
async function open (input, makeOperations, lifetime = {}) {
  const opts = options(input); directory(opts.socketPath);
  try { fs.lstatSync(opts.socketPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (typeof makeOperations !== 'function') throw new TypeError('Private transport requires a trusted operation factory');
  // Linux reference: libuv owns only this unadvertised internal pathname.
  // Atomic hard-link publication never replaces an existing configured path.
  const internalPath = path.join(path.dirname(opts.socketPath), '.ns-' + randomBytes(8).toString('hex') + '.sock');
  options({ ...opts, socketPath: internalPath });
  try { fs.lstatSync(internalPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = Symbol('owned-private-socket');
  const operations = makeOperations(token);
  let closed = false, own, internalOwn, closing; const sockets = new Set(), jobs = new Set();
  const serve = handler({ ...opts, ...lifetime, operations, token, admitted: req => !closed && sockets.has(req.socket) });
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
    // Node auto-unlinks the internal path, never the published endpoint.
    // Only an unchanged owned public inode can be removed here.
    if (own && fs.existsSync(opts.socketPath)) {
      const current = fs.lstatSync(opts.socketPath);
      if (current.dev === own.dev && current.ino === own.ino && current.isSocket()) fs.unlinkSync(opts.socketPath);
    }
    if (internalOwn && fs.existsSync(internalPath)) {
      const current = fs.lstatSync(internalPath);
      if (current.dev === internalOwn.dev && current.ino === internalOwn.ino && current.isSocket()) fs.unlinkSync(internalPath);
    }
    })();
    return closing;
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(internalPath, resolve); });
    internalOwn = fs.lstatSync(internalPath);
    fs.chmodSync(internalPath, 0o600);
    if (!internalOwn.isSocket() || internalOwn.uid !== process.getuid()) c.fail('SOCKET_IPC_OWNERSHIP_REFUSED');
    // Ownership comes only from the bound internal inode, never from a
    // potentially replaced public pathname observed after publication.
    own = internalOwn;
    fs.linkSync(internalPath, opts.socketPath); const published = fs.lstatSync(opts.socketPath);
    if (!published.isSocket() || published.uid !== process.getuid() || (published.mode & 0o077) ||
        published.dev !== own.dev || published.ino !== own.ino) c.fail('SOCKET_IPC_OWNERSHIP_REFUSED');
    return Object.freeze({ close });
  } catch (error) { await close(); throw error; }
}
function client (input, request = http.request) {
  const opts = options(input);
  return async function invoke (operation, body, signal) {
    if (!['/authorize', '/mutate', '/alarm', '/cohort/status', '/cohort/invalidate'].includes(operation) || !c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
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
