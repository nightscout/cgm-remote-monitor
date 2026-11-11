'use strict';

// serve.internal stale-socket reclaim (decision pool-member-hygiene): a socket
// left by a process killed with SIGKILL is reclaimed on restart in place; a live
// listener, a regular file and a symlink at the path still refuse.
// covers: lib/server/internal-api/transport.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const transport = require('../lib/server/internal-api/transport');
const lifecycle = require('../lib/server/internal-api/contracts').lifecycleParticipant;

// A child that serves the lifecycle contract on the given socket and reports ready.
const CHILD = `
const transport = require(process.env.TRANSPORT);
const contract = require(process.env.CONTRACTS).lifecycleParticipant;
transport.open({ socketPath: process.env.SOCKET, maxBytes: 65536, timeoutMs: 1000 }, contract, () => ({
  getStatus: async () => { throw new Error('unused'); }, invalidateTenant: async () => { throw new Error('unused'); } }))
  .then(() => process.send({ ready: true }), error => process.send({ refused: error.code || error.message }));
`;

describe('serve.internal stale socket reclaim', function () {
  this.timeout(20000);
  let directory, script; const children = [];
  before(function () {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-stale-')); fs.chmodSync(directory, 0o700);
    script = path.join(directory, 'child.js'); fs.writeFileSync(script, CHILD);
  });
  after(function () { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); fs.rmSync(directory, { recursive: true, force: true }); });
  function serve (socket) {
    return new Promise((resolve, reject) => {
      const child = fork(script, [], { env: { PATH: process.env.PATH, SOCKET: socket, TRANSPORT: require.resolve('../lib/server/internal-api/transport'),
        CONTRACTS: require.resolve('../lib/server/internal-api/contracts') }, silent: true });
      children.push(child);
      child.once('message', message => resolve({ child, ...message }));
      child.once('error', reject);
    });
  }
  const operations = () => ({ getStatus: async () => { throw new Error('unused'); }, invalidateTenant: async () => { throw new Error('unused'); } });
  const open = socket => transport.open({ socketPath: socket, maxBytes: 65536, timeoutMs: 1000 }, lifecycle, operations);

  it('a member killed with SIGKILL restarts in place and serves', async function () {
    const socket = path.join(directory, 'killed.sock');
    const first = await serve(socket); assert.equal(first.ready, true);
    const exited = new Promise(resolve => first.child.once('exit', (code, signal) => resolve(signal)));
    first.child.kill('SIGKILL'); assert.equal(await exited, 'SIGKILL');
    assert.ok(fs.lstatSync(socket).isSocket(), 'the killed process left its socket file');
    const second = await serve(socket);
    assert.equal(second.ready, true, 'STALE_SOCKET_RECLAIMED ' + second.refused);
  });
  it('a live listener at the path is still refused and left untouched', async function () {
    const socket = path.join(directory, 'live.sock');
    const live = await serve(socket); assert.equal(live.ready, true);
    const before = fs.lstatSync(socket);
    await assert.rejects(open(socket), { code: 'SOCKET_IPC_PATH_EXISTS' }, 'LIVE_SOCKET_REFUSED');
    const after = fs.lstatSync(socket);
    assert.deepEqual([after.ino, after.isSocket()], [before.ino, true]);
  });
  it('a regular file or a symlink at the path is refused, never followed or removed', async function () {
    const file = path.join(directory, 'file.sock'); fs.writeFileSync(file, 'owned sentinel');
    await assert.rejects(open(file), { code: 'SOCKET_IPC_PATH_EXISTS' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'owned sentinel');
    const link = path.join(directory, 'link.sock'); fs.symlinkSync(path.join(directory, 'killed.sock'), link);
    await assert.rejects(open(link), { code: 'SOCKET_IPC_PATH_EXISTS' });
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  });
});
