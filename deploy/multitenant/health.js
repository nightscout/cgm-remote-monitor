'use strict';

// No database credential or query. API/realtime listeners open only after their
// actual role boot/readiness; private IPC must have been published as well.
const fs = require('node:fs');
const net = require('node:net');
const role = process.argv[2];
const roles = {api: {port: 1337, socket: '/run/ns-ipc/api.sock'}, realtime: {port: 1339, socket: '/run/ns-ipc/alarm.sock'}};
if (role === 'ui') {
  fetch('http://127.0.0.1:1340/healthz', {signal: AbortSignal.timeout(1500)})
    .then(async response => { if (!response.ok || await response.text() !== 'ok\n') process.exitCode = 1; })
    .catch(() => { process.exitCode = 1; });
} else if (Object.hasOwn(roles, role)) {
  const spec = roles[role];
  try { if (!fs.lstatSync(spec.socket).isSocket()) process.exit(1); } catch { process.exit(1); }
  const socket = net.connect({host: '127.0.0.1', port: spec.port});
  socket.setTimeout(1500);
  socket.once('connect', () => socket.end());
  socket.once('timeout', () => { socket.destroy(); process.exitCode = 1; });
  socket.once('error', () => { process.exitCode = 1; });
} else process.exitCode = 64;
