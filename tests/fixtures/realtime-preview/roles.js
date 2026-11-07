'use strict';
// Actual separate CLI processes. Root provisions schemas, roles, secrets and
// configuration; this fixture owns only the processes it starts and ingress.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
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
  const children = []; let ingress;
  async function close () {
    if (ingress) await ingress.close();
    const errors = [];
    for (const child of [...children].reverse()) try { await child.close(); } catch (error) { errors.push(error); }
    assert.equal(errors.length, 0, 'REALTIME_JOINED_CHILD_CLEANUP');
  }
  try {
    const roleEnv = role => {
      const selected = JSON.parse(fs.readFileSync(config[role + 'EnvFile'], 'utf8'));
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
    const realtime = await startRole({ ...input, role: 'realtime', env: roleEnv('realtime'), timeoutMs: config.timeoutMs }); children.push(realtime);
    const ui = config.uiFixture ? await require('./ui')({ sourceDir: input.sourceDir, ...config.uiFixture }) : undefined;
    ingress = await require('./ingress')({ ui, apiPort: api.port, realtimePort: realtime.port, timeoutMs: config.timeoutMs, onBirth: input.onBirth });
    return Object.freeze({ api, realtime, ingress, config, owned, close,
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
module.exports = { startRole, start };
