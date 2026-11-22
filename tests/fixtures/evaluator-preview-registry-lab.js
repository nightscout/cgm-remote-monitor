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
const base = require('./m5-current-state-proof');
const deployment = require('../../lib/server/serve/deployment-settings');
const configParser = require('../../lib/server/serve/evaluator-config');
const provisionedTenants = require('./provisioned-tenants');
const assert = require('node:assert/strict');
const { run } = require('../../lib/migrations/postgres');
const decorate = require('../../lib/storage/postgres-write-clock');
const writerDriven = require('../../lib/writer-driven');

module.exports = function evaluatorPreviewRegistryLab () {
  const lab = base(), open = lab.open.bind(lab), reset = lab.reset.bind(lab), close = lab.close.bind(lab);
  const children = new Set(), addedRoles = new Set();
  let directory, connectionString, settingsConnection, activityConnection, lifetimeConnection, provisioned, hinter, registryReady = false;
  const layout = deployment.layout({ NS_PG_PREFIX: lab.name });
  Object.assign(lab.catalogues, require('../../lib/server/tenant-socket-order-port').catalogues);
  lab.replayNamespace = layout.namespaces.eval_checkpoint;
  lab.consumerName = deployment.IDENTITY.evaluatorConsumer;
  lab.previewRole = lab.name + '_evaluator';
  lab.sweepMs = 5000; // the deployed default; a suite may shorten it before it starts a role
  lab.open = async () => {
    await open(); directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-preview-'));
    const password = crypto.randomBytes(24).toString('hex');
    await lab.admin.query('CREATE ROLE "' + lab.previewRole + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + password + '\'');
    addedRoles.add(lab.previewRole);
    const namespaces = { ...Object.fromEntries(Object.entries(lab.tables).map(([logical, table]) => [logical, table.split('.')[0]])),
      clock: lab.namespaces.clock, checkpoint: lab.replayNamespace };
    await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: lab.replayNamespace,
      catalogue: require('../../migrations/candidates/postgres-evaluator-work-v2.json') });
    for (const namespace of Object.values(namespaces)) {
      await lab.admin.query('GRANT USAGE ON SCHEMA "' + namespace + '" TO "' + lab.previewRole + '"');
      await lab.admin.query('GRANT SELECT ON "' + namespace + '".schema_migrations TO "' + lab.previewRole + '"');
    }
    for (const table of [...Object.values(lab.tables), lab.namespaces.clock + '.tenant_write_clock', lab.replayNamespace + '.tenant_consumer_checkpoint']) {
      await lab.admin.query('GRANT SELECT ON ' + table.split('.').map(n => '"' + n + '"').join('.') + ' TO "' + lab.previewRole + '"');
    }
    for (const domain of Object.keys(lab.tables)) await require('./tenant-insertion-grants').grant(lab.admin, {
      namespace: namespaces[domain], domain, role: lab.previewRole,
      catalogue: lab.catalogues[domain], mode: 'reader' });
    await lab.admin.query('GRANT UPDATE(checkpoint,projection,contract_digest,' + require('../../lib/pgstream/checkpoint').WORK_COLUMNS.join(',') + ') ON "' + lab.replayNamespace +
      '".tenant_consumer_checkpoint TO "' + lab.previewRole + '"');
    // The deployment's evaluator work-row policy (nightscout-deploy output-grants.js
    // pgstream_evaluator_metadata): cross-tenant work reads and completion on its own rows only.
    await lab.admin.query('CREATE POLICY pgstream_evaluator_metadata ON "' + lab.replayNamespace + '".tenant_consumer_checkpoint TO "' + lab.previewRole +
      "\" USING (consumer IN ('" + lab.consumerName + "','" + lab.consumerName + "-completed')) WITH CHECK (consumer IN ('" + lab.consumerName + "','" + lab.consumerName + "-completed'))");
    const url = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); url.username = lab.previewRole; url.password = password;
    connectionString = url.toString();
    const owner = lab.name + '_registry_owner', settingsRole = lab.name + '_settings_reader';
    await lab.admin.query('CREATE ROLE "' + owner + '" NOLOGIN NOSUPERUSER NOBYPASSRLS'); addedRoles.add(owner);
    const settingsPassword = crypto.randomBytes(24).toString('hex');
    await lab.admin.query('CREATE ROLE "' + settingsRole + '" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD \'' + settingsPassword + '\''); addedRoles.add(settingsRole);
    // The inherited lab primes clock rows. Strict provisioning must create its
    // own rows in the registry transaction, never adopt these synthetic rows.
    await lab.admin.query('DELETE FROM "' + lab.namespaces.clock + '".tenant_write_clock');
    // This lab provisions without an owner-configuration namespace (provisioned-tenants has no catalogue for it).
    const { clock, ...allNames } = require('../../lib/server/ordinary-deployment-grants').provisioningNamespaces(layout.namespaces);
    const namespaceNames = Object.fromEntries(Object.entries(allNames).filter(([kind]) => kind !== 'ownerConfiguration'));
    provisioned = await provisionedTenants.create({ admin: lab.admin, adminURI: process.env.NS_TEST_POSTGRES_ADMIN_URI, owner,
      namespaceNames, namespaces: { clock }, catalogues: { control: () => require('../../lib/tenant-lifecycle/native-selection').catalogue(deployment.nativeSelection(layout)) }, checkpoints: deployment.checkpoints(layout).filter(row => row.namespace === lab.replayNamespace) });
    const registry = provisioned.namespaces;
    // Match canonical DBA grants: the lifetime role may execute only its
    // lifecycle birth function; settings validation belongs to provisioning.
    await lab.admin.query('REVOKE ALL ON FUNCTION "' + registry.settings + '".tenant_settings_values_valid(jsonb) FROM PUBLIC');
    await lab.admin.query('GRANT EXECUTE ON FUNCTION "' + registry.settings + '".tenant_settings_values_valid(jsonb) TO "' + provisioned.provisioner + '"');
    for (const statement of provisioned.registryGrants({ enumerators: [lab.previewRole] })) await lab.admin.query(statement);
    for (const kind of ['settings', 'operatorPolicy']) {
      const ns = registry[kind], table = kind === 'settings' ? 'tenant_settings' : 'tenant_operator_policy';
      await lab.admin.query('GRANT USAGE ON SCHEMA "' + ns + '" TO "' + settingsRole + '"');
      await lab.admin.query('GRANT SELECT ON "' + ns + '".schema_migrations,"' + ns + '"."' + table + '" TO "' + settingsRole + '"');
    }
    const settingsURL = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); settingsURL.username = settingsRole; settingsURL.password = settingsPassword;
    settingsConnection = settingsURL.toString();
    const activityRole = lab.name + '_activity_reader', lifetimeRole = lab.name + '_lifetime';
    for (const role of [activityRole, lifetimeRole]) {
      const secret = crypto.randomBytes(24).toString('hex');
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${secret}'`); addedRoles.add(role);
      const address = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); address.username = role; address.password = secret;
      if (role === activityRole) activityConnection = address.toString(); else lifetimeConnection = address.toString();
    }
    for (const statement of require('../../lib/tenant-activity/postgres').grants({ namespace: registry.control, reader: activityRole })) await lab.admin.query(statement);
    lab.grantOperationReader = async role => {
      await lab.admin.query('GRANT USAGE ON SCHEMA "' + registry.control + '" TO "' + role + '"');
      for (const table of ['schema_migrations', 'tenant_lifecycle_windows', 'tenant_lifecycle_operations'])
        await lab.admin.query('GRANT SELECT ON "' + registry.control + '"."' + table + '" TO "' + role + '"');
    };
    for (const role of [lab.previewRole, settingsRole, activityRole, lifetimeRole]) await lab.grantOperationReader(role);
    await lab.admin.query('GRANT INSERT(tenant_id,operation_id,generation),UPDATE(finished) ON "' + registry.control + '".tenant_lifecycle_operations TO "' + lifetimeRole + '"');
    await lab.admin.query('GRANT EXECUTE ON FUNCTION "' + registry.control + '".tenant_lifecycle_backend_birth() TO "' + lifetimeRole + '"');
    const trustedWorker = { clock: namespaces.clock, activity: registry.control, settings: registry.settings, operatorPolicy: registry.operatorPolicy };
    for (const statement of require('../../lib/trusted-worker/postgres').grants({ namespaces: trustedWorker, roles: [lab.previewRole] })) await lab.admin.query(statement);
    for (const [index, id] of [lab.A, lab.B].entries()) await provisioned.provision({ id, hosts: ['evaluator-' + index + '.example.test'] });
    // Writer-driven input (the only transport): the api's write role marks the evaluator's
    // completed-work row pending in its own transaction, as ordinary deployment grants allow.
    for (const sql of writerDriven.grants({ namespace: lab.replayNamespace, roles: [lab.role] })) await lab.admin.query(sql);
    // After COMMIT the api sends a disposable `changed` hint to the evaluator's private listener;
    // the pending mark and the sweep are the guarantee, the hint only shortens the wait.
    hinter = writerDriven.changedSender(env());
    // The lifecycle namespace carries the native selection's catalogue (the evaluator's start check requires it).
    lab.lifecycleCatalogue = require('../../lib/tenant-lifecycle/native-selection').catalogue(deployment.nativeSelection(layout));
    lab.pendingBinding = { table: '"' + lab.replayNamespace + '".tenant_consumer_checkpoint', consumer: lab.consumerName + '-completed',
      hint: (tenant, stamp) => hinter.changed(tenant, { stamp }) };
    // NS_EVALUATOR_LAB_CONTROL=no-mark is the negative control for every suite on this lab: the writers do
    // not mark the work row, so no write is owed and the suites' recovery and wake criteria must go red.
    const marking = process.env.NS_EVALUATOR_LAB_CONTROL === 'no-mark' ? {} : { pending: lab.pendingBinding };
    lab.clocks.forEach((_, index) => { lab.clocks[index] = decorate(lab.raw[index], lab.namespaces.clock, marking); });
    lab.document = deployment.evaluator(env());
    // This base lab exercises clinical acquisition without a notification sink.
    // The consumer extension provisions the deployment's outbox and suppression roles.
    delete lab.document.consumers;
    lab.registryNamespaces = registry;
    lab.registryAdmission = { namespace: registry.registry, allows: async tenant => (await provisioned.provisioning.get(tenant))?.state === 'active' };
    lab.setSettings = async (settings, tenant) => {
      settings = require('../../lib/tenant-settings/catalogue').normalize(settings);
      const ids = tenant === undefined ? [lab.A, lab.B] : [tenant];
      const result = await lab.admin.query('UPDATE "' + registry.settings + '".tenant_settings SET version=version+1,values=$2::jsonb WHERE tenant_id=ANY($1::uuid[])', [ids, JSON.stringify(settings)]);
      assert.equal(result.rowCount, ids.length, 'fixture settings updates existing provisioned tenants');
    };
    lab.environment = env;
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
    // Back to the provisioned state: the typed work-v2 row, pending at bootstrap (lib/writer-driven
    // provisionedRow), so the api's pending mark finds it and the sweep finds the tenant.
    const typed = writerDriven.provisionedRow(Date.now());
    await lab.admin.query('UPDATE "' + lab.replayNamespace + '".tenant_consumer_checkpoint SET checkpoint=0,work_version=$4,work_observed=$5,work_completed=$6,work_observed_at=$7,work_pending_at=$8,projection=$9::jsonb,work_due_at=NULL,work_completed_at=NULL,output_identity=NULL,output_digest=NULL,output_revision=0,output_restore_generation=NULL,delivery_revision=0,delivery_ack_revision=0,notification_work_pending=false WHERE tenant_id IN ($1,$2) AND consumer=$3', [lab.A, lab.B, lab.consumerName + '-completed', ...typed.values]);
    const settings = await lab.admin.query('UPDATE "' + lab.registryNamespaces.settings + '".tenant_settings SET version=version+1,values=$3::jsonb WHERE tenant_id IN ($1,$2)',
      [lab.A, lab.B, JSON.stringify({ enable: ['bgnow', 'delta', 'direction', 'timeago'] })]);
    assert.equal(settings.rowCount, 2, 'registry fixture settings are committed provisioned rows');
  };
  lab.configure = (change = () => {}) => {
    const document = structuredClone(lab.document);
    change(document);
    // Validate shape without requiring a recovery credential before setup has
    // created its restricted replication role. Actual identity parsing follows
    // that setup; no placeholder URI is supplied to the product parser.
    configParser.parseMetadata(document);
    const standard = deployment.evaluator(env({ document }));
    const args = require('node:util').isDeepStrictEqual(document, standard) ? [] : [JSON.stringify(document)];
    const configured = { document, args, async identity (tenant) {
      const parsed = configParser.parse(document, env(configured));
      return (await configParser.withSettings(parsed, configParser.registryEntry(tenant), tenant)).identity;
    } };
    return configured;
  };
  // Selected-startup variant: the role runs its own start check (decision
  // platform-verification-removal); no admin step precedes it.
  lab.configureSelectedStartup = async (change = () => {}) => {
    const configured = lab.configure(change);
    configured.tenantReadiness = 'serve';
    return configured;
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
  // Compact SQL stores native coverage and pending work, never clinical rows.
  // Read this receipt honestly; clinical outcomes belong to completed output.
  lab.previewCheckpoint = tenant => lab.checkpoint(lab.consumerName,tenant);
  // Independent storage observation, including after the actual role/window
  // refuses serving. Read the durable typed output rather than reconstruct RAM.
  lab.previewCompleted = async (tenant = lab.A) => {
    const rows = (await lab.admin.query('SELECT checkpoint,projection,output_identity,output_digest,output_revision,output_restore_generation,work_completed FROM "' +
      lab.replayNamespace + '".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2', [tenant, lab.consumerName + '-completed'])).rows;
    assert.equal(rows.length, 1, 'actual provisioned durable completed row');
    return rows[0];
  };
  lab.previewPhysical = async () => ({ A: { ...(await lab.physical(lab.A)), checkpoint: await lab.previewCheckpoint(lab.A) },
    B: { ...(await lab.physical(lab.B)), checkpoint: await lab.previewCheckpoint(lab.B) } });
  lab.encode = value => JSON.parse(JSON.stringify(value, (key, item) => item === undefined ? { probeType: 'undefined' }
    : typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)) ? { probeType: 'number', value: Object.is(item, -0) ? '-0' : String(item) } : item));
  lab.tracePreview = (phase, data) => { const value = lab.encode({ phase, ...data }); console.log('M5_EVALUATOR_OBSERVATION ' + JSON.stringify(value)); return data; };
  function env (config) {
    return { PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: process.env.NODE_PATH,
      NODE_ENV: 'test', TZ: 'UTC', NS_PG_PREFIX: lab.name, NS_SECRETS_DIR: directory,
      NS_REGISTRY_MAX_TENANTS: '2', NS_REGISTRY_REFRESH_MS: '250',
      // The evaluator's own sweep over pending rows shortens to the fixture's cadence.
      NS_EVALUATOR_SWEEP_MS: String(lab.sweepMs),
      NS_EVALUATOR_PG: connectionString, NS_DISPLAY_PG: settingsConnection, NS_ACTIVITY_PG: activityConnection,
      NS_LIFETIME_PG: lifetimeConnection,
      NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'evaluator.sock'), NS_EVALUATOR_INTERNAL_SOCKET: path.join(directory, 'evaluator.sock'),
      NS_API_INTERNAL_SOCKET: path.join(directory, 'api.sock'), NS_TENANT_ADMIN_INTERNAL_SOCKET: path.join(directory, 'tenant-admin.sock'),
      NS_REALTIME_INTERNAL_SOCKET: path.join(directory, 'realtime.sock'),
      // The fewer-round-trips switch passes through, so any suite can run in either arm.
      ...(process.env.NS_EVAL_FEWER_ROUNDTRIPS !== undefined ? { NS_EVAL_FEWER_ROUNDTRIPS: process.env.NS_EVAL_FEWER_ROUNDTRIPS } : {}),
      ...lab.extraEnvironment,
      // Results are read right after boot: all-tenants readiness (decision readiness-serve-then-warm).
      NS_TENANT_READINESS: config?.tenantReadiness || process.env.NS_TENANT_READINESS || 'all' };
  }
  lab.worker = async (config, { detached = false } = {}) => {
    if (typeof detached !== 'boolean') throw new TypeError('Explicit worker detached boolean required');
    return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'evaluator-preview-worker.js'), config.args, { env: env(config), silent: true, detached });
    const pending = new Map(); child.fixtureBootRefused = false; let sequence = 0, stdout = '', stderr = '', heldResolve;
    children.add(child); child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Evaluator worker startup watchdog')); }, 15000);
    let owned = {};
    if (detached) {
      const raw = fs.readFileSync('/proc/' + child.pid + '/stat', 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      assert.equal(Number(fields[2]), child.pid, 'DETACHED_WORKER_OWNS_PROCESS_GROUP');
      assert.equal(Number(fields[3]), child.pid, 'DETACHED_WORKER_OWNS_SESSION');
      owned = { birth: fields[19], processGroup: child.pid };
    }
    const handle = { child, ...owned, logs: () => ({ stdout, stderr }), held: () => new Promise(done => { heldResolve = done; }),
      call (action, tenant = lab.A, extra = {}) { if (action === 'acquire') lab.pendingBinding.hint(tenant); return new Promise((done, fail) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); fail(new Error('Evaluator fixture command watchdog')); }, 15000);
        pending.set(id, { done, fail, timer }); child.send({ id, action, tenant, ...extra });
      }); } };
    child.on('message', message => {
      if(message.clinicalFailure)lab.tracePreview('clinical-refusal',message.clinicalFailure);
      if (message.ready || message.bootError) { child.fixtureBootRefused = !!message.bootError; clearTimeout(timeout); resolve({ ...handle, startup: message }); }
      else if (message.held) { if (heldResolve) heldResolve(message); }
      else if (pending.has(message.id)) {
        const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) { lab.tracePreview('preview-command-error', message.error); p.fail(Object.assign(new Error(message.error.message), { name: message.error.name })); } else p.done(message.value);
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
  };
  lab.stopWorker = async worker => {
    if (worker.child.fixtureBootRefused) {
      // Refused startup has no running role command surface. The bootError IPC
      // precedes process exit, so drain that actual exit without sending close.
      const result = worker.child.exitCode !== null || worker.child.signalCode !== null
        ? { code: worker.child.exitCode, signal: worker.child.signalCode }
        : await new Promise((resolve, reject) => {
          const stopped = (code, signal) => { clearTimeout(timer); resolve({ code, signal }); };
          const timer = setTimeout(() => { worker.child.off('exit', stopped); reject(new Error('Evaluator refused worker exit watchdog')); }, 5000);
          worker.child.once('exit', stopped);
        });
      assert.equal(result.code, 1, 'BOOT_REFUSED_WORKER_MUST_EXIT_NONZERO');
      assert.equal(result.signal, null, 'BOOT_REFUSED_WORKER_MUST_EXIT_WITHOUT_FORCED_SIGNAL');
      return result;
    }
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
    await worker.call('release'); await worker.call('close');
    const stopped = new Promise(resolve => worker.child.once('exit', (code, signal) => resolve({ code, signal })));
    worker.child.send({ id: 0, action: 'exit' }); return stopped;
  };
  lab.cli = async config => {
    assert.equal(config.args.length, 0, 'the real CLI uses the deployment configuration');
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
    const errors=[];
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      let forced = false;
      const stopped = new Promise(resolve => {
        const t = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000);
        child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
      });
      child.kill('SIGTERM'); const result = await stopped;
      if (!forced && result.code !== 0 && !child.fixtureBootRefused) errors.push(new Error('Evaluator child shutdown refused'));
      if (forced) errors.push(new Error('Evaluator child shutdown watchdog; forced cleanup is not a passing lifecycle result'));
    }
    if(errors.length)throw new globalThis.AggregateError(errors,'Evaluator actors cleanup refused');
  };
  lab.close = async () => {
    const errors = [], attempt = async fn => {try {await fn();} catch(error) {errors.push(error);}};
    await attempt(() => lab.stopChildren());
    if (hinter) await attempt(() => hinter.close());
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
