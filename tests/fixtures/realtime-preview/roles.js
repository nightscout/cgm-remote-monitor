'use strict';
// Actual separate CLI processes. Root provisions schemas, roles, secrets and
// configuration; this fixture owns only the processes it starts and ingress.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
// Trusted fixture transport only. New parent JSON stores references, never
// credentials; hydration reads only the explicit invocation environment.
function roleEnvironment (document, inputEnvironment) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const name = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
  assert(object(document), 'ROLE_ENV_DOCUMENT_INVALID');
  if (!Object.hasOwn(document, 'version')) {
    // Existing fixture documents remain compatible; the new parent always uses
    // version1 and never persists credential values in this legacy format.
    assert(Object.entries(document).every(([key, value]) => name(key) && typeof value === 'string'), 'ROLE_ENV_LEGACY_INVALID');
    return { ...document };
  }
  assert(document.version === 1 && Object.keys(document).length === 3 &&
    object(document.values) && object(document.references), 'ROLE_ENV_SCHEMA_INVALID');
  assert(Object.entries(document.values).every(([key, value]) => name(key) && typeof value === 'string'), 'ROLE_ENV_VALUES_INVALID');
  const selected = { ...document.values };
  for (const [key, reference] of Object.entries(document.references)) {
    assert(name(key) && name(reference) && !Object.hasOwn(selected, key), 'ROLE_ENV_REFERENCE_COLLISION');
    assert(Object.hasOwn(inputEnvironment, reference) && typeof inputEnvironment[reference] === 'string' && inputEnvironment[reference].length > 0,
      'ROLE_ENV_REFERENCE_MISSING');
    selected[key] = inputEnvironment[reference];
  }
  return selected;
}
async function startRole ({ sourceDir, role, env, timeoutMs, captureDir, onBirth = () => {} }) {
  assert(['api', 'realtime', 'evaluator'].includes(role));
  const child = spawn(process.execPath, [path.join(sourceDir, 'bin/nightscout.js'), 'multitenant', role], {
    cwd: sourceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const secrets = Object.values(env).filter(v => typeof v === 'string' && v.length > 5);
  const scrub = value => secrets.reduce((text, secret) => text.split(secret).join('[private-env]'), value);
  let stdout = '', stderr = '', exited, port, closing;
  onBirth({ kind: role + '-cli', pid: child.pid, sourceDir });
  const ended = new Promise(resolve => child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited); }));
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  child.on('error', error => { stderr += error.code || 'SPAWN_ERROR'; });
  function save () {
    fs.writeFileSync(path.join(captureDir, role + '-stdout.log'), scrub(stdout));
    fs.writeFileSync(path.join(captureDir, role + '-stderr.log'), scrub(stderr));
  }
  async function close () {
    if (closing) return closing;
    closing = (async () => {
      if (!exited) child.kill('SIGTERM');
      const watchdog = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, timeoutMs);
      await ended; clearTimeout(watchdog); save();
      let absent = false; try { process.kill(child.pid, 0); } catch (error) { absent = error.code === 'ESRCH'; }
      fs.writeFileSync(path.join(captureDir, role + '-cleanup.json'), JSON.stringify({ pid: child.pid, ...exited, absent }) + '\n');
      assert(absent && exited.code === 0, 'REALTIME_OWNED_CLI_CLEANUP child must exit naturally and be absent');
    })(); return closing;
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw new Error('REALTIME_CLI_STARTUP_REFUSED');
      // Evaluator is headless. Its boot marker attests startup only; the joined
      // consumer fixture separately requires actual SQL/pipeline progress.
      if (role === 'evaluator') {
        if (/Evaluator preview started; configured tenants: [1-9][0-9]*/.test(stdout)) break;
      } else {
        const found = stdout.match(new RegExp('Listening for role ' + role + ' on 127\\.0\\.0\\.1:([0-9]+)'));
        if (found) { port = Number(found[1]); break; }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(role === 'evaluator' ? /Evaluator preview started; configured tenants: [1-9][0-9]*/.test(stdout) : port > 0,
      'REALTIME_CLI_STARTUP_DEADLINE'); save();
    return Object.freeze({ port: role === 'evaluator' ? null : port, readiness: role === 'evaluator' ? 'headless-started' : 'listener-started', pid: child.pid, close });
  } catch (error) { await close(); throw error; }
}
async function start (input) {
  assert.equal(input.env.NS_RT_JOINED_NATIVE, '1');
  const config = JSON.parse(fs.readFileSync(input.env.NS_RT_JOINED_CONFIG, 'utf8'));
  assert.equal(config.version, 1); assert.equal(config.sourceHead, input.env.NS_RT_SOURCE_HEAD);
  assert.match(config.sourceHead, /^[a-f0-9]{40}$/);
  const owned = JSON.parse(fs.readFileSync(config.ownershipFile, 'utf8'));
  assert.equal(owned.sourceHead, config.sourceHead); assert.equal(owned.phaseId, input.phaseId);
  const children = []; let ingress,transport;
  const diagnostics=require('./transport-diagnostics').create({captureDir:input.captureDir,maxEvents:128,maxBytes:65536});
  async function close () {
    if (transport) transport.close();
    if (ingress) await ingress.close();
    const errors = [];
    for (const child of [...children].reverse()) try { await child.close(); } catch (error) { errors.push(error); }
    assert.equal(errors.length, 0, 'REALTIME_JOINED_CHILD_CLEANUP');
  }
  try {
    const roleEnv = role => {
      const selected = roleEnvironment(JSON.parse(fs.readFileSync(config[role + 'EnvFile'], 'utf8')), input.env);
      const pg = owned.resources.find(row => row.kind === 'postgres');
      assert(pg && pg.host === '127.0.0.1' && pg.port && pg.database, 'root-owned PG endpoint attestation required');
      for (const value of Object.values(selected)) if (typeof value === 'string' && /^postgres(?:ql)?:/.test(value)) {
        const url = new URL(value);
        assert(url.hostname === pg.host && Number(url.port || 5432) === pg.port && decodeURIComponent(url.pathname.slice(1)) === pg.database,
          'native role database must be the handed-in owned endpoint');
      }
      if (role === 'api') {
        const document = JSON.parse(fs.readFileSync(selected.MULTITENANT_PREVIEW_CONFIG, 'utf8'));
        const vault = owned.resources.find(row => row.kind === 'vault'), url = new URL(document.vault.address);
        assert(vault && url.hostname === vault.host && Number(url.port) === vault.port && url.hostname === '127.0.0.1',
          'native API Vault must be the handed-in owned endpoint');
      }
      if (role === 'evaluator') assert(selected.MULTITENANT_EVALUATOR_CONFIG, 'explicit headless evaluator configuration required');
      else {
        assert.equal(selected[role.toUpperCase() + '_HOSTNAME'], '127.0.0.1');
        assert.equal(selected[role.toUpperCase() + '_PORT'], '0');
      }
      if (role === 'realtime') assert(Object.keys(selected).every(key => !/VAULT|SIGN|DECRYPT|ROOT_SECRET/.test(key)), 'RT_HAS_NO_SECRET_AUTHORITY');
      return { PATH: input.env.PATH, HOME: input.env.HOME, NODE_PATH: input.env.NODE_PATH, NODE_ENV: 'test', TZ: 'UTC', ...selected };
    };
    const api = await startRole({ ...input, role: 'api', env: roleEnv('api'), timeoutMs: config.timeoutMs }); children.push(api);
    const realtimeEnvironment = roleEnv('realtime');
    if (input.beforeRealtime !== undefined) {
      assert.equal(typeof input.beforeRealtime, 'function', 'trusted realtime setup hook required');
      const document = JSON.parse(fs.readFileSync(realtimeEnvironment.MULTITENANT_REALTIME_CONFIG, 'utf8'));
      assert(typeof document.apiSocketPathEnv === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(document.apiSocketPathEnv),
        'explicit configured API socket reference required');
      const relay = await input.beforeRealtime({ api, env: Object.freeze({ ...realtimeEnvironment }), config });
      assert(relay && typeof relay === 'object' && Object.keys(relay).length === 2 &&
        typeof relay.close === 'function' && typeof relay.apiSocketPath === 'string', 'owned API authority relay capability required');
      // Keep it in reverse ownership order: RT closes before relay, then API.
      children.push(relay);
      const validated = require('../../../lib/server/realtime/ipc').options({ socketPath: relay.apiSocketPath,
        maxBytes: document.maxMessageBytes, timeoutMs: document.operationTimeoutMs });
      realtimeEnvironment[document.apiSocketPathEnv] = validated.socketPath;
    }
    const realtime = await startRole({ ...input, role: 'realtime', env: realtimeEnvironment, timeoutMs: config.timeoutMs }); children.push(realtime);
    const ui = config.uiFixture ? await require('./ui')({ sourceDir: input.sourceDir, ...config.uiFixture }) : undefined;
    ingress = await require('./ingress')({ ui, redirectFixtureHosts: config.browserResolverHosts, apiPort: api.port, realtimePort: realtime.port, timeoutMs: config.timeoutMs, onBirth: input.onBirth,diagnostics,fixtureHosts:[config.host,config.foreignHost] });
    transport=require('./named-client')({hosts:[config.host,config.foreignHost],port:ingress.port,timeoutMs:config.timeoutMs,record:diagnostics.record});
    return Object.freeze({ api, realtime, ingress, config, owned, close,client:transport.socket,
      async startEvaluator ({ alarmRoutePath } = {}) {
        assert(config.evaluatorEnvFile, 'explicit evaluator role environment required');
        const env = roleEnv('evaluator');
        if (alarmRoutePath) {
          const document = JSON.parse(fs.readFileSync(env.MULTITENANT_EVALUATOR_CONFIG, 'utf8'));
          assert(document.consumers?.realtime?.route?.socketPathEnv, 'actual joined realtime consumer route required');
          env[document.consumers.realtime.route.socketPathEnv] = alarmRoutePath;
        }
        const evaluator = await startRole({ ...input, role: 'evaluator', env, timeoutMs: config.timeoutMs }); children.push(evaluator); return evaluator;
      }
    });
  } catch (error) { await close(); throw error; }
}
module.exports = { startRole, start, roleEnvironment };
