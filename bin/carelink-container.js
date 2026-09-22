'use strict';

// Container-only supervisor. The app and disposable login worker have distinct
// UIDs and private inherited IPC; there is no debugger/broker network listener.
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const normal = args.length === 2 && ((args[0] === 'node' && ['server.js', 'lib/server/server.js'].includes(args[1])) ||
  (args[0] === 'npm' && args[1] === 'start'));
const root = process.getuid && process.getuid() === 0;
const appOptions = { stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  ...(root ? { uid: 1000, gid: 1000 } : {}) };
if (!normal) {
  const child = spawn(args[0], args.slice(1), { ...appOptions, stdio: 'inherit' });
  child.on('exit', code => process.exit(code || 0));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
} else {
  const app = fork(path.join(__dirname, '../lib/server/server.js'), [], {
    ...appOptions, env: { ...process.env, NIGHTSCOUT_BROWSER_BROKER: root ? '1' : '0' }
  });
  // The supervisor never needs application credentials after spawning the app.
  for (const key of Object.keys(process.env)) delete process.env[key];
  let worker, browserGroup, stopping = false, framePending = false, shutdown = false, stopRequest, queuedFrame, workspace, cleanupFailed = false;
  const killBrowser = () => {
    if (browserGroup) { try { process.kill(-browserGroup, 'SIGKILL'); } catch (_) { /* exited */ } }
    browserGroup = null;
  };
  const reply = message => { if (app.connected) app.send({ carelink: true, ...message }); };
  const flushFrame = () => {
    if (framePending || !queuedFrame || !app.connected) return;
    framePending = true;
    const frame = queuedFrame; queuedFrame = null;
    app.send(frame, () => { framePending = false; flushFrame(); });
  };
  const cleanup = directory => new Promise(resolve => {
    if (!directory) return resolve(true);
    // A fixed cleanup program, run as the browser UID. No path or executable
    // supplied by the browser is trusted by the privileged supervisor.
    const child = spawn(process.execPath, ['-e',
      "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:5,retryDelay:100})", directory],
    { uid: 1001, gid: 1001, cwd: '/tmp', env: {}, stdio: 'ignore' });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', () => { clearTimeout(timeout); resolve(false); });
    child.on('exit', code => { clearTimeout(timeout); resolve(code === 0); });
  });
  app.on('message', m => {
    if (!m || !m.carelink || !root || !Number.isSafeInteger(m.request)) return;
    if (!['start', 'input', 'stop'].includes(m.command) || JSON.stringify(m).length > 20000) return;
    if (m.command === 'start' && cleanupFailed) return reply({ request: m.request, error: 'worker_unavailable' });
    if (m.command === 'start' && !worker) {
      stopping = false;
      workspace = '/tmp/nightscout-carelink-' + crypto.randomUUID();
      worker = fork('/opt/carelink/browser/worker.js', [], {
        uid: 1001, gid: 1001, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        cwd: '/tmp',
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', CARELINK_WORK_DIR: workspace }
      });
      // The supervisor chooses the process group itself. Never accept a PID
      // supplied over the less-privileged worker's IPC channel.
      browserGroup = worker.pid;
      worker.on('message', result => {
        if (stopping && result.request === stopRequest) return; // acknowledge after process exit
        if (result.event === 'frame') {
          queuedFrame = result; flushFrame();
        } else reply(result);
      });
      worker.on('error', () => reply({ event: 'failed' }));
      worker.on('exit', async () => {
        killBrowser(); queuedFrame = null;
        if (!stopping) reply({ event: 'failed' });
        cleanupFailed = !await cleanup(workspace);
        workspace = null; worker = null;
        if (stopping) reply({ request: stopRequest, result: !cleanupFailed, error: cleanupFailed ? 'worker_unavailable' : undefined });
        if (cleanupFailed) console.error('CareLink browser cleanup failed; restart this container before another login.');
      });
    }
    if (!worker) return reply({ request: m.request, result: m.command === 'stop', error: m.command === 'stop' ? undefined : 'worker_unavailable' });
    if (m.command === 'stop') { stopping = true; stopRequest = m.request; }
    if (worker.connected) worker.send(m);
  });
  const stop = signal => {
    if (shutdown) return;
    shutdown = true;
    app.kill(signal); worker?.kill('SIGTERM');
    setTimeout(() => { killBrowser(); worker?.kill('SIGKILL'); app.kill('SIGKILL'); process.exit(0); }, 5000).unref();
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal));
  app.on('exit', async code => {
    killBrowser(); worker?.kill('SIGKILL');
    await cleanup(workspace);
    process.exit(code || 0);
  });
}
