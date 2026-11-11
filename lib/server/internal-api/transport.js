'use strict';

// Shared internal HTTP framing. A listener serves an explicitly composed, fixed
// table of (method, path) routes; each route belongs to exactly one service
// contract and carries that operation's media type, byte and deadline bounds
// and its module's lifetime policy. UDS uses filesystem/service-UID trust; HTTP
// reachability is deployment-owned.
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
// Bounded vocabulary. A GET/operational or non-JSON media module is a separate,
// explicitly specified addition; an unsupported declaration fails registration.
const METHODS = new Set(['POST']);
const MEDIA = new Set(['application/json']);
const OPTIONAL = ['method', 'contentType', 'maxBytes', 'timeoutMs'];
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const registration = (code, detail) => { throw Object.assign(new TypeError(code + (detail ? ': ' + detail : '')), { code }); };
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
  const routes = new Set(), entries = [];
  for (const [name, spec] of Object.entries(service.operations)) {
    const keys = c.object(spec) ? Object.keys(spec) : [];
    if (!/^[a-z][A-Za-z0-9]*$/.test(name) || !['path', 'request', 'response'].every(key => keys.includes(key)) ||
        keys.some(key => !['path', 'request', 'response', ...OPTIONAL].includes(key)) ||
        typeof spec.path !== 'string' || !/^\/[a-z][a-z0-9/-]*$/.test(spec.path) ||
        !c.object(spec.request) || !c.object(spec.response)) throw new TypeError('Invalid internal service operation');
    const method = Object.hasOwn(spec, 'method') ? spec.method : 'POST';
    const contentType = Object.hasOwn(spec, 'contentType') ? spec.contentType : 'application/json';
    if (!METHODS.has(method) || !MEDIA.has(contentType) ||
        Object.hasOwn(spec, 'maxBytes') && !c.integer(spec.maxBytes) ||
        Object.hasOwn(spec, 'timeoutMs') && !c.integer(spec.timeoutMs, 2147483647)) throw new TypeError('Invalid internal service operation');
    const route = method + ' ' + spec.path;
    if (routes.has(route)) registration('INTERNAL_API_ROUTE_DUPLICATE', service.id + ' ' + route);
    routes.add(route);
    const snapshot = { ...JSON.parse(JSON.stringify(spec)), method, contentType };
    compile(snapshot.request); compile(snapshot.response);
    entries.push([name, snapshot]);
  }
  return { id: service.id, version: service.version, operations: Object.fromEntries(entries) };
}
// An operation's own bound may only tighten the listener/client endpoint bound.
function bounds (operation, opts) {
  return { maxBytes: Math.min(opts.maxBytes, operation.maxBytes || Infinity), timeoutMs: Math.min(opts.timeoutMs, operation.timeoutMs || Infinity) };
}
function mediaType (value) {
  const text = (value || '').toLowerCase().trim();
  const [type, ...parameters] = text.split(';').map(part => part.trim());
  if (parameters.length > 1 || parameters.length === 1 && parameters[0] !== 'charset=utf-8') return null;
  return type;
}
// Compose an explicit registered set of service modules into one fixed route
// table. Same (method, path) twice, the same service twice, missing/extra
// handlers and partial lifetime policies refuse before any listener binds.
function routeTable (modules, opts) {
  if (!Array.isArray(modules) || !modules.length) registration('INTERNAL_API_COMPOSITION_INVALID', 'at least one service module required');
  const table = new Map(), services = new Set();
  for (const module of modules) {
    if (!c.object(module) || !Object.keys(module).every(key => ['service', 'operations', 'token', 'lifetime', 'bounds'].includes(key)) ||
        typeof module.token !== 'symbol') registration('INTERNAL_API_COMPOSITION_INVALID', 'module requires service, operations and owned token');
    // A module's own bounds may only tighten the listener's.
    if (module.bounds !== undefined && (!c.exact(module.bounds, ['maxBytes', 'timeoutMs']) || !c.integer(module.bounds.maxBytes) ||
        !c.integer(module.bounds.timeoutMs, 2147483647))) registration('INTERNAL_API_COMPOSITION_INVALID', 'module bounds require maxBytes and timeoutMs');
    const limit = module.bounds ? bounds(module.bounds, opts) : opts;
    const service = serviceContract(module.service), operations = module.operations;
    if (services.has(service.id)) registration('INTERNAL_API_SERVICE_DUPLICATE', service.id);
    services.add(service.id);
    if (!c.object(operations) || !Object.values(operations).every(fn => typeof fn === 'function')) throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
    const names = Object.keys(service.operations);
    if (!c.exact(operations, names)) throw new TypeError('Internal API handlers must match the service contract exactly');
    const lifetime = module.lifetime;
    if (lifetime !== undefined && lifetime !== null &&
        (!c.object(lifetime) || Object.keys(lifetime).some(key => !['operationWindow', 'resolveTenant'].includes(key)) ||
         !!lifetime.operationWindow !== !!lifetime.resolveTenant ||
         lifetime.operationWindow && (typeof lifetime.operationWindow.run !== 'function' || typeof lifetime.resolveTenant !== 'function'))) {
      throw new TypeError('Private operation lifetime requires tenant resolution');
    }
    const window = lifetime && lifetime.operationWindow ? Object.freeze({ operationWindow: lifetime.operationWindow, resolveTenant: lifetime.resolveTenant }) : null;
    for (const name of names) {
      const operation = service.operations[name], route = operation.method + ' ' + operation.path;
      if (table.has(route)) registration('INTERNAL_API_ROUTE_DUPLICATE', route + ' (' + table.get(route).service.id + ', ' + service.id + ')');
      table.set(route, Object.freeze({ ...operation, ...bounds(operation, limit), name, service: Object.freeze({ id: service.id, version: String(service.version) }),
        token: module.token, lifetime: window, invoke: operations[name] }));
    }
  }
  return table;
}
function directory (socketPath) {
  const parent = path.dirname(socketPath), stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  if (fs.realpathSync(parent) !== parent) c.fail('SOCKET_IPC_DIRECTORY_REFUSED');
  return stat;
}
function handler (input) {
  const { maxBytes, timeoutMs, admitted } = input || {};
  if (typeof admitted !== 'function') throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
  // `admitted` gates dispatch; `completing` gates sending a dispatched call's
  // response (a graceful close lets in-flight calls answer).
  const completing = typeof input.completing === 'function' ? input.completing : admitted;
  // Single-service form retained for existing callers: one module, one token.
  const modules = Object.hasOwn(input, 'modules') ? input.modules : [{ service: input.service, operations: input.operations, token: input.token,
    ...(input.operationWindow ? { lifetime: { operationWindow: input.operationWindow, resolveTenant: input.resolveTenant } } : {}) }];
  if (Object.hasOwn(input, 'modules') && ['service', 'operations', 'token', 'operationWindow', 'resolveTenant'].some(key => Object.hasOwn(input, key))) {
    registration('INTERNAL_API_COMPOSITION_INVALID', 'modules and single-service fields are exclusive');
  }
  if (!Object.hasOwn(input, 'modules') && typeof input.token !== 'symbol') throw new TypeError('Private socket handler requires fixed operations and owned transport admission');
  if (!Object.hasOwn(input, 'modules') && input.operationWindow && (typeof input.operationWindow.run !== 'function' || typeof input.resolveTenant !== 'function')) throw new TypeError('Private operation lifetime requires tenant resolution');
  // Routes come only from the composed contracts. Never forward a caller URL or
  // select an object property from it; an unregistered service cannot dispatch.
  const table = routeTable(modules, { maxBytes, timeoutMs });
  return Object.assign(async (req, res) => {
    let timer;
    try {
      const route = table.get(req.method + ' ' + req.url);
      if (admitted(req) !== true || !route || typeof route.invoke !== 'function' ||
          req.headers['x-nightscout-internal-service'] !== route.service.id || req.headers['x-nightscout-internal-version'] !== route.service.version ||
          mediaType(req.headers['content-type']) !== route.contentType) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      timer = setTimeout(() => req.destroy(), route.timeoutMs);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > route.maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!c.object(body)) c.fail('SOCKET_IPC_REQUEST_REFUSED');
      validate(route.request, body);
      const respond = async () => {
      const result = await route.invoke(Object.freeze({ transport: route.token }), body);
      if (completing(req) !== true) c.fail('SOCKET_IPC_CLOSED');
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > route.maxBytes) c.fail('SOCKET_IPC_RESPONSE_REFUSED');
      validate(route.response, JSON.parse(bytes.toString('utf8')));
      const finished = new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const failed = error => { cleanup(); reject(error); };
        function cleanup () { res.removeListener('finish', done); res.removeListener('close', done); res.removeListener('error', failed); }
        res.once('finish', done); res.once('close', done); res.once('error', failed);
      });
      res.writeHead(200, { 'content-type': route.contentType, 'cache-control': 'no-store' }); res.end(bytes);
      await finished;
      };
      // Lifetime is the route's own module policy, never a listener-wide window:
      // lifecycle control must stay callable while application work refuses.
      if (route.lifetime) await route.lifetime.operationWindow.run(await route.lifetime.resolveTenant(body), respond, {onInvalidated: () => res.destroy()});
      else await respond();
    } catch {
      if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"SOCKET_IPC_UNAVAILABLE"}'); }
      else res.destroy();
    } finally { clearTimeout(timer); }
  }, { routes: Object.freeze([...table.keys()]) });
}
// Compose several service modules on one private listener. Each module is
// {service, create: token => operations, lifetime?: {operationWindow, resolveTenant}}.
// `shutdownTimeoutMs` bounds close(): the listener stops accepting at once,
// lets dispatched calls finish and send their responses for at most that long,
// then force-closes what remains (the caller sees an uncertain outcome).
async function compose (input, modules, { shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = {}) {
  const opts = options(input);
  if (!Array.isArray(modules) || !modules.length || modules.some(module => !c.object(module) || typeof module.create !== 'function' ||
      !Object.keys(module).every(key => ['service', 'create', 'lifetime', 'bounds'].includes(key)))) throw new TypeError('Private transport requires a trusted operation factory');
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 2147483647) throw new TypeError('Private transport shutdown deadline must be a bounded integer');
  if (opts.socketPath) {
    directory(opts.socketPath);
    try { fs.lstatSync(opts.socketPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Linux reference: libuv owns only this unadvertised internal pathname.
  // Atomic hard-link publication never replaces an existing configured path.
  const internalPath = opts.socketPath ? path.join(path.dirname(opts.socketPath), '.ns-' + randomBytes(8).toString('hex') + '.sock') : null;
  if (internalPath) {
    options({ ...opts, socketPath: internalPath });
    try { fs.lstatSync(internalPath); c.fail('SOCKET_IPC_PATH_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // One owned token per module: a handler cannot accept another module's context.
  const owned = modules.map(module => { const token = Symbol('owned-private-socket'); return { service: module.service, token, operations: module.create(token),
    ...(module.lifetime !== undefined ? { lifetime: module.lifetime } : {}), ...(module.bounds !== undefined ? { bounds: module.bounds } : {}) }; });
  let closed = false, own, internalOwn, closing; const sockets = new Set(), jobs = new Set(), active = new Map();
  const serve = handler({ maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, modules: owned,
    admitted: req => !closed && sockets.has(req.socket), completing: req => sockets.has(req.socket) && !req.socket.destroyed });
  const routes = serve.routes;
  const server = http.createServer({ headersTimeout: opts.timeoutMs, requestTimeout: opts.timeoutMs }, (req, res) => {
    const job = serve(req, res); jobs.add(job); active.set(req.socket, (active.get(req.socket) || 0) + 1);
    const settle = () => {
      jobs.delete(job);
      const left = (active.get(req.socket) || 1) - 1;
      if (left) active.set(req.socket, left); else active.delete(req.socket);
      // While closing, a connection with no call left is not kept for reuse.
      if (closed && !left) req.socket.end();
    };
    job.then(settle, settle);
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  function close () {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
    // Stop accepting; drop connections that carry no dispatched call.
    const stopped = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
    for (const socket of sockets) if (!active.has(socket)) socket.destroy();
    // In-flight calls finish and answer until the deadline, then are force-closed.
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(resolve, shutdownTimeoutMs); });
    await Promise.race([Promise.allSettled([...jobs]), deadline]);
    clearTimeout(timer);
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
      return Object.freeze({ close, routes });
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
    return Object.freeze({ close, routes });
  } catch (error) { await close(); throw error; }
}
// Single-service listener (current role wiring): a one-module composition.
function open (input, service, makeOperations, lifetime = {}, settings) {
  if (typeof makeOperations !== 'function') return Promise.reject(new TypeError('Private transport requires a trusted operation factory'));
  return compose(input, [{ service, create: makeOperations, ...(lifetime && (lifetime.operationWindow || lifetime.resolveTenant) ? { lifetime } : {}) }], settings);
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
    const limit = bounds(operation, opts);
    const bytes = Buffer.from(JSON.stringify(body)); if (bytes.length > limit.maxBytes) c.fail('SOCKET_IPC_REQUEST_REFUSED');
    validate(operation.request, JSON.parse(bytes.toString('utf8')));
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('SOCKET_IPC_UNAVAILABLE'));
      const url = opts.url ? new URL(opts.url) : null;
      const endpoint = url ? { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 80) } : { socketPath: opts.socketPath };
      const req = request({ ...endpoint, path: operation.path, method: operation.method, signal, agent: false,
        headers: { 'content-type': operation.contentType, 'content-length': bytes.length,
          'x-nightscout-internal-service': service.id, 'x-nightscout-internal-version': String(service.version) } }, res => {
        let length = 0; const chunks = [];
        res.on('data', chunk => { length += chunk.length; if (length > limit.maxBytes) { res.destroy(); fail(); } else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200 || mediaType(res.headers['content-type']) !== operation.contentType) throw new Error();
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!c.object(value)) throw new Error();
            validate(operation.response, value); resolve(value);
          } catch { fail(); }
        });
      });
      const deadline = setTimeout(() => req.destroy(), limit.timeoutMs);
      req.once('close', () => clearTimeout(deadline));
      req.setTimeout(limit.timeoutMs, () => req.destroy()); req.on('error', fail); req.end(bytes);
    });
  };
  return Object.freeze(methods);
}
module.exports = { options, directory, handler, open, compose, client, DEFAULT_SHUTDOWN_TIMEOUT_MS };
