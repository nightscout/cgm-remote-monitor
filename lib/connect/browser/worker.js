'use strict';

// Runs under a separate non-root UID with a minimal environment. No Nightscout
// credentials, Mongo URL or token exchange ever enter this process.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const Protocol = require('./protocol');
const policy = require('./policy');
const egress = require('./proxy');
const ConnectError = require('../errors');

async function open({ url, width, height, onFrame, onRedirect, onError, onBlocked = () => {} }) {
  if (!policy.allowedUrl(url) || !new URL(url).hostname.startsWith('carelink-login.')) throw new ConnectError('invalid_login_url');
  const workspace = process.env.CARELINK_WORK_DIR;
  if (workspace && !/^\/tmp\/nightscout-carelink-[a-f0-9-]{36}$/.test(workspace)) throw new ConnectError('worker_unavailable', 503);
  // The supervisor supplies this validated, freshly generated session path.
  if (workspace) await fs.mkdir(workspace, { mode: 0o700 }); // eslint-disable-line security/detect-non-literal-fs-filename
  const directory = await fs.mkdtemp(workspace ? workspace + '/profile-' : '/tmp/carelink-browser-');
  let proxy, child, cdp, closing = false, page, timer, frameTimer, latestFrame;
  async function close() {
    if (closing) return;
    closing = true; clearTimeout(timer); clearTimeout(frameTimer); latestFrame = null;
    if (cdp && !cdp.closed) await cdp.send('Browser.close').catch(() => {});
    cdp?.close(); proxy?.close();
    if (child && child.pid) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 300));
      child.kill('SIGKILL');
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  try {
    proxy = await egress(onBlocked);
    child = spawn('/usr/bin/xvfb-run', ['-a', '-s', '-screen 0 1280x1100x24 -nolisten tcp',
      '/usr/bin/chromium', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-quic',
      '--disable-extensions', '--disable-features=MediaRouter', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--proxy-server=http://127.0.0.1:' + proxy.port, '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--user-data-dir=' + directory, '--window-size=' + width + ',' + height, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' } });
    child.on('error', () => onError());
    cdp = new Protocol(child);
    cdp.on('closed', () => { if (!closing) onError(); });
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    page = attached.sessionId;
    const send = (method, params) => cdp.send(method, params, page);
    cdp.on('event', m => {
      const p = m.params || {};
      if (m.method === 'Target.targetCreated' && p.targetInfo.type === 'page' && p.targetInfo.targetId !== target.targetId) {
        void cdp.send('Target.closeTarget', { targetId: p.targetInfo.targetId }).catch(() => {});
      }
      if (m.sessionId !== page) return;
      if (m.method === 'Network.requestWillBeSent') onRedirect(p.request.url);
      if (m.method === 'Page.frameRequestedNavigation') onRedirect(p.url);
      if (m.method === 'Network.responseReceived') {
        for (const [key, value] of Object.entries(p.response.headers || {})) if (key.toLowerCase() === 'location') onRedirect(value);
      }
      if (m.method === 'Fetch.requestPaused') {
        onRedirect(p.request.url);
        const allowed = policy.allowedUrl(p.request.url);
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } :
          { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
      if (m.method === 'Page.screencastFrame') {
        if (!closing && p.data.length <= 1500000) {
          latestFrame = p.data;
          if (!frameTimer) frameTimer = setTimeout(() => {
            frameTimer = null;
            if (!closing && latestFrame) onFrame(latestFrame);
            latestFrame = null;
          }, 200);
        }
        void send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      }
    });
    await send('Page.enable'); await send('Network.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    // Do not call an error/blank browser page a ready sign-in screen.
    let loaded;
    const documentLoaded = new Promise(resolve => { loaded = resolve; });
    const loadListener = m => { if (m.sessionId === page && m.method === 'Page.domContentEventFired') loaded(); };
    cdp.on('event', loadListener);
    const navigation = await send('Page.navigate', { url });
    if (navigation.errorText) throw new Error('navigation_failed');
    let loadTimer;
    try {
      await Promise.race([documentLoaded, new Promise((resolve, reject) => { loadTimer = setTimeout(() => reject(new Error('navigation_timeout')), 20000); })]);
    } finally { clearTimeout(loadTimer); cdp.removeListener('event', loadListener); }
    const location = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
    if (!policy.allowedUrl(location.result.value)) throw new Error('navigation_failed');
    await send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: width, maxHeight: height });
    timer = setTimeout(() => { onError(); void close(); }, 10 * 60000);
    timer.unref();
    return { close, async input(value) {
      const event = policy.input(value, width, height);
      if (event.type === 'text') await send('Input.insertText', { text: event.text });
      if (event.type === 'key') {
        const codes = { Tab: 9, Enter: 13, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35 };
        for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: event.key,
          code: event.key, windowsVirtualKeyCode: codes[event.key], modifiers: event.shift ? 8 : 0 });
      }
      if (event.type === 'click') {
        for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent',
          { type, x: event.x, y: event.y, button: 'left', clickCount: 1 });
      }
      if (event.type === 'pointer') await send('Input.dispatchMouseEvent', {
        type: { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[event.phase],
        x: event.x, y: event.y, button: 'left', buttons: event.phase === 'up' ? 0 : 1, clickCount: event.phase === 'move' ? 0 : 1
      });
      if (event.type === 'scroll') await send('Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: event.x, y: event.y, deltaX: 0, deltaY: event.delta });
      const result = await send('Runtime.evaluate', { returnByValue: true,
        expression: '(()=>{const e=document.activeElement;return e?{tag:e.tagName,type:e.type||"",label:(e.getAttribute("aria-label")||Array.from(e.labels||[]).map(l=>l.textContent).join(" ")||e.getAttribute("placeholder")||"").slice(0,200)}:null})()' });
      return result.result.value;
    } };
  } catch (_) { await close(); throw new ConnectError('worker_unavailable', 503); }
}

module.exports = { open };

if (require.main === module) {
  let worker, starting = false, queue = Promise.resolve(), frameBusy = false, queuedFrame;
  const send = message => { if (process.connected) process.send({ carelink: true, ...message }); };
  const flushFrame = () => {
    if (frameBusy || !queuedFrame || !process.connected) return;
    frameBusy = true;
    const frame = queuedFrame; queuedFrame = null;
    process.send({ carelink: true, event: 'frame', frame }, () => { frameBusy = false; flushFrame(); });
  };
  process.on('message', message => {
    if (!message || !message.carelink) return;
    queue = queue.then(async () => {
      try {
        if (message.command === 'start') {
          if (worker || starting) throw new Error('busy');
          starting = true;
          worker = await open({ ...message.options,
            onFrame: frame => {
              queuedFrame = frame; flushFrame();
            },
            onRedirect: url => send({ event: 'redirect', url }), onError: () => send({ event: 'failed' }),
            onBlocked: host => send({ event: 'blocked-host', host }) });
          starting = false;
        } else if (message.command === 'input') {
          if (!worker) throw new Error('closed');
          const focus = await worker.input(message.input);
          send({ request: message.request, result: focus }); return;
        } else if (message.command === 'stop') {
          await worker?.close(); worker = null;
          send({ request: message.request, result: true });
          process.disconnect();
          return;
        } else throw new Error('invalid_command');
        send({ request: message.request, result: true });
      } catch (_) { starting = false; send({ request: message.request, error: 'worker_unavailable' }); }
    });
  });
  const shutdown = async () => { await worker?.close(); process.exit(0); };
  process.on('disconnect', shutdown); process.on('SIGTERM', shutdown);
}
