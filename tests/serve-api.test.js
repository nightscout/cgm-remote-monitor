'use strict';

// covers: lib/server/serve/api.js, lib/server/serve/index.js, lib/server/serve/listeners.js, lib/server/bootevent.js, lib/server/app.js, lib/cli/commands/serve.js, lib/cli/commands/healthcheck.js

// PLAT-SERVE (D21): `nightscout serve api` boots bootevent's api profile and
// constructs none of the in-memory data layer. Each factory that `single`
// uses for it is counted while the api profile boots; the same assertion is
// run on a `single` boot as its control and must fail there. Then the role is
// started as a process and stopped with SIGTERM.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const listeners = require('../lib/server/serve/listeners');

const root = path.resolve(__dirname, '..');
const BIN = path.join(root, 'bin/nightscout.js');

// The factories behind what the api role must not construct.
const FACTORIES = {
  bus: 'lib/bus.js'
  , ddata: 'lib/data/ddata.js'
  , dataloader: 'lib/data/dataloader.js'
  , cache: 'lib/server/cache.js'
  , websocket: 'lib/server/websocket.js'
  , plugins: 'lib/plugins/index.js'
  , notifications: 'lib/notifications.js'
  , apiV1: 'lib/api/index.js'
  , apiV2: 'lib/api2/index.js'
};

// The process-wide MongoDB client (lib/storage/mongo-storage.js) is shared by
// every boot in this process and is not closed here.

// ctx members `single` builds that the api role leaves out.
const SINGLE_ONLY = ['ddata', 'dataloader', 'cache', 'plugins', 'notifications', 'sbx', 'entries', 'treatments',
  'devicestatus', 'profile', 'food', 'activity', 'pebble', 'properties', 'pushover', 'maker', 'pushnotify', 'loop', 'wares'];

// Replace each factory's export with a counting wrapper for modules that
// require it from now on (bootevent and the role require them lazily).
function countFactories () {
  const counts = {};
  const restore = [];
  for (const [name, file] of Object.entries(FACTORIES)) {
    const resolved = require.resolve(path.join(root, file));
    const original = require(resolved);
    counts[name] = 0;
    const counted = Object.assign(function () { counts[name]++; return original.apply(this, arguments); }, original);
    require.cache[resolved].exports = counted;
    restore.push(() => { require.cache[resolved].exports = original; });
  }
  return { counts, restore: () => restore.forEach(fn => fn()) };
}

function assertApiOnly (ctx, counts) {
  assert.deepEqual(ctx.bootErrors, []);
  for (const [name, count] of Object.entries(counts)) {
    assert.equal(count, 0, 'constructed ' + name + ' ' + count + ' time(s)');
  }
  assert.equal(ctx.bus.local, true, 'ctx.bus is the heartbeat bus');
  assert.equal(ctx.bus.uptime, undefined, 'ctx.bus has a heartbeat');
  for (const key of SINGLE_ONLY) assert.equal(ctx[key], undefined, 'ctx.' + key + ' was built');
  assert.ok(ctx.store && ctx.authorization && ctx.purifier && ctx.levels, 'API v3 needs storage, authorization, the purifier and levels');
}

function bootProfile (profile, env, language) {
  return new Promise(resolve => require('../lib/server/bootevent')(env, language, { profile }).boot(resolve));
}

function get (port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

describe('nightscout serve api (PLAT-SERVE)', function () {
  this.timeout(30000);

  let env;
  let language;
  before(function () {
    // lib/server/env.js takes API_SECRET out of process.env when it reads it,
    // so a file run after another has none; set one, as the API v3 fixture does.
    process.env.API_SECRET = crypto.randomBytes(24).toString('hex');
    env = require('../lib/server/env')();
    language = require('../lib/language')();
  });

  it('boots the api profile with no bus, ddata, data loader, cache, plugins, websocket or v1/v2', async function () {
    const { counts, restore } = countFactories();
    let ctx;
    try {
      ctx = await bootProfile('api', env, language);
      assertApiOnly(ctx, counts);
    } finally {
      restore();
    }
  });

  it('control: the same assertion fails on a `single` boot', async function () {
    const { counts, restore } = countFactories();
    let ctx;
    try {
      ctx = await bootProfile('single', env, language);
      assert.throws(() => assertApiOnly(ctx, counts), /constructed bus 1 time/);
      assert.ok(counts.ddata > 0 && counts.dataloader > 0 && counts.cache > 0 && counts.plugins > 0);
    } finally {
      restore();
      if (ctx) ctx.bus.teardown();
    }
  });

  it('serves API v3 and the authorization endpoints, and nothing else, on its own listener', async function () {
    const { counts, restore } = countFactories();
    const serve = require('../lib/server/serve');
    let running;
    try {
      running = await serve.start(['api'], env, language, { API_HOSTNAME: '127.0.0.1', API_PORT: '0' });
      assertApiOnly(running.contexts.api, counts);
      const { port } = running.servers[0].address();
      const version = await get(port, '/api/v3/version');
      assert.equal(version.status, 200);
      assert.ok(JSON.parse(version.body).result.apiVersion);
      assert.equal((await get(port, '/api/v3/entries')).status, 401);
      assert.equal((await get(port, '/api/v2/authorization/request/no-such-token')).status, 401);
      for (const urlPath of ['/', '/api/v1/entries.json', '/api/v2/properties', '/api/versions', '/socket.io/?EIO=4&transport=polling']) {
        assert.equal((await get(port, urlPath)).status, 404, urlPath);
      }
      assert.equal(counts.websocket, 0);
    } finally {
      restore();
      // Close the listener only: lib/storage/mongo-storage.js keeps one
      // MongoDB client per process, which the other test files reuse. The
      // spawned process below closes it.
      if (running) await Promise.all(running.servers.map(listeners.close));
    }
    assert.equal(running.servers[0].listening, false);
  });

  it('stops on SIGTERM within 5 s with exit code 0, nothing left open', async function () {
    const port = await freePort();
    // lib/server/env.js takes API_SECRET out of process.env once read, so the
    // child gets its own, as tests/start-paths.test.js does.
    const childEnv = Object.assign({}, process.env, {
      API_PORT: String(port), API_HOSTNAME: '127.0.0.1', API_SECRET: crypto.randomBytes(24).toString('hex')
    });
    for (const key of Object.keys(childEnv)) if (/^npm_/i.test(key)) delete childEnv[key];
    const child = spawn(process.execPath, [BIN, 'serve', 'api'], { cwd: root, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      child.stdout.on('data', d => { stdout += d; if (/Listening for role api/.test(stdout)) resolve(); });
      child.on('exit', () => reject(new Error('exited before listening: ' + stderr)));
    });

    const healthcheck = args => new Promise(resolve => {
      const probe = spawn(process.execPath, [BIN, 'healthcheck', '--timeout', '2000'].concat(args), { cwd: root, env: childEnv });
      let said = '';
      probe.stdout.on('data', d => { said += d; });
      probe.stderr.on('data', d => { said += d; });
      probe.on('close', code => { healthcheck.said = said; resolve(code); });
    });
    assert.equal(await healthcheck(['--role', 'api']), 0, healthcheck.said + stderr.slice(-3000));

    const sent = Date.now();
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    const elapsed = Date.now() - sent;
    console.log('      SIGTERM to exit: ' + elapsed + ' ms, code ' + code);
    assert.equal(signal, null, 'killed by ' + signal + '; stderr: ' + stderr);
    assert.equal(code, 0, 'stderr: ' + stderr);
    assert.ok(elapsed < 5000, 'took ' + elapsed + ' ms');
    assert.doesNotMatch(stderr, /still open/);
    assert.match(stdout, /SIGTERM, closing listeners and storage/);
    assert.equal(await healthcheck(['--role', 'api']), 1);
  });
});
