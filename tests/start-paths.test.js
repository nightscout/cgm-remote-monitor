'use strict';

// covers: bin/nightscout.js, lib/cli/index.js, lib/cli/commands/single.js, lib/cli/commands/healthcheck.js, lib/cli/commands/diagnose.js, lib/server/server.js, server.js, Procfile, start.sh, web.config, Dockerfile, package.json

// D21: `nightscout single` is the server every existing start path starts.
// Each path is booted as its own process against the test database, asked
// the same questions, and the answers compared; then `nightscout healthcheck`
// is asked about it while it runs and after it stops.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const BIN = path.join(root, 'bin/nightscout.js');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const procfileWeb = read('Procfile').match(/^web:\s*(.+)$/m)[1].trim();

// Each start path, as the command its host runs.
const PATHS = {
  'nightscout single': [process.execPath, [BIN, 'single']]
  , 'node lib/server/server.js': [process.execPath, ['lib/server/server.js']]
  , 'node server.js': [process.execPath, ['server.js']]
  , 'npm start': [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start', '--silent']]
  , 'Procfile web': ['/bin/sh', ['-c', procfileWeb]]
  // An image run with the old CMD as an explicit command, under the new ENTRYPOINT.
  , 'nightscout node lib/server/server.js': [process.execPath, [BIN, 'node', 'lib/server/server.js']]
};

function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function get (port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers: headers || {} }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function healthcheck (env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, 'healthcheck', '--timeout', '2000'], { cwd: root, env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', status => resolve({ status, out }));
  });
}

function childEnv (port, secret) {
  const env = Object.assign({}, process.env, {
    PORT: String(port)
    , NIGHTSCOUT_HOSTNAME: '127.0.0.1'
    , INSECURE_USE_HTTP: 'true'
    , API_SECRET: secret
    , AUTH_DEFAULT_ROLES: 'denied'
  });
  for (const key of Object.keys(env)) if (/^npm_/i.test(key)) delete env[key];
  return env;
}

async function start (name, port, secret) {
  const [cmd, args] = PATHS[name];
  const env = childEnv(port, secret);
  // Its own process group, so a wrapper (npm, sh) and its server stop together.
  const child = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 45000;
  let state = 'starting';
  exited.then(() => { state = 'exited'; });
  while (state === 'starting') {
    if (Date.now() > deadline) break;
    try {
      const res = await get(port, '/api/versions');
      if (res.status === 200) { state = 'up'; break; }
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return { child, env, exited, up: state === 'up', log: () => log };
}

async function stop (run) {
  try { process.kill(-run.child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const timer = setTimeout(() => { try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 10000);
  await run.exited;
  clearTimeout(timer);
}

// What a client sees. Times and per-boot values are left out.
async function observe (port, secret) {
  const auth = { 'api-secret': crypto.createHash('sha1').update(secret).digest('hex') };
  const versions = await get(port, '/api/versions');
  const status = await get(port, '/api/v1/status.json', auth);
  const anonymous = await get(port, '/api/v1/status.json');
  const entries = await get(port, '/api/v1/entries.json?count=1', auth);
  const home = await get(port, '/');
  const statusBody = JSON.parse(status.body);
  for (const key of ['serverTime', 'serverTimeEpoch', 'runtimeState', 'boot']) delete statusBody[key];
  return {
    versions: { status: versions.status, body: JSON.parse(versions.body) }
    , status: { status: status.status, body: statusBody }
    , anonymousStatus: anonymous.status
    , entries: { status: entries.status, type: entries.type }
    , home: { status: home.status, type: home.type }
  };
}

describe('start paths boot the same server (D21)', function () {
  this.timeout(600000);
  const secret = crypto.randomBytes(18).toString('hex');
  const seen = {};

  it('every legacy host config still names lib/server/server.js', function () {
    assert.equal(procfileWeb, 'node lib/server/server.js');
    assert.equal(require('../package.json').scripts.start, 'node lib/server/server.js');
    assert.equal(require('../package.json').main, 'lib/server/server.js');
    assert.match(read('server.js'), /^require\('\.\/lib\/server\/server'\);$/m);
    assert.match(read('start.sh'), /^node lib\/server\/server\.js$/m);
    assert.match(read('web.config'), /<add name="iisnode" path="lib\/server\/server\.js"/);
    assert.match(read('web.config'), /<action type="Rewrite" url="lib\/server\/server\.js"\/>/);
    assert.match(read('lib/cli/commands/single.js'), /require\('\.\.\/\.\.\/server\/server'\)/);
  });

  it('the image enters through the dispatcher, runs `single`, and checks its health with it', function () {
    const dockerfile = read('Dockerfile');
    assert.match(dockerfile, /^ENTRYPOINT \["node", "\/opt\/app\/bin\/nightscout\.js"\]$/m);
    assert.match(dockerfile, /^CMD \["single"\]$/m);
    assert.match(dockerfile, /^HEALTHCHECK .*CMD \["node", "\/opt\/app\/bin\/nightscout\.js", "healthcheck"\]$/m);
  });

  for (const name of Object.keys(PATHS)) {
    it('boots through `' + name + '`, and healthcheck is green while it runs and red once it stops', async function () {
      const port = await freePort();
      const env = childEnv(port, secret);
      const before = await healthcheck(env);
      assert.notEqual(before.status, 0, 'healthcheck green before the server started: ' + before.out);

      const run = await start(name, port, secret);
      try {
        assert.ok(run.up, name + ' did not answer /api/versions:\n' + run.log().slice(-4000));
        seen[name] = await observe(port, secret);
        const during = await healthcheck(env);
        assert.equal(during.status, 0, 'healthcheck red against a running server: ' + during.out);
      } finally {
        await stop(run);
      }
      const after = await healthcheck(env);
      assert.equal(after.status, 1, 'healthcheck green after the server stopped: ' + after.out);
    });
  }

  it('every start path answers as `nightscout single` does', function () {
    const reference = seen['nightscout single'];
    assert.ok(reference, '`nightscout single` did not boot');
    assert.equal(reference.versions.status, 200);
    assert.equal(reference.status.status, 200);
    assert.equal(reference.status.body.version, require('../package.json').version);
    assert.equal(reference.anonymousStatus, 401);
    assert.equal(reference.entries.status, 200);
    assert.equal(reference.home.status, 200);
    for (const name of Object.keys(PATHS)) {
      assert.ok(seen[name], name + ' did not boot');
      assert.deepEqual(seen[name], reference, name + ' differs from `nightscout single`');
    }
  });

  it('`nightscout diagnose data` finds the database the way the server does', function (done) {
    const uri = require('../lib/server/env')().storageURI;
    const env = Object.assign({}, process.env);
    for (const key of Object.keys(env)) if (/mongo|storage_uri/i.test(key)) delete env[key];
    env.MONGO_CONNECTION = uri;
    const child = spawn(process.execPath, [BIN, 'diagnose', 'data', '--limit', '1'], { cwd: root, env });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', status => {
      try {
        assert.equal(status, 0, err);
        const report = JSON.parse(out);
        assert.deepEqual(Object.keys(report).sort(), ['devicestatus', 'entries', 'food', 'profile', 'settings', 'treatments']);
        done();
      } catch (e) { done(e); }
    });
  });
});
