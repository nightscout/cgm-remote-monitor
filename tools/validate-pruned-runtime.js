'use strict';

// Run after install/build/prune. Uses only native APIs and runtime dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {MongoClient} = require('mongodb');
const root = path.resolve(__dirname, '..');

async function main() {
  assert.equal(process.env.NODE_ENV, 'production');
  for (const name of ['webpack', '@babel/core', 'babel-loader', 'mocha', 'socket.io-client']) {
    assert.equal(fs.existsSync(path.join(root, 'node_modules', name)), false, name + ' must be pruned');
  }
  const key = fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/randomString'));
  assert.ok(key.length > 20);
  const mongo = new URL(process.env.CUSTOMCONNSTR_mongo);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(mongo.hostname), 'Only loopback MongoDB is allowed');
  const database = 'nightscout_pruned_test_' + randomUUID().replace(/-/g, '');
  mongo.pathname = '/' + database;
  const client = new MongoClient(mongo.href);
  let child, exit;
  let output = '', imports = 0;
  const config = http.createServer((req, res) => {
    imports++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({settings: {units: 'mmol', customTitle: 'Pruned runtime fixture'}}));
  });
  try {
    await client.connect();
    await require('./validate-mongo-scram')(client, mongo, database);
    config.listen(0, '127.0.0.1');
    await once(config, 'listening');
    const reservation = http.createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, {NODE_ENV: 'production', INSECURE_USE_HTTP: 'true', HOSTNAME: '127.0.0.1', PORT: String(port),
      CUSTOMCONNSTR_mongo: mongo.href, API_SECRET: 'pruned-fixture-secret', AUTH_DEFAULT_ROLES: 'readable',
      IMPORT_CONFIG: 'http://127.0.0.1:' + config.address().port + '/config', MONGO_POOL_SIZE: '5'});
    // Exercise the public npm start script, not a separately constructed app.
    child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], {cwd: root, env,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']});
    exit = once(child, 'exit');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {output = (output + chunk).slice(-12000);});
    const origin = 'http://127.0.0.1:' + port;
    let status;
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(child.exitCode, null, output);
      try {
        const response = await fetch(origin + '/api/v1/status.json', {signal: AbortSignal.timeout(1000)});
        if (response.ok) {
          status = await response.json();
          if (status.runtimeState === 'loaded') break;
        }
      } catch (_) { /* Startup is asynchronous; bounded polling below. */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(status && status.runtimeState, 'loaded', output);
    assert.equal(status.settings.units, 'mmol');
    assert.ok(imports > 0, 'Configuration was not imported');
    for (const page of ['/', '/admin/', '/profile', '/food', '/report/', '/clock/clock-digital']) {
      const response = await fetch(origin + page);
      assert.equal(response.status, 200, page);
      assert.match(await response.text(), /<!DOCTYPE html>/i);
    }
    for (const entry of ['app', 'admin', 'profile', 'food', 'reports', 'clock']) {
      const file = 'js/bundle.' + entry + '.js';
      const response = await fetch(origin + '/bundle/' + file);
      assert.equal(response.status, 200, file);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/public', file)));
    }
    const socketClient = await fetch(origin + '/socket.io/socket.io.js');
    assert.equal(socketClient.status, 200);
    assert.deepEqual(Buffer.from(await socketClient.arrayBuffer()),
      fs.readFileSync(path.join(root, 'node_modules/socket.io/client-dist/socket.io.js')));
    for (const asset of ['/js/client.js', '/css/drawer.css', '/sw.js']) {
      const response = await fetch(origin + asset);
      assert.equal(response.status, 200, asset);
      assert.ok((await response.text()).length > 20, asset);
    }
    assert.deepEqual(fs.readFileSync(path.join(root, 'node_modules/.cache/_ns_cache/randomString')), key);
    console.log('Pruned runtime: loaded DB, imported config, six pages/bundles and static/Socket.IO assets pass.');
  } finally {
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
      const timer = setTimeout(() => {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else { try {process.kill(-child.pid, 'SIGKILL');} catch (_) {} }
      }, 3000);
      await exit;
      clearTimeout(timer);
    }
    config.closeAllConnections();
    await new Promise(resolve => config.close(resolve));
    await client.db(database).dropDatabase();
    await client.close();
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
