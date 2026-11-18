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
const { run } = require('../../lib/migrations/postgres');
const stream = require('./pgstream-native');

module.exports = function evaluatorPreviewRegistryLab () {
  const lab = base(), open = lab.open.bind(lab), reset = lab.reset.bind(lab), close = lab.close.bind(lab);
  const children = new Set(), addedRoles = new Set();
  let directory, connectionString, settingsConnection, activityConnection, lifetimeConnection, provisioned, producer, producerIdentity, operationFile, registryReady = false, verificationNamespace;
  lab.consumerName = 'evaluator-native-proof';
  lab.previewRole = lab.name + '_evaluator';
  lab.open = async () => {
    const capability = stream.capability(process.env);
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
      catalogue: require('../../lib/server/serve/postgres-domains').get(domain).catalogue, mode: 'reader' });
    await lab.admin.query('GRANT UPDATE(checkpoint,projection,contract_digest,' + require('../../lib/pgstream/checkpoint').WORK_COLUMNS.join(',') + ') ON "' + lab.replayNamespace +
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
      namespaces: { clock: lab.namespaces.clock }, checkpoints: [{ namespace: lab.replayNamespace, consumer: lab.consumerName, digest: replay.digest },
        { namespace: lab.replayNamespace, consumer: lab.consumerName + '-completed', digest: crypto.createHash('sha256').update(JSON.stringify(['evaluator-work-v2', lab.replayNamespace, lab.consumerName])).digest('hex') }] });
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
    lab.document = { version: 1, postgres: { connectionEnv: 'NS_EVALUATOR_FIXTURE_CONNECTION', namespaces },
      consumer: lab.consumerName, pageSize: 3, maxRows: 10000, maxBytes: 4 * 1024 * 1024, maxTenants: 2,
      timeIntervalMs: 1000000,
      pgstream: stream.configuration({ prefix: lab.name, evaluatorRole: lab.previewRole, capability }), trustedWorker,
      activity: { connectionEnv: 'NS_EVALUATOR_FIXTURE_ACTIVITY', namespace: registry.control },
      registry: { namespace: registry.registry, maxTenants: 2, refreshMs: 250 },
      tenantSettings: { connectionEnv: 'NS_EVALUATOR_FIXTURE_SETTINGS', namespaces: { settings: registry.settings, operatorPolicy: registry.operatorPolicy } } };
    lab.registryNamespaces = registry;
    lab.registryAdmission = { namespace: registry.registry, allows: async tenant => (await provisioned.provisioning.get(tenant))?.state === 'active' };
    operationFile = path.join(directory, 'operation.json');
    lab.prepareProduct = async config => {
      const selected = { ...config.document, namespaces: config.document.postgres.namespaces };
      const identity = JSON.stringify([selected.consumer, selected.namespaces, selected.trustedWorker, selected.pgstream]);
      if (producer && producerIdentity === identity) return;
      assert(![...children].some(child => child.exitCode === null && child.signalCode === null), 'fixture cannot rebind a live producer');
      if (producer) { await producer.close(); producer = null; }
      // A dedicated evaluator is one participant in the maintained four-role
      // composition. The other private endpoints are declared but absent in
      // this local evaluator fixture: no remote cohort/census claim is made.
      const plan = require('./multitenant-plan'), layout = plan.layout('ev_' + crypto.createHash('sha256').update(lab.name).digest('hex').slice(0, 16));
      Object.assign(layout.namespaces, namespaces, { eval_checkpoint: lab.replayNamespace,
        authorization: registry.authorization, secrets: registry.secrets, legacy: registry.legacy,
        access: registry.access, control: registry.control });
      const documents = plan.documents({ layout });
      for (const document of Object.values(documents.configs)) {
        document.registry = { ...config.document.registry };
        if (document.tenantSettings) document.tenantSettings = structuredClone(config.document.tenantSettings);
      }
      documents.configs.evaluator = config.document;
      const protects = require('../../lib/server/serve/operation-cohort').protectedNamespaces;
      const participants = documents.operations.evaluator.participants.map(row => ({ ...row,
        namespaces: protects(documents.configs[row.id]).filter(namespace => namespace !== registry.control) }));
      fs.writeFileSync(operationFile, JSON.stringify({ ...documents.operations.evaluator,
        namespace: registry.control, connectionEnv: 'NS_EVALUATOR_FIXTURE_LIFETIME',
        registry: { namespace: registry.registry }, participants }), { mode: 0o600 });
      producer = await stream.setup({ admin: lab.admin, adminURI: process.env.NS_TEST_POSTGRES_ADMIN_URI, directory,
        config: selected, evaluatorRole: lab.previewRole });
      producerIdentity = identity;
    };
    lab.setSettings = async (settings, tenant) => {
      settings = require('../../lib/tenant-settings/catalogue').normalize(settings);
      const ids = tenant === undefined ? [lab.A, lab.B] : [tenant];
      const result = await lab.admin.query('UPDATE "' + registry.settings + '".tenant_settings SET version=version+1,values=$2::jsonb WHERE tenant_id=ANY($1::uuid[])', [ids, JSON.stringify(settings)]);
      assert.equal(result.rowCount, ids.length, 'fixture settings updates existing provisioned tenants');
    };
    // These are fixture-owned actor controls, never evaluator role controls.
    lab.stream = () => producer;
    lab.startStream = () => producer.start();
    lab.stopStream = () => producer?.stop();
    lab.environment = env;
    registryReady = true;
    await lab.reset();
  };
  lab.reset = async () => {
    if (!registryReady) return reset(); // inherited open resets before this extension exists
    await lab.stopChildren();
    // Destructive per-test wipes declare a new source incarnation. Retire the
    // fixture-owned slot/schema/role before TRUNCATE, whose stream event is not
    // supported by the strict clinical routing contract. Within-test process
    // restarts do not enter this reset and keep their original source/coverage.
    if(producer){await producer.close();producer=null;producerIdentity=null;}
    if(verificationNamespace){await lab.admin.query('DROP SCHEMA "'+verificationNamespace+'" CASCADE');verificationNamespace=undefined;}
    lab.document.pgstream.generation=crypto.randomBytes(16).toString('hex');
    for (const domain of lab.domains) await lab.admin.query('TRUNCATE "' + lab.namespaces[domain] + '"."' + domain + '"');
    lab.initial = Date.now() + 100000;
    const clock = await lab.admin.query('UPDATE "' + lab.namespaces.clock + '".tenant_write_clock SET last_stamp=$3,last_delete_stamp=0 WHERE tenant_id IN ($1,$2)', [lab.A, lab.B, lab.initial]);
    assert.equal(clock.rowCount, 2, 'registry fixture must retain both actually provisioned clocks');
    const checkpoints = await lab.admin.query('UPDATE "' + lab.replayNamespace + '".tenant_consumer_checkpoint SET checkpoint=0,projection=NULL WHERE tenant_id IN ($1,$2) AND consumer=$3', [lab.A, lab.B, lab.consumerName]);
    assert.equal(checkpoints.rowCount, 2, 'registry fixture must retain both actually provisioned checkpoints');
    await lab.admin.query('UPDATE "' + lab.replayNamespace + '".tenant_consumer_checkpoint SET checkpoint=0,projection=NULL,work_version=0,work_observed=NULL,work_completed=NULL,work_observed_at=NULL,work_pending_at=NULL,work_due_at=NULL,work_completed_at=NULL,output_identity=NULL,output_digest=NULL,output_revision=0,output_restore_generation=NULL,delivery_revision=0,delivery_ack_revision=0 WHERE tenant_id IN ($1,$2) AND consumer=$3', [lab.A, lab.B, lab.consumerName + '-completed']);
    const settings = await lab.admin.query('UPDATE "' + lab.registryNamespaces.settings + '".tenant_settings SET version=version+1,values=$3::jsonb WHERE tenant_id IN ($1,$2)',
      [lab.A, lab.B, JSON.stringify({ enable: ['bgnow', 'delta', 'direction', 'timeago'] })]);
    assert.equal(settings.rowCount, 2, 'registry fixture settings are committed provisioned rows');
  };
  // Every serving evaluator checks a platform proof at start (decision
  // platform-application-boundary); each configuration selects one.
  lab.configure = (change = () => {}) => {
    const document = structuredClone(lab.document);
    document.platformVerification = { namespace: lab.name + '_verification', role: 'evaluator' };
    change(document);
    const file = path.join(directory, 'config.json'); fs.writeFileSync(file, JSON.stringify(document), { mode: 0o600 });
    // Validate shape without requiring a recovery credential before setup has
    // created its restricted replication role. Actual identity parsing follows
    // that setup; no placeholder URI is supplied to the product parser.
    configParser.parseMetadata(document);
    const configured = { document, file, async identity (tenant) {
      await lab.prepareProduct(configured);
      const parsed = configParser.parse(document, env(configured));
      return (await configParser.withSettings(parsed, configParser.registryEntry(tenant), tenant)).identity;
    } };
    return configured;
  };
  // Explicit selected-startup variant: the real admin verification service
  // screens this exact role/config/operation plane before publishing admission.
  // Elevated credentials stay in this parent fixture, never in the worker.
  lab.verifyPlatform = async (configured, action = 'verify') => {
    assert(configured.document.platformVerification, 'SELECTED_STARTUP_CONFIG_REQUIRED');
    await lab.prepareProduct(configured);
    const selected = configured.document.platformVerification;
    if (!verificationNamespace) {
      const writer = (await lab.admin.query('SELECT current_user AS name')).rows[0].name;
      await require('../../lib/server/serve/platform-verification').install(lab.admin,
        { namespace: selected.namespace, writer, readers: [lab.previewRole] });
      verificationNamespace = selected.namespace;
    }
    assert.equal(verificationNamespace, selected.namespace);
    const service = require('../../lib/server/serve/platform-verification-admin').create({
      namespace: selected.namespace, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI,
      targets: [{ role: 'evaluator', configFile: configured.file, operationConfigFile: operationFile }]
    }, env(configured));
    try {
      let result;
      try { result = await service[action](); }
      catch (error) {
        if (action === 'verify') {
          try {
            const api = require('../../lib/server/serve/platform-verification-admin');
            await api.checkTarget(api.loadTarget({role:'evaluator',configFile:configured.file,operationConfigFile:operationFile},env(configured)));
            lab.tracePreview('selected-startup-strict-target-diagnostic',{status:'TARGET_CHECK_PASSED_RECORD_PUBLICATION_REFUSED'});
          } catch (cause) {
            lab.tracePreview('selected-startup-strict-target-diagnostic',{status:'STRICT_TARGET_REFUSED',name:cause.name,code:cause.code||null,message:cause.message});
            try { configParser.parse(configured.document,env(configured)); } catch(parseError) { lab.tracePreview('selected-startup-direct-parse-diagnostic',{mode:scope.getTenancyMode(),message:parseError.message,stack:parseError.stack}); }
          }
        }
        throw error;
      }
      lab.tracePreview('selected-startup-admin-' + action, result);
      return result;
    } finally { await service.close(); }
  };
  lab.configureSelectedStartup = async (change = () => {}) => {
    const configured = lab.configure(change);
    configured.tenantReadiness = 'serve';
    const result = await lab.verifyPlatform(configured);
    assert.equal(result.status, 'verified', 'ACTUAL_ADMIN_VERIFICATION_REQUIRED');
    configured.verified = true;
    return configured;
  };
  // The deployment's pre-start step before each fixture role start. A refused
  // step leaves no proof; the role then refuses at start, as in a deployment.
  lab.preStart = async config => {
    if (config.verified || !config.document?.platformVerification) return;
    try { await lab.verifyPlatform(config); } catch (error) { lab.tracePreview('pre-start-refused', { code: error.code || null }); }
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
      NODE_ENV: 'test', TZ: 'UTC', MULTITENANT_EVALUATOR_CONFIG: config.file, NS_EVALUATOR_FIXTURE_CONNECTION: connectionString,
      NS_EVALUATOR_FIXTURE_SETTINGS: settingsConnection, NS_EVALUATOR_FIXTURE_ACTIVITY: activityConnection,
      NS_EVALUATOR_FIXTURE_LIFETIME: lifetimeConnection, MULTITENANT_OPERATION_CONFIG: operationFile,
      NS_SERVE_INTERNAL_SOCKET: path.join(directory, 'evaluator.sock'), NS_EVALUATOR_INTERNAL_SOCKET: path.join(directory, 'evaluator.sock'),
      NS_API_INTERNAL_SOCKET: path.join(directory, 'api.sock'), NS_TENANT_ADMIN_INTERNAL_SOCKET: path.join(directory, 'tenant-admin.sock'),
      NS_REALTIME_INTERNAL_SOCKET: path.join(directory, 'realtime.sock'),
      ...producer?.environment,
      ...lab.extraEnvironment,
      // Results are read right after boot: all-tenants readiness (decision readiness-serve-then-warm).
      NS_TENANT_READINESS: config.tenantReadiness || process.env.NS_TENANT_READINESS || 'all' };
  }
  lab.worker = async (config, { detached = false } = {}) => {
    if (typeof detached !== 'boolean') throw new TypeError('Explicit worker detached boolean required');
    // A new explicit fixture role starts a fresh external test actor; this is
    // not an automatic response to a role process exit.
    if(![...children].some(child=>child.exitCode===null&&child.signalCode===null))await lab.stream?.()?.stop();
    await lab.prepareProduct(config); await lab.preStart?.(config);
    return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'evaluator-preview-worker.js'), [], { env: env(config), silent: true, detached });
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
      call (action, tenant = lab.A, extra = {}) { return new Promise((done, fail) => {
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
    Promise.resolve().then(() => lab.startStream()).catch(error => {
      // A boot refusal closes its own process. Stopping its still-waiting
      // paired producer cancels receiver discovery; that cancellation must
      // not race the refused process's natural nonzero exit with SIGTERM.
      if (child.fixtureBootRefused && error.code === 'PGSTREAM_NATIVE_PRODUCER_START_CANCELLED') {
        lab.tracePreview('boot-refused-producer-start-cancelled', { code: error.code, bootRefused: true });
        return;
      }
      clearTimeout(timeout); child.kill('SIGTERM'); reject(error);
    });
    child.on('exit', (code, signal) => {
      console.log('M5_EVALUATOR_CHILD_EXIT ' + JSON.stringify({ kind: 'worker', pid: child.pid, code, signal, bootRefused: child.fixtureBootRefused }));
      children.delete(child);
      for (const p of pending.values()) { clearTimeout(p.timer); p.fail(new Error('Evaluator worker exited with pending command')); }
      pending.clear();
    });
  });
  };
  lab.stopWorker = async worker => {
    await lab.stopStream();
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
    await lab.prepareProduct(config); await lab.preStart?.(config);
    const child = spawn(process.execPath, [path.join(__dirname, '../../bin/nightscout.js'), 'multitenant', 'evaluator'],
      { env: env(config), stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('exit', (code, signal) => { children.delete(child);
      console.log('M5_EVALUATOR_CHILD_EXIT ' + JSON.stringify({ kind: 'cli', pid: child.pid, code, signal })); });
    await lab.startStream();
    return { child, logs: () => ({ stdout, stderr }) };
  };
  lab.wait = async check => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Evaluator native condition watchdog');
  };
  lab.stopChildren = async () => {
    const errors=[];
    try{await lab.stopStream?.();}catch(error){errors.push(error);}
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
    await attempt(() => lab.stopStream?.());
    await attempt(() => lab.stopChildren());
    if (producer) await attempt(() => producer.close());
    if (provisioned) await attempt(() => provisioned.close());
    if (verificationNamespace) await attempt(() => lab.admin.query('DROP SCHEMA "' + verificationNamespace + '" CASCADE'));
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
