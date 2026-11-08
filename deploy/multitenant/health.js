'use strict';

// No database credential or query. API/realtime listeners open only after their
// actual role boot/readiness; private IPC must have been published as well.
const fs = require('node:fs');
const net = require('node:net');
const role = process.argv[2];
const roles = {api: {port: 1337, socket: '/run/ns-ipc/api.sock'}, realtime: {port: 1339, socket: '/run/ns-ipc/alarm.sock'}, evaluator: {}, 'tenant-admin': {port: 1341}};
async function main () {
  if (role === 'ui') {
    const response = await fetch('http://127.0.0.1:1340/healthz', {signal: AbortSignal.timeout(1500)});
    if (!response.ok || await response.text() !== 'ok\n') throw new Error();
    return;
  }
  if (!Object.hasOwn(roles, role)) throw new Error();
  const spec = roles[role];
  if (spec.socket && !fs.lstatSync(spec.socket).isSocket()) throw new Error();
  if (spec.port) await new Promise((resolve, reject) => {
    const socket = net.connect({host: '127.0.0.1', port: spec.port});
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.end(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error()); });
    socket.once('error', reject);
  });
  const request = require('node:crypto').randomUUID();
  const reply = await require('../../lib/server/realtime/ipc').client({socketPath: '/run/ns-ipc/cohort-' + role + '.sock', maxBytes: 1048576, timeoutMs: 1500})('/cohort/status', {request});
  if (reply.request !== request || reply.participant !== role || JSON.stringify(reply.roles) !== JSON.stringify([role])) throw new Error();
}
main().catch(() => { process.exitCode = 1; });
