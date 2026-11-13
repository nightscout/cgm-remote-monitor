'use strict';
// Instrument/source protocol only; no real page, browser, service or network.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), Module = require('node:module');
const diagnostic = require('./fixtures/realtime-preview/browser-diagnostics');
const runtime = { browser: 'chromium', executablePath: '/synthetic/chromium', sha256: '1'.repeat(64), version: '142.0.1.2', dev: 1, ino: 2, mode: 0o755 };
const hosts = ['tenant-a.example.test', 'tenant-b.example.test'], marker = 'SECRET-MARKER-NOT-CAPTURED';
const snapshot = { nightscoutType: 'object', clientType: 'object', documentReadyState: 'complete', main: { present: true, connected: true, engineTransport: 'websocket', engineReadyState: 'open' },
  alarm: { present: true, connected: true, engineTransport: 'polling', engineReadyState: 'open' }, sgvCount: 1, hasExpectedSynthetic123: true, urgentUi: false, eventNames: [] };
describe('bounded browser stage diagnostics fixture', function () {
  it('writes launched runtime immediately, sanitizes all event/snapshot surfaces, and bounds event collection', async function () {
    const writes = [], probe = diagnostic.create({ write: text => writes.push(text), hosts, runtime, expectedMgdl: 123 });
    assert.equal(JSON.parse(writes[0]).browserRuntime.version, runtime.version); assert.equal(JSON.parse(writes[0]).status, 'launched');
    const page = new EventEmitter(); page.evaluate = async () => ({ ...snapshot, forbidden: marker, main: { ...snapshot.main, uri: marker }, eventNames: ['urgent_alarm', marker] });
    const detach = probe.attach(page), secretUrl = 'http://' + hosts[0] + '/socket.io/?EIO=3&transport=polling&token=' + marker;
    page.emit('console', { type: () => 'error', text: () => marker });
    page.emit('pageerror', Object.assign(new Error(marker), { name: 'TypeError' }));
    page.emit('requestfailed', { url: () => secretUrl, failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED ' + marker }) });
    for (let i = 0; i < 140; i++) page.emit('response', { url: () => secretUrl, status: () => 200 });
    await probe.wait('initial-client', page, async () => true); detach();
    const captured = JSON.parse(writes.at(-1)); assert.equal(captured.diagnostics.length, 128); assert.equal(captured.droppedDiagnostics, 15);
    assert.equal(captured.stages.at(-1).snapshot.eventNames[0], 'urgent_alarm'); assert(!writes.join('').includes(marker));
    assert.equal(page.listenerCount('response'), 0); assert(Buffer.byteLength(writes.at(-1)) <= 65536);
    assert.deepEqual(diagnostic.network(secretUrl, hosts), { knownHost: true, route: 'socket.io', eio: 3, transport: 'polling' });
    assert.equal(diagnostic.network('http://foreign.example/secret-' + marker, hosts).knownHost, false);
    assert.equal(diagnostic.errorInfo({ name: marker, message: 'net::ERR_NAME_NOT_RESOLVED ' + marker }).networkCode, 'ERR_NAME_NOT_RESOLVED');
    assert(!JSON.stringify(diagnostic.errorInfo({ name: marker, message: marker })).includes(marker));
  });
  it('bounds a never-resolving renderer snapshot and preserves original wait error and late rejection handling', async function () {
    const writes = [], probe = diagnostic.create({ write: text => writes.push(text), hosts, runtime, expectedMgdl: 123 });
    assert(diagnostic.SNAPSHOT_TIMEOUT_MS > 0 && diagnostic.SNAPSHOT_TIMEOUT_MS <= 1000);
    const rejectPending = [], page = { evaluate: () => new Promise((resolve, reject) => { rejectPending.push(reject); }) };
    const original = Object.assign(new Error(marker), { name: 'TimeoutError' }); let actionEntered = false, timer;
    const run = probe.wait('initial-client', page, async () => { actionEntered = true; throw original; }).then(() => ({ success: true }), error => ({ error }));
    const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve({ expired: true }), diagnostic.SNAPSHOT_TIMEOUT_MS * 2 + 1000); });
    let result;
    try { result = await Promise.race([run, watchdog]); } finally { clearTimeout(timer); }
    assert.equal(result.expired, undefined, 'BROWSER_SNAPSHOT_OPERATION_BOUNDED');
    assert.equal(result.error, original, 'BROWSER_ORIGINAL_WAIT_ERROR_IDENTITY'); assert(actionEntered);
    const raw = JSON.parse(writes.at(-1)); assert.equal(raw.status, 'error');
    assert.equal(raw.stages.length, 2); assert(raw.stages.every(row => row.snapshotUnavailable === 'timeout'));
    assert.equal(raw.stages.at(-1).error.name, 'TimeoutError'); assert(!writes.join('').includes(marker));
    for (const reject of rejectPending) reject(new Error(marker));
    await new Promise(resolve => setImmediate(resolve)); // Rejections remain handled after race completion.
    assert.equal(JSON.parse(writes.at(-1)).stages.at(-1).snapshotUnavailable, 'timeout');
  });
  for (const [index, stage] of ['initial-client', 'empty-sgvs', 'urgent-event', 'urgent-ui', 'success'].entries()) it('actual driver persists '+stage+' disposition and safe snapshot before teardown', async function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-browser-diag-')); fs.chmodSync(directory, 0o700);
    const origin = 'http://' + hosts[0] + ':12345', config = { browserResolverHosts: hosts, browserRuntime: runtime, syntheticMgdl: 123,
      uiFixture: true, browserHost: hosts[0], browserCredentialEnv: 'TOKEN', timeoutMs: 5000,
      entriesNamespace: 'synthetic_entries', tenant: '11111111-1111-4111-8111-111111111111', alarmSocketPath: '/synthetic/alarm', maxMessageBytes: 10000 };
    const configPath = path.join(directory, 'config.json'); fs.writeFileSync(configPath, JSON.stringify(config));
    const failure = Object.assign(new Error('page.waitForFunction token=' + marker), { name: 'TimeoutError' });
    let waits = 0, closed = false, detached = false;
    const page = new EventEmitter(); page.goto = async () => true;
    const main = { connected: true, io: { uri: origin, engine: { transport: { name: 'websocket' }, readyState: 'open' } } };
    const alarm = { ...main, on: () => {} };
    const windowFixture = { Nightscout: { client: { socket: main, alarmSocket: alarm, ddata: { sgvs: [{ mgdl: 123 }] } } } };
    const documentFixture = { readyState: 'complete', querySelector: () => null };
    page.waitForFunction = async (fn, arg, options) => { assert.equal(options.timeout, 5000); if (index < 4 && waits++ === index) throw failure; return true; };
    page.evaluate = async (fn, arg) => {
      const priorWindow = global.window, priorDocument = global.document;
      try { global.window = windowFixture; global.document = documentFixture; return fn(arg); }
      finally { if (priorWindow === undefined) delete global.window; else global.window = priorWindow;
        if (priorDocument === undefined) delete global.document; else global.document = priorDocument; }
    };
    const off = page.off; page.off = function (...args) { detached = true; return off.apply(this, args); };
    const hooks = { validateFixtureHosts: value => assert.deepEqual(value, hosts), launchNamedFixtureBrowser: async () => {}, getFixtureRuntime: () => runtime,
      mochaHooks: { afterAll: async () => { closed = true; } } };
    const roles = { config, owned: { entriesNamespace: config.entriesNamespace, tenant: config.tenant }, ingress: { port: 12345, redirectRefusals: [] }, close: async () => {
      const raw = JSON.parse(fs.readFileSync(path.join(directory, 'actual-browser-diagnostics.json')));
      if (stage === 'success') { assert.equal(raw.status, 'complete'); assert.equal(raw.stages.at(-1).stage, 'urgent-ui'); }
      else { assert.equal(raw.stages.at(-1).stage, stage); assert.equal(raw.stages.at(-1).edge, 'error', 'BROWSER_STAGE_FAILURE_PERSISTED');
        assert.equal(raw.stages.at(-1).error.name, 'TimeoutError'); assert(raw.stages.at(-1).snapshot, 'BROWSER_FAILURE_SNAPSHOT_PERSISTED'); }
    } };
    const oldLoad = Module._load;
    Module._load = function (name, ...args) {
      if (name === '../../browser/hooks') return hooks;
      if (name === '../../browser/fixture') return { withPage: async (url, fn) => {
        assert.equal(url, origin);
        page.emit('console', { type: () => 'warning', text: () => marker });
        page.emit('pageerror', Object.assign(new Error(marker), { name: 'TypeError' }));
        return fn({ page });
      } };
      if (name === './roles') return { start: async () => roles };
      if (name === 'pg') return { Client: class { async connect () {} async end () {} async query () { windowFixture.Nightscout.client.ddata.sgvs = []; } } };
      if (name === '../../../lib/server/realtime/alarm-transport') return { createAdapter: () => ({ send: (value, callback) => { documentFixture.querySelector = () => ({}); windowFixture.__rtObservedAlarmEvents.push({ event: 'urgent_alarm', value: value.notification }); callback(null, { accepted: true, receipt: null, clearedRequestIds: [] }); } }) };
      return oldLoad.call(this, name, ...args);
    };
    const driverPath = require.resolve('./fixtures/realtime-preview/browser'); delete require.cache[driverPath];
    try {
      const driver = require(driverPath);
      const run = driver({ captureDir: directory, env: { NS_RT_JOINED_BROWSER: '1', NS_RT_JOINED_CONFIG: configPath, TOKEN: marker } });
      if (stage === 'success') await run; else await assert.rejects(run, error => error === failure);
      const text = fs.readFileSync(path.join(directory, 'actual-browser-diagnostics.json'), 'utf8'), raw = JSON.parse(text);
      assert.equal(raw.stages.filter(row => row.edge === 'after' && row.stage !== 'navigation').length, index);
      if (stage !== 'success') { assert.equal(raw.stages.at(-1).stage, stage); assert.equal(raw.stages.at(-1).edge, 'error'); }
      assert(!text.includes(marker)); assert(!text.includes('token=')); assert(closed && detached);
      assert.equal(fs.existsSync(path.join(directory, 'actual-browser-consumer.json')), stage === 'success', 'only successful waits may produce success raw');
      if (stage === 'success') { const result = JSON.parse(fs.readFileSync(path.join(directory, 'actual-browser-consumer.json'))); assert.equal(result.result.urgentUi, true); assert.deepEqual(result.result.sgvs, []); }
    } finally { Module._load = oldLoad; delete require.cache[driverPath]; fs.rmSync(directory, { recursive: true }); }
  });
});
