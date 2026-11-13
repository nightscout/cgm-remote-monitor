'use strict';

// Nonconsumer evaluator lifecycle fixture: real registry provisioning and
// separate read-only committed settings. Shared realtime labs stay unchanged.
// The original hot-file compatibility case remains separate in its suite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const scope = require('../../lib/storage/tenant-scope');
const createReplay = require('../../lib/storage/postgres-durable-replay');
const base = require('./m5-current-state-proof');
const configParser = require('../../lib/server/serve/evaluator-config');
const provisionedTenants = require('./provisioned-tenants');
const assert = require('node:assert/strict');

module.exports = function evaluatorPreviewRegistryLab () {
  const lab = base(), open = lab.open.bind(lab), reset = lab.reset.bind(lab), close = lab.close.bind(lab);
  const children = new Set(), addedRoles = new Set();
  let directory, connectionString, settingsConnection, provisioned, registryReady = false;
  lab.consumerName = 'evaluator-native-proof';
  lab.previewRole = lab.name + '_evaluator';
  lab.open = async () => {
    await open(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-preview-'));
    const password = crypto.randomBytes(24).toString('hex');
    await lab.admin.query('CREATE ROLE "' + lab.previewRole + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + password + '\'');
    addedRoles.add(lab.previewRole);
    const namespaces = { ...Object.fromEntries(Object.entries(lab.tables).map(([logical, table]) => [logical, table.split('.')[0]])),
      clock: lab.namespaces.clock, checkpoint: lab.replayNamespace };
    for (const namespace of Object.values(namespaces)) {
      await lab.admin.query('GRANT USAGE ON SCHEMA "' + namespace + '" TO "' + lab.previewRole + '"');
      await lab.admin.query('GRANT SELECT ON "' + namespace + '".schema_migrations TO "' + lab.previewRole + '"');
    }
    for (const table of [...Object.values(lab.tables), lab.namespaces.clock + '.tenant_write_clock', lab.replayNamespace + '.tenant_consumer_checkpoint']) {
      await lab.admin.query('GRANT SELECT ON ' + table.split('.').map(n => '"' + n + '"').join('.') + ' TO "' + lab.previewRole + '"');
    }
    for (const domain of Object.keys(lab.tables)) await require('./tenant-insertion-grants').grant(lab.admin, {
      namespace: namespaces[domain], domain, role: lab.previewRole,
      catalogue: require('../../lib/server/serve/postgres-domains').get(domain).catalogue, mode: 'reader' });
    await lab.admin.query('GRANT UPDATE(checkpoint,projection,contract_digest) ON "' + lab.replayNamespace +
      '".tenant_consumer_checkpoint TO "' + lab.previewRole + '"');
    const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = lab.previewRole; url.password = password;
    connectionString = url.toString();
    const owner = lab.name + '_registry_owner', settingsRole = lab.name + '_settings_reader';
    await lab.admin.query('CREATE ROLE "' + owner + '" NOLOGIN NOSUPERUSER NOBYPASSRLS'); addedRoles.add(owner);
    const settingsPassword = crypto.randomBytes(24).toString('hex');
    await lab.admin.query('CREATE ROLE "' + settingsRole + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + settingsPassword + '\''); addedRoles.add(settingsRole);
    const replay = createReplay({ connection: lab.reader, checkpointTable: lab.replayNamespace + '.tenant_consumer_checkpoint',
      clockTable: lab.namespaces.clock + '.tenant_write_clock', domains: lab.tables, consumer: lab.consumerName,
      projectionVersion: 'clinical-current-rows-v1', pageSize: 3, maxRows: 10000 });
    // The inherited lab primes clock rows. Strict provisioning must create its
    // own rows in the registry transaction, never adopt these synthetic rows.
    await lab.admin.query('DELETE FROM "' + lab.namespaces.clock + '".tenant_write_clock');
    provisioned = await provisionedTenants.create({ admin: lab.admin, adminURI: process.env.NS_TEST_POSTGRES_ADMIN_URI, owner,
      namespaces: { clock: lab.namespaces.clock }, checkpoints: [{ namespace: lab.replayNamespace, consumer: lab.consumerName, digest: replay.digest }] });
    const registry = provisioned.namespaces;
    for (const statement of provisioned.registryGrants({ enumerators: [lab.previewRole] })) await lab.admin.query(statement);
    for (const kind of ['settings', 'operatorPolicy']) {
      const ns = registry[kind], table = kind === 'settings' ? 'tenant_settings' : 'tenant_operator_policy';
      await lab.admin.query('GRANT USAGE ON SCHEMA "' + ns + '" TO "' + settingsRole + '"');
      await lab.admin.query('GRANT SELECT ON "' + ns + '".schema_migrations,"' + ns + '"."' + table + '" TO "' + settingsRole + '"');
    }
    const settingsURL = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); settingsURL.username = settingsRole; settingsURL.password = settingsPassword;
    settingsConnection = settingsURL.toString();
    for (const [index, id] of [lab.A, lab.B].entries()) await provisioned.provision({ id, hosts: ['evaluator-' + index + '.example.test'] });
    lab.document = { version: 1, postgres: { connectionEnv: 'NS_EVALUATOR_FIXTURE_CONNECTION', namespaces },
      consumer: lab.consumerName, pageSize: 3, maxRows: 10000, maxBytes: 4 * 1024 * 1024, maxTenants: 2,
      recoveryIntervalMs: 1000000, timeIntervalMs: 1000000,
      registry: { namespace: registry.registry, maxTenants: 2, refreshMs: 250 },
      tenantSettings: { connectionEnv: 'NS_EVALUATOR_FIXTURE_SETTINGS', namespaces: { settings: registry.settings, operatorPolicy: registry.operatorPolicy } } };
    lab.registryNamespaces = registry;
    registryReady = true;
    await lab.reset();
  };
  lab.reset = async () => {
    if (!registryReady) return reset(); // inherited open resets before this extension exists
    await lab.stopChildren();
    for (const domain of lab.domains) await lab.admin.query('TRUNCATE "' + lab.namespaces[domain] + '"."' + domain + '"');
    lab.initial = Date.now() + 100000;
    const clock = await lab.admin.query('UPDATE "' + lab.namespaces.clock + '".tenant_write_clock SET last_stamp=$3,last_delete_stamp=0 WHERE tenant_id IN ($1,$2)', [lab.A, lab.B, lab.initial]);
    assert.equal(clock.rowCount, 2, 'registry fixture must retain both actually provisioned clocks');
    const checkpoints = await lab.admin.query('UPDATE "' + lab.replayNamespace + '".tenant_consumer_checkpoint SET checkpoint=0,projection=NULL WHERE tenant_id IN ($1,$2) AND consumer=$3', [lab.A, lab.B, lab.consumerName]);
    assert.equal(checkpoints.rowCount, 2, 'registry fixture must retain both actually provisioned checkpoints');
    const settings = await lab.admin.query('UPDATE "' + lab.registryNamespaces.settings + '".tenant_settings SET version=version+1,values=$3::jsonb WHERE tenant_id IN ($1,$2)',
      [lab.A, lab.B, JSON.stringify({ enable: ['bgnow', 'delta', 'direction', 'timeago'] })]);
    assert.equal(settings.rowCount, 2, 'registry fixture settings are committed provisioned rows');
  };
  lab.configure = (change = () => {}) => {
    const document = structuredClone(lab.document); change(document);
    const file = path.join(directory, 'config.json'); fs.writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    const parsed = configParser.parse(document, env({ file }));
    return { document, file, async identity (tenant) {
      return (await configParser.withSettings(parsed, configParser.registryEntry(tenant), tenant)).identity;
    } };
  };
  lab.provisionPreview = async () => {
    // Membership and checkpoints were created by strict actual provisioning.
    // A per-test reset resets their mutable data; it never fabricates membership.
    for (const id of [lab.A, lab.B]) {
      assert.equal((await provisioned.provisioning.get(id))?.state, 'active');
      const checkpoint = await lab.previewCheckpoint(id);
      assert(checkpoint, 'actually provisioned evaluator checkpoint must exist');
      assert.equal(Number(checkpoint.checkpoint), 0);
    }
  };
  lab.previewCheckpoint = tenant => lab.checkpoint(lab.consumerName, tenant);
  lab.previewPhysical = async () => ({ A: { ...(await lab.physical(lab.A)), checkpoint: await lab.previewCheckpoint(lab.A) },
    B: { ...(await lab.physical(lab.B)), checkpoint: await lab.previewCheckpoint(lab.B) } });
  lab.encode = value => JSON.parse(JSON.stringify(value, (key, item) => item === undefined ? { probeType: 'undefined' }
    : typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)) ? { probeType: 'number', value: Object.is(item, -0) ? '-0' : String(item) } : item));
  lab.tracePreview = (phase, data) => { const value = lab.encode({ phase, ...data }); console.log('M5_EVALUATOR_OBSERVATION ' + JSON.stringify(value)); return data; };
  function env (config) {
    return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: process.env.NODE_PATH,
      NODE_ENV: 'test', TZ: 'UTC', MULTITENANT_EVALUATOR_CONFIG: config.file, NS_EVALUATOR_FIXTURE_CONNECTION: connectionString,
      NS_EVALUATOR_FIXTURE_SETTINGS: settingsConnection,
      // Results are read right after boot: all-tenants readiness (decision readiness-serve-then-warm).
      NS_TENANT_READINESS: process.env.NS_TENANT_READINESS || 'all' };
  }
  lab.worker = config => new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'evaluator-preview-worker.js'), [], { env: env(config), silent: true });
    const pending = new Map(); child.fixtureBootRefused = false; let sequence = 0, stdout = '', stderr = '', heldResolve;
    children.add(child); child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Evaluator worker startup watchdog')); }, 15000);
    const handle = { child, logs: () => ({ stdout, stderr }), held: () => new Promise(done => { heldResolve = done; }),
      call (action, tenant = lab.A, extra = {}) { return new Promise((done, fail) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); fail(new Error('Evaluator fixture command watchdog')); }, 15000);
        pending.set(id, { done, fail, timer }); child.send({ id, action, tenant, ...extra });
      }); } };
    child.on('message', message => {
      if (message.ready || message.bootError) { child.fixtureBootRefused = !!message.bootError; clearTimeout(timeout); resolve({ ...handle, startup: message }); }
      else if (message.held) { if (heldResolve) heldResolve(); }
      else if (pending.has(message.id)) {
        const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.fail(Object.assign(new Error(message.error.message), { name: message.error.name })); else p.done(message.value);
      }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, signal) => {
      console.log('M5_EVALUATOR_CHILD_EXIT ' + JSON.stringify({ kind: 'worker', pid: child.pid, code, signal, bootRefused: child.fixtureBootRefused }));
      children.delete(child);
      for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error('Evaluator worker exited with pending command')); }
      pending.clear();
    });
  });
  lab.stopWorker = async worker => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    await worker.call('release'); await worker.call('close');
    const stopped = new Promise(resolve => worker.child.once('exit', (code, signal) => resolve({ code, signal })));
    worker.child.send({ id: 0, action: 'exit' }); return stopped;
  };
  lab.cli = config => {
    const child = spawn(process.execPath, [path.join(__dirname, '../../bin/nightscout.js'), 'multitenant', 'evaluator'],
      { env: env(config), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('exit', (code, signal) => { children.delete(child);
      console.log('M5_EVALUATOR_CHILD_EXIT ' + JSON.stringify({ kind: 'cli', pid: child.pid, code, signal })); });
    return { child, logs: () => ({ stdout, stderr }) };
  };
  lab.wait = async check => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Evaluator native condition watchdog');
  };
  lab.stopChildren = async () => {
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      let forced = false;
      const stopped = new Promise(resolve => {
        const t = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
        child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
      });
      child.kill('SIGTERM'); const result = await stopped;
      if (!forced && result.code !== 0 && !child.fixtureBootRefused) throw new Error('Evaluator child shutdown refused');
      if (forced) throw new Error('Evaluator child shutdown watchdog; forced cleanup is not a passing lifecycle result');
    }
  };
  lab.close = async () => {
    const errors = [], attempt = async fn => {try {await fn();} catch(error) {errors.push(error);}};
    await attempt(() => lab.stopChildren());
    if (provisioned) await attempt(() => provisioned.close());
    if (lab.admin) for (const role of [...addedRoles].reverse()) await attempt(async () => {
      await lab.admin.query('DROP OWNED BY "' + role + '"');
      await lab.admin.query('DROP ROLE "' + role + '"'); addedRoles.delete(role);
    });
    if (directory) await attempt(async () => fs.rmSync(directory, {recursive:true,force:true}));
    await attempt(() => close());
    if (errors.length) throw new globalThis.AggregateError(errors, 'Evaluator fixture owned cleanup refused');
  };
  lab.foreignScope = fn => scope.withTenant(lab.B, fn);
  return lab;
};
