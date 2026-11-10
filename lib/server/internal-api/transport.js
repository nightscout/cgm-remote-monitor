'use strict';

// Shared internal HTTP framing. Every listener owns exactly one service contract.
// UDS uses filesystem/service-UID trust; HTTP reachability is deployment-owned.
const http = require('node:http');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { validate, compile } = require('./schema');
const c = {
  object: value => value !== null && typeof value === 'object' && !Array.isArray(value),
  integer: (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value > 0 && value <= max,
  fail: code => { throw Object.assign(new Error(code), { code }); },
  exact: (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
};
function options (value) {
  if (c.exact(value, ['url', 'trust', 'maxBytes', 'timeoutMs']) ||
      c.exact(value, ['url', 'trust', 'bindHost', 'maxBytes', 'timeoutMs'])) {
    let url;
    try { url = new URL(value.url); } catch { c.fail('SOCKET_IPC_CONFIG_REFUSED'); }
    if (typeof value.url !== 'string' || url.protocol !== 'http:' || !url.hostname ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash || value.trust !== 'network' ||
        Object.hasOwn(value, 'bindHost') && (typeof value.bindHost !== 'string' || !value.bindHost || /[\s/[\]]/.test(value.bindHost)) ||
        !c.integer(value.maxBytes) || !c.integer(value.timeoutMs, 2147483647)) c.fail('SOCKET_IPC_CONFIG_REFUSED');
    return Object.freeze({ ...value });
  }
  if (!c.exact(value, ['socketPath', 'maxBytes', 'timeoutMs']) || typeof value.socketPath !== 'string' || !path.isAbsolute(value.socketPath) ||
      Buffer.byteLength(value.socketPath) > 100 || !c.integer(value.maxBytes) || !c.integer(value.timeoutMs, 2147483647)) c.fail('SOCKET_IPC_CONFIG_REFUSED');
  return Object.freeze({ ...value });
}
function serviceContract (service) {
  if (!c.exact(service, ['id', 'version', 'operations']) || typeof service.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(service.id) || !c.integer(service.version) || !c.object(service.operations) ||
      !Object.keys(service.operations).length) throw new TypeError('Internal API requires a service contract');
  const paths = new Set(), entries = [];
  for (const [name, spec] of Object.entries(service.operations)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !c.exact(spec, ['path', 'request', 'response']) ||
        typeof spec.path !== 'string' || !/^\/[a-z][a-z0-9/-]*$/.test(spec.path) || paths.has(spec.path) ||
        !c.object(spec.request) || !c.object(spec.response)) throw new TypeError('Invalid internal service operation');
    paths.add(spec.path);
    const snapshot = JSON.parse(JSON.stringify(spec));
    compile(snapshot.request); compile(snapshot.response);
    entries.push([name, snapshot]);
  }
  return { id: service.id, version: service.version, operations: Object.fromEntries(entries) };
}
function directory (socketPath) {
  const parent = path.dirname(socketPath), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  if (fs.realpathSync(parent) !== parent) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  return stat;
}
function handler ({ service, operations, maxBytes, timeoutMs, admitted, token, operationWindow, resolveTenant }) {
  service = serviceContract(service);
  if (!c.object(operations) || !Object.values(operations).every(fn => typeof fn === 'function') || typeof admitted !== 'function' || typeof token !== 'symbol') throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
  if (operationWindow && (typeof operationWindow.run !== 'function' || typeof resolveTenant !== 'function')) throw new TypeError('Private operation lifetime requires tenant resolution');
  const names = Object.keys(service.operations);
  if (!c.exact(operations, names)) throw new TypeError('Internal API handlers must match the service contract exactly');
  // Paths come only from this listener's contract. Never forward a caller URL or
  // select an object property from it; other services cannot register here.
  const table = new Map(names.map(name => [service.operations[name].path, { ...service.operations[name], invoke: operations[name] }]));
  return async (req, res) => {
    let timer;
    try {
      const operation = table.get(req.url);
      if (admitted(req) !== true || req.method !== 'POST' || !operation || typeof operation.invoke !== 'function' ||
          req.headers['x-nightscout-internal-service'] !== service.id || req.headers['x-nightscout-internal-version'] !== String(service.version) ||
          !['application/json', 'application/json; charset=utf-8'].includes((req.headers['content-type'] || '').toLowerCase())) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      timer = setTimeout(() => req.destroy(), timeoutMs);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      validate(operation.request, body);
      const respond = async () => {
      const result = await operation.invoke(Object.freeze({ transport: token }), body);
      if (admitted(req) !== true) c.fail('SOCKET_IPC_CLOSED');
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > maxBytes) c.fail('SOCKET_IPC_RESPONSE_REFUSED');
      validate(operation.response, JSON.parse(bytes.toString('utf8')));
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
async function open (input, service, makeOperations, lifetime = {}) {
  const opts = options(input);
  if (opts.socketPath) {
    directory(opts.socketPath);
    try { fs.lstatSync(opts.socketPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (typeof makeOperations !== 'function') throw new TypeError('Private transport requires a trusted operation factory');
  // Linux reference: libuv owns only this unadvertised internal pathname.
  // Atomic hard-link publication never replaces an existing configured path.
  const internalPath = opts.socketPath ? path.join(path.dirname(opts.socketPath), '.ns-' + randomBytes(8).toString('hex') + '.sock') : null;
  if (internalPath) {
    options({ ...opts, socketPath: internalPath });
    try { fs.lstatSync(internalPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const token = Symbol('owned-private-socket');
  const operations = makeOperations(token);
  let closed = false, own, internalOwn, closing; const sockets = new Set(), jobs = new Set();
  const serve = handler({ ...opts, ...lifetime, service, operations, token, admitted: req => !closed && sockets.has(req.socket) });
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
    if (opts.url) {
      const url = new URL(opts.url);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port || 80), opts.bindHost || url.hostname.replace(/^\[|\]$/g, ''), resolve); });
      return Object.freeze({ close });
    }
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
function client (input, service, request = http.request) {
  const opts = options(input);
  service = serviceContract(service);
  const methods = Object.create(null);
  for (const [name, operation] of Object.entries(service.operations)) methods[name] = async (body, signal) => {
    if (!c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
    if (opts.socketPath) {
      directory(opts.socketPath);
      const target = fs.lstatSync(opts.socketPath);
      if (!target.isSocket() || target.uid !== process.getuid() || (target.mode & 0o077)) c.fail('SOCKET_IPC_OWNERSHIP_REFUSED');
    }
    const bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > opts.maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED');
    validate(operation.request, JSON.parse(bytes.toString('utf8')));
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('SOCKET_IPC_UNAVAILABLE'));
      const url = opts.url ? new URL(opts.url) : null;
      const endpoint = url ? { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) } : { socketPath: opts.socketPath };
      const req = request({ ...endpoint, path: operation.path, method: 'POST', signal, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': bytes.length,
          'x-nightscout-internal-service': service.id, 'x-nightscout-internal-version': String(service.version) } }, res => {
        let length = 0; const chunks = [];
        res.on('data', chunk => { length += chunk.length; if (length > opts.maxBytes) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200 || !/^application\/json/.test(res.headers['content-type'] || '')) throw new Error();
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!c.object(value)) throw new Error();
            validate(operation.response, value); resolve(value);
          } catch { fail(); }
        });
      });
      const deadline = setTimeout(() => req.destroy(), opts.timeoutMs);
      req.once('close', () => clearTimeout(deadline));
      req.setTimeout(opts.timeoutMs, () => req.destroy()); req.on('error', fail); req.end(bytes);
    });
  };
  return Object.freeze(methods);
}
module.exports = { options, directory, handler, open, client };
