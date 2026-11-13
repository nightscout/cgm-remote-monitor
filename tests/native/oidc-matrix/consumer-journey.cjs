'use strict';

// Executable native fixture capability. Import/admission perform no acquisition.
// Source tests of this module are instrument evidence, never native acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const DOMAIN_NAMES = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const KINDS = [...DOMAIN_NAMES, 'clock', 'checkpoint'];
const OREF_COMMIT = 'd219baf9559d62a8bb0bd42014192a2d7c0839ef';
const CLIENT_HASHES = {
  'bin/ns-get.sh': 'b13d716d3d9e27249fa3864fdf747ed0eeb6aeaf8396bb6e05d40d2a3ec2fffb',
  'bin/oref0-bash-common-functions.sh': 'bae949d5fc80cf52966349137172be0c15f8fe038cd019d10e19864ebfb9e828'
};
const TOOLS = ['bash', 'curl', 'jq', 'dirname', 'basename', 'cat'];
const q = value => '"' + value.replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = code => { throw new Error(code || 'CONSUMER_JOURNEY_ADMISSION_REFUSED'); };

function requirements () {
  return {
    classification: 'native-PG-HTTP-consumer-clinical-issued-DATA-and-pinned-oref0',
    configuration: 'consumerJourney: connectionEnv, namespaces(all six clinical domains,clock,checkpoint), client(root,commit,tools,caEnv,maxMs)',
    identity: 'one additional distinct NOSUPERUSER/NOBYPASSRLS clinical identity; maxPool=4',
    pools: { clinical: 4, authority: 4, legacy: 4, secrets: 4, migrationTransient: 1 },
    listenerCount: 4, client: { name: 'oref0-ns-get', commit: OREF_COMMIT, scripts: CLIENT_HASHES,
      tools: TOOLS, processes: 'one owned bash pipeline at a time: bash/curl/jq plus short-lived dirname/basename/cat', maxCases: 3 },
    source: ['lib/server/serve/preview-domains.js', 'lib/server/tenant-app/index.js',
      'lib/server/tenant-app/data-access.js', 'lib/tenant-authorization/postgres.js',
      'lib/secrets/component.js', 'lib/secrets/postgres.js', 'lib/secrets/legacy-postgres.js',
      'lib/server/serve/evaluator-runtime.js', 'lib/data/tenant-projection-evaluator.js',
      'lib/storage/postgres-durable-replay.js', 'lib/server/serve/evaluator-config.js',
      'lib/storage/postgres-projection-read.js', 'lib/server/serve/postgres-domains.js',
    'lib/storage/postgres-tenant-stats.js', 'lib/server/serve/evaluator-readiness.js'],
    catalogues: ['lib/server/serve/postgres-domains.js:get(each domain)',
      'migrations/candidates/postgres-write-clock-v1.json', 'migrations/candidates/postgres-consumer-checkpoint-v1.json'],
    nativeExecution: 'run by tests/native/oidc-matrix/run.sh (disposable harness)'
  };
}

function admit ({ config, env = process.env } = {}) {
  if (env.HUMAN_SESSION_NATIVE_RESERVED !== '1' ||
      env.HUMAN_HTTPS_RESERVED !== '1' || !env.HUMAN_HTTP_SIGNER_CONFIG || !config?.consumerJourney) refuse();
  const c = config.consumerJourney;
  if (!/^[a-f0-9]{16,32}$/.test(config.nonce || '') || !Array.isArray(config.tenants) || config.tenants.length !== 2 ||
      new Set(config.tenants).size !== 2 || config.tenants.some(tenant => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(tenant)) ||
      !c.namespaces || Object.keys(c.namespaces).length !== KINDS.length ||
      KINDS.some(kind => typeof c.namespaces[kind] !== 'string' ||
        !c.namespaces[kind].startsWith('cj_' + config.nonce + '_') ||
        !/^[a-z][a-z0-9_]{0,20}$/.test(c.namespaces[kind].slice(4 + config.nonce.length))) ||
      new Set(Object.values(c.namespaces)).size !== KINDS.length ||
      typeof c.connectionEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(c.connectionEnv) ||
      typeof env[c.connectionEnv] !== 'string' || !config.adminConnectionEnv || !env[config.adminConnectionEnv]) refuse();
  let clinical, admin;
  try { clinical = new URL(env[c.connectionEnv]); admin = new URL(env[config.adminConnectionEnv]); } catch { refuse(); }
  if (!['postgres:', 'postgresql:'].includes(clinical.protocol) || clinical.host !== admin.host ||
      clinical.pathname !== admin.pathname || clinical.pathname !== '/owner_oidc_' + config.nonce ||
      !clinical.port || clinical.port === '5432' || !['127.0.0.1', '[::1]'].includes(clinical.hostname) ||
      !clinical.username || !clinical.password || clinical.search || clinical.hash ||
      decodeURIComponent(clinical.username) === decodeURIComponent(admin.username)) refuse();
  const otherRefs = [config.humanConnectionEnv, config.settingsReaderConnectionEnv,
    config.ownerPreview?.postgres?.writerConnectionEnv, config.ownerPreview?.postgres?.accessConnectionEnv,
    config.ownerPreview?.ownerSettings?.connectionEnv, config.ownerPreview?.ownerCredentials?.connectionEnv];
  for (const ref of otherRefs.filter(Boolean)) {
    let other; try { other = new URL(env[ref]); } catch { refuse(); }
    if (decodeURIComponent(other.username) === decodeURIComponent(clinical.username)) refuse();
  }
  const client = c.client;
  if (!client || client.commit !== OREF_COMMIT || !path.isAbsolute(client.root || '') || /\s/.test(client.root) ||
      !Number.isSafeInteger(client.maxMs) || client.maxMs < 1 || client.maxMs > 10000 ||
      typeof client.caEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(client.caEnv) ||
      !env[client.caEnv] || !client.tools || Object.keys(client.tools).length !== TOOLS.length) refuse();
  for (const [file, expected] of Object.entries(CLIENT_HASHES)) {
    // Exact selected script names; bytes are checked before any acquisition.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (createHash('sha256').update(fs.readFileSync(path.join(client.root, file))).digest('hex') !== expected) {
      refuse('CONSUMER_CLIENT_INPUT_CHANGED');
    }
  }
  for (const name of TOOLS) {
    const tool = client.tools[name];
    if (!tool || !path.isAbsolute(tool.path || '') || /\s/.test(tool.path) || path.basename(tool.path) !== name ||
        !/^[a-f0-9]{64}$/.test(tool.sha256 || '') ||
        // Explicit source-bound executable paths, never user request input.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        createHash('sha256').update(fs.readFileSync(tool.path)).digest('hex') !== tool.sha256) refuse('CONSUMER_CLIENT_TOOL_CHANGED');
  }
  if (new Set(TOOLS.map(name => path.dirname(client.tools[name].path))).size !== 1) refuse('CONSUMER_CLIENT_PATH_AMBIGUOUS');
  return true;
}

function assertClinical (before, after, foreignBefore, foreignAfter) {
  assert.ok(before.some(row => row.rows.length), 'synthetic clinical A sentinel must be nonempty');
  assert.ok(foreignBefore.some(row => row.rows.length), 'synthetic clinical B sentinel must be nonempty');
  assert.deepEqual(after, before, 'owner settings never rewrite clinical mg/dL/identity/order/floor records');
  assert.deepEqual(foreignAfter, foreignBefore, 'tenant A journey never rewrites tenant B clinical records');
}

function assertEvaluation (result, { high }) {
  assert.ok(result?.eligible === true, 'native evaluator output must be eligible');
  assert.equal(result.trigger, 'time-only', 'next settings consumption must be a time-only cycle');
  assert.equal(result.result?.properties?.bgnow?.last, 190, 'clinical mg/dL remains190 under mmol display');
  const alarms = result.result.emitted.filter(event => event.eventName === 'high');
  assert.equal(alarms.length, high ? 1 : 0, 'next evaluator cycle must consume committed threshold/alarm enables');
  if (high) assert.equal(alarms[0].debug.thresholds.bgTargetTop, 180, 'actual high event uses committed mg/dL threshold');
}

function assertClientObservation (observed, { accepted, id }) {
  assert.equal(observed.closed, true, 'pinned client process must actually close');
  assert.equal(observed.requests.length, 1, 'actual pinned client must reach one DATA request');
  assert.equal(observed.requests[0].method, 'GET');
  assert.equal(observed.requests[0].path, '/api/v1/entries.json');
  if (accepted) {
    assert.equal(observed.code, 0, 'pinned client must exit successfully');
    assert.equal(observed.requests[0].status, 200);
    assert.ok(Array.isArray(observed.value) && observed.value.some(row => row._id === id && row.sgv === 190),
      'pinned client must receive the independently seeded synthetic record');
  } else {
    assert.ok([401, 403].includes(observed.requests[0].status), 'actual DATA boundary must refuse the replay');
    assert.ok(!Array.isArray(observed.value) || observed.value.length === 0, 'refused client cannot receive clinical records');
  }
}

async function create (ctx) {
  admit(ctx);
  const { config, env, req, admin, parsed, nativeStore, services } = ctx;
  if (nativeStore?.kind !== 'postgres' || ctx.nativeBinding?.persistence !== 'postgres' ||
      ctx.nativeBinding?.signing !== 'configured-transit' || typeof req !== 'function' ||
      typeof admin?.query !== 'function' || typeof admin?.connect !== 'function' ||
      typeof services?.settingsReader?.read !== 'function' || typeof services?.subjects?.credential !== 'function' ||
      typeof ctx.listenOwned !== 'function' || typeof ctx.registerChild !== 'function' ||
      typeof ctx.remainingActiveMs !== 'function') refuse('CONSUMER_NATIVE_CONTEXT_REQUIRED');
  const c = config.consumerJourney, ns = c.namespaces, created = [], resources = [], activeClients = new Set();
  const closeErrors = [];
  let closing, runtime;
  const table = (schema, name) => q(schema) + '.' + q(name);
  const clinicalTables = Object.fromEntries(DOMAIN_NAMES.map(name => [name, ns[name] + '.' + name]));
  const consumer = 'evaluator-native-' + config.nonce;
  const at = Date.now();
  const rows = config.tenants.map((tenant, index) => ({ tenant, document: {
    _id: index ? 'native-b-sgv' : 'native-a-sgv', type: 'sgv', sgv: index ? 150 : 190,
    direction: 'Flat', date: at - 60000, utcOffset: 0, srvCreated: at, srvModified: at
  } }));
  async function bound (tenant, action) {
    const client = await admin.connect();
    try { await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const value = await action(client); await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async function close () {
    if (!closing) closing = (async () => {
      for (const client of activeClients) client.abort();
      for (const client of activeClients) { try { await client.closed; } catch (error) { closeErrors.push(error); } }
      if (runtime) { try { await runtime.close(); } catch (error) { closeErrors.push(error); } }
      for (const resource of resources.slice().reverse()) {
        try { await (resource.close ? resource.close() : resource.end()); } catch (error) { closeErrors.push(error); }
      }
      for (const record of created.slice().reverse()) {
        try {
          const current = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [record.name])).rows[0];
          if (!current || String(current.oid) !== String(record.oid)) refuse('CONSUMER_SCHEMA_IDENTITY_CHANGED');
          await admin.query('DROP SCHEMA ' + q(record.name) + ' CASCADE');
        } catch (error) { closeErrors.push(error); }
      }
      if (closeErrors.length) throw new globalThis.AggregateError(closeErrors, 'CONSUMER_JOURNEY_CLOSE_FAILED');
    })();
    return closing;
  }
  try {
    const connection = await req('./lib/storage/postgres-connection')({ connectionString: env[c.connectionEnv],
      max: 4, connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000,
      application_name: 'nightscout-native-owner-consumer' }); resources.push(connection);
    const catalogues = Object.fromEntries(DOMAIN_NAMES.map(name => [name, req('./lib/server/serve/postgres-domains').get(name).catalogue]));
    catalogues.clock = req('./migrations/candidates/postgres-write-clock-v1.json');
    catalogues.checkpoint = req('./migrations/candidates/postgres-consumer-checkpoint-v1.json');
    const role = q(decodeURIComponent(new URL(env[c.connectionEnv]).username));
    for (const kind of KINDS) {
      assert.equal((await admin.query('SELECT to_regnamespace($1) AS present', [ns[kind]])).rows[0].present, null,
        'consumer setup never reuses a namespace');
      await admin.query('CREATE SCHEMA ' + q(ns[kind]));
      const oid = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [ns[kind]])).rows[0]?.oid;
      if (!oid) refuse('CONSUMER_SCHEMA_CREATION_UNCONFIRMED');
      created.push({ name: ns[kind], oid });
      const options = { direct: true, connectionString: env[config.adminConnectionEnv], namespace: ns[kind],
        catalogue: catalogues[kind], statementTimeoutMs: 5000 };
      await req('./lib/migrations/postgres').run('up', options);
      await req('./lib/migrations/postgres').run('check', options);
      await admin.query('GRANT USAGE ON SCHEMA ' + q(ns[kind]) + ' TO ' + role);
      await admin.query('GRANT SELECT ON ALL TABLES IN SCHEMA ' + q(ns[kind]) + ' TO ' + role);
    }
    await admin.query('GRANT UPDATE(checkpoint,projection,contract_digest) ON ' + table(ns.checkpoint, 'tenant_consumer_checkpoint') + ' TO ' + role);
    for (const row of rows) await bound(row.tenant, async client => {
      await client.query('INSERT INTO ' + table(ns.entries, 'entries') + ' (tenant_id,id_kind,doc) VALUES ($1,$2,$3)',
        [row.tenant, 'string', row.document]);
      await client.query('INSERT INTO ' + table(ns.clock, 'tenant_write_clock') + ' (tenant_id,last_stamp) VALUES ($1,$2)', [row.tenant, at]);
      await client.query('INSERT INTO ' + table(ns.checkpoint, 'tenant_consumer_checkpoint') +
        ' (tenant_id,consumer,contract_digest,checkpoint,projection) VALUES ($1,$2,$3,0,NULL)', [row.tenant, consumer, '0'.repeat(64)]);
    });
    const readiness = req('./lib/server/serve/evaluator-readiness');
    const readinessConfig = { namespaces: ns, consumer, socketOrderDomains: [],
      tenants: new Map(config.tenants.map(tenant => [tenant, true])) };
    await connection.withTenant('00000000-0000-0000-0000-000000000000', () => readiness.screen(connection, readinessConfig));
    for (const tenant of config.tenants) await readiness.provisionTenant(connection, readinessConfig, tenant);
    const authRole = q(decodeURIComponent(new URL(parsed.accessConnectionString).username));
    await admin.query('GRANT SELECT ON ' + ['tenant_authorization_config', 'tenant_authorization_roles',
      'tenant_authorization_subjects', 'tenant_authorization_subject_roles'].map(name => table(parsed.namespaces.authorization, name)).join(',') + ' TO ' + authRole);
    const authority = await req('./lib/tenant-authorization/postgres')({ connectionString: parsed.accessConnectionString,
      namespace: parsed.namespaces.authorization }); resources.push(authority);
    const legacy = await req('./lib/secrets/legacy-postgres')({ connectionString: parsed.accessConnectionString,
      namespace: parsed.namespaces.credentials }); resources.push(legacy);
    const persistence = await req('./lib/secrets/postgres').createPostgresSecrets({
      connectionString: parsed.ownerCredentials.connectionString, namespace: parsed.ownerCredentials.namespace }); resources.push(persistence);
    const verifierContext = tenant => ({ tenant, principal: 'native-data', consumer: 'data' });
    const secrets = req('./lib/secrets/component').createSecrets({ ...persistence, maxTokenLifetimeSeconds: 28800,
      legacyAuthorityFor: tenant => legacy.read(tenant), providerFor: async tenant => {
        const provider = parsed.ownerCredentials.providers.get(tenant); if (!provider) refuse('CONSUMER_PROVIDER_UNKNOWN'); return provider;
      }, authorize: async (identity, action) => {
        if (!config.tenants.includes(identity.tenant) || identity.principal !== 'native-data' || identity.consumer !== 'data') return false;
        if (action.operation === 'decrypt') { const value = await legacy.read(identity.tenant); return value?.reference?.id === action.id; }
        return ['sign', 'verify'].includes(action.operation);
      } });
    const exchange = req('./lib/server/tenant-app/exchange')({ secrets, authority, verifierContext });
    const environment = req('./lib/server/tenant-app/environment');
    const environments = new Map(config.tenants.map(tenant => [tenant, environment()]));
    const bindings = new Map(config.tenants.map(tenant => [tenant, verifierContext(tenant)]));
    const domains = await req('./lib/server/serve/preview-domains')({
      config: { domains: DOMAIN_NAMES, namespaces: ns, bindings, environments, legacyEnabled: true,
        contextEnabled: true, socketForwarding: false }, connection, exchange,
      displaySettings: services.settingsReader, servingState: { read: () => 'loaded' } });
    const replay = req('./lib/storage/postgres-durable-replay')({ connection, domains: clinicalTables,
      checkpointTable: ns.checkpoint + '.tenant_consumer_checkpoint', clockTable: ns.clock + '.tenant_write_clock',
      consumer, projectionVersion: 'clinical-current-rows-v1', pageSize: 8, maxRows: 64 });
    const statistics = req('./lib/storage/postgres-tenant-stats')({ connection, tables: clinicalTables });
    const baseStates = new Map(config.tenants.map(tenant => [tenant, { tenant,
      identity: digest([tenant, ns, 'native-clinical']), env: environment() }]));
    runtime = await req('./lib/server/serve/evaluator-runtime')({ tenants: config.tenants,
      recoveryIntervalMs: 2147483647, timeIntervalMs: 2147483647, schedule: () => null, cancel () {}, now: () => at,
      readCurrent: async tenant => req('./lib/server/serve/evaluator-config').applySettings(baseStates.get(tenant), await services.settingsReader.read(tenant)),
      async create (current) {
        const language = req('./lib/language')(); language.set(current.env.settings.language);
        return req('./lib/data/tenant-projection-evaluator')({ tenant: current.tenant, replay, connection,
          env: current.env, language, maxRows: 64, maxBytes: 1048576, dbstats: () => statistics.read(current.tenant) });
      } });
    const dataApps = {}, endpoints = {}, events = {};
    const express = req('express');
    for (const tenant of config.tenants) for (const enabled of [true, false]) {
      const key = tenant + '/' + enabled, app = express(); events[key] = [];
      app.use((request, response, next) => {
        const pathname = request.path.startsWith('/api/v2/authorization/request/')
          ? '/api/v2/authorization/request/[redacted]' : request.path;
        response.once('finish', () => events[key].push({ method: request.method, path: pathname, status: response.statusCode })); next();
      });
      const resolver = req('./lib/tenant-resolution')({ aliases: [{ host: 'localhost', tenant }] });
      const dataAccess = req('./lib/server/tenant-app/data-access')({ secrets, authority, verifierContext,
        collections: domains.v3Names, legacyCollections: domains.legacyNames, safeRoutes: domains.safeRoutes,
        ...(enabled ? { humanSessions: ctx.human } : {}) });
      const unavailable = async () => { throw new Error('CONSUMER_DATA_CANNOT_MANAGE'); };
      app.use(req('./lib/server/tenant-app').createTenantApp({ resolver, dataAccess, exchange,
        dataRouter: domains.data, legacyRouter: domains.legacyRouter, rootRouter: domains.rootRouter,
        verifyCredential: async () => null, authorizeRequest: async () => false,
        tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
        subjectPolicy: { read: unavailable, replace: unavailable } }));
      dataApps[key] = app;
      endpoints[key] = await ctx.listenOwned(app, { plane: 'data', tenant, host: 'localhost', oidcEnabled: enabled });
      if (typeof endpoints[key] !== 'string' || new URL(endpoints[key]).hostname !== 'localhost') refuse('CONSUMER_DATA_ORIGIN_INVALID');
    }
    const credentialMap = new Map();
    for (const tenant of config.tenants) {
      const root = await secrets.decrypt(verifierContext(tenant), (await legacy.read(tenant)).reference);
      let apiSecret; try { apiSecret = createHash('sha1').update(root).digest('hex'); } finally { root.fill(0); }
      const actors = (await admin.query('SELECT principal FROM ' + table(parsed.namespaces.authorization, 'tenant_owner_actors') +
        ' WHERE tenant_id=$1 AND consumer=$2 AND active AND can_update ORDER BY principal', [tenant, parsed.consumer])).rows;
      assert.equal(actors.length, 1, 'fixture compatibility uses exactly one explicit current owner');
      const actor = { tenant, principal: actors[0].principal, consumer: parsed.consumer };
      const subject = await services.subjects.create(actor, { name: 'Native compatibility', roles: ['readable'] });
      const issued = await services.subjects.credential(actor, subject.subjectId);
      credentialMap.set(tenant, { apiSecret, subject: issued.token, subjectId: subject.subjectId });
    }
    let transport;
    async function snapshotData (tenant) {
      if (!config.tenants.includes(tenant)) refuse('CONSUMER_TENANT_UNKNOWN');
      const result = [];
      for (const domain of DOMAIN_NAMES) result.push({ domain, rows: (await admin.query(
        'SELECT * FROM ' + table(ns[domain], domain) + ' WHERE tenant_id=$1 ORDER BY id_kind,doc::text', [tenant])).rows });
      result.push({ domain: 'clock', rows: (await admin.query('SELECT last_stamp FROM ' + table(ns.clock, 'tenant_write_clock') + ' WHERE tenant_id=$1', [tenant])).rows });
      for (const domain of DOMAIN_NAMES) {
        const counter = ns[domain] + '.tenant_insertion_ordinal';
        if ((await admin.query('SELECT to_regclass($1) AS present', [counter])).rows[0].present) result.push({ domain: domain + '-ordinal',
          rows: (await admin.query('SELECT last_ordinal FROM ' + q(ns[domain]) + '.tenant_insertion_ordinal WHERE tenant_id=$1', [tenant])).rows });
      }
      return result;
    }
    const compatibility = { nativePersistence: 'postgres', oidcOff: true, defaultOffModes: ['multi'],
      dataPath: '/api/v3/entries', legacyDataPath: '/api/v1/entries.json',
      exchangePath: credential => '/api/v2/authorization/request/' + encodeURIComponent(credential),
      bindTransport (value) { if (typeof value !== 'function') refuse('CONSUMER_TRANSPORT_REQUIRED'); transport = value; },
      async request ({ plane = 'data', tenant = config.tenants[0], method = 'GET', path: route, headers = {}, body, oidcEnabled = true }) {
        if (plane !== 'data' || !config.tenants.includes(tenant) || typeof transport !== 'function') refuse('CONSUMER_DATA_REQUEST_REFUSED');
        const response = await transport(endpoints[tenant + '/' + oidcEnabled] + route, { method,
          headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      },
      async credentials ({ tenant = config.tenants[0], kind }) {
        if (!['apiSecret', 'subject'].includes(kind) || !credentialMap.has(tenant)) refuse('CONSUMER_CREDENTIAL_REQUEST_REFUSED');
        return credentialMap.get(tenant)[kind];
      }, snapshotData,
      anonymousAllows: (tenant, permission) => authority.authorize({ tenant, principal: { kind: 'anonymous' }, permission }),
      async setAnonymous (tenant, roles, { widenReadable = false } = {}) {
        if (!config.tenants.includes(tenant) || !Array.isArray(roles)) refuse('CONSUMER_ANONYMOUS_CONFIG_REFUSED');
        const saved = (await admin.query('SELECT anonymous_roles FROM ' + table(parsed.namespaces.authorization, 'tenant_authorization_config') + ' WHERE tenant_id=$1', [tenant])).rows[0];
        const readable = (await admin.query('SELECT permissions FROM ' + table(parsed.namespaces.authorization, 'tenant_authorization_roles') + " WHERE tenant_id=$1 AND name='readable'", [tenant])).rows[0];
        assert.ok(saved && readable, 'anonymous fixture must have exact current config and readable row');
        await bound(tenant, async client => {
          await client.query('UPDATE ' + table(parsed.namespaces.authorization, 'tenant_authorization_config') + ' SET anonymous_roles=$2 WHERE tenant_id=$1', [tenant, roles]);
          if (widenReadable) await client.query('UPDATE ' + table(parsed.namespaces.authorization, 'tenant_authorization_roles') + " SET permissions=ARRAY['*'] WHERE tenant_id=$1 AND name='readable'", [tenant]);
        });
        return () => bound(tenant, async client => {
          await client.query('UPDATE ' + table(parsed.namespaces.authorization, 'tenant_authorization_config') + ' SET anonymous_roles=$2 WHERE tenant_id=$1', [tenant, saved.anonymous_roles]);
          await client.query('UPDATE ' + table(parsed.namespaces.authorization, 'tenant_authorization_roles') + " SET permissions=$2 WHERE tenant_id=$1 AND name='readable'", [tenant, readable.permissions]);
        });
      }
    };
    async function runPinnedClient (tenant, credential, accepted) {
      const client = c.client, key = tenant + '/true', start = events[key].length;
      const cap = Math.min(client.maxMs, ctx.remainingActiveMs());
      if (!Number.isSafeInteger(cap) || cap < 1) refuse('CONSUMER_CLIENT_DEADLINE_EXHAUSTED');
      const spawn = require('node:child_process').spawn;
      const childEnv = { PATH: [...new Set(TOOLS.map(name => path.dirname(client.tools[name].path)))].join(path.delimiter),
        API_SECRET: 'token=' + credential, NIGHTSCOUT_HOST: endpoints[key], NIGHTSCOUT_FORMAT: client.tools.jq.path + ' .',
        CURL_CA_BUNDLE: env[client.caEnv], SSL_CERT_FILE: env[client.caEnv], LANG: 'C', LC_ALL: 'C' };
      const child = spawn(client.tools.bash.path, [path.join(client.root, 'bin/ns-get.sh'), 'entries.json'], {
        env: childEnv, cwd: client.root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let bytes = 0, output = '', timedOut = false;
      const abort = () => { if (child.exitCode === null && child.signalCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      } };
      const closed = new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('CONSUMER_CLIENT_PROCESS_FAILED')));
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) abort(); else output += chunk; });
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) abort(); });
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const owned = { abort, closed }; activeClients.add(owned);
      const timer = setTimeout(() => { timedOut = true; abort(); }, cap);
      try {
        await ctx.registerChild(child, { kind: 'client', label: 'oref0-ns-get', sourceCommit: OREF_COMMIT });
        const ended = await closed;
        if (timedOut || bytes > 262144) refuse('CONSUMER_CLIENT_BOUND_EXCEEDED');
        let value; try { value = JSON.parse(output); } catch { value = null; }
        assertClientObservation({ ...ended, closed: true, requests: events[key].slice(start), value },
          { accepted, id: 'native-a-sgv' });
      } finally { clearTimeout(timer); abort(); await closed.catch(() => {}); activeClients.delete(owned); }
    }
    async function exercise ({ transport: selectedTransport, ownerRequest }) {
      compatibility.bindTransport(selectedTransport);
      if (typeof ownerRequest !== 'function') refuse('CONSUMER_OWNER_HTTP_REQUIRED');
      const tenant = config.tenants[0], foreign = config.tenants[1];
      const before = await snapshotData(tenant), beforeB = await snapshotData(foreign);
      const root = await compatibility.credentials({ tenant, kind: 'apiSecret' });
      async function presentation (units, top, alarmHigh) {
        const reply = await compatibility.request({ tenant, path: '/api/v1/status.json', headers: { 'api-secret': root } });
        assert.equal(reply.status, 200); assert.equal(reply.body.settings.units, units);
        assert.equal(reply.body.settings.thresholds.bgTargetTop, top); assert.equal(reply.body.settings.alarmHigh, alarmHigh);
      }
      const settingsBefore = await ownerRequest('GET', '/api/v1/tenant/settings');
      assert.equal(settingsBefore.status, 200);
      const initialValues = { DISPLAY_UNITS: 'mg/dl', enable: ['bgnow', 'simplealarms'], alarmHigh: true,
        bgHigh: 260, bgTargetTop: 200, bgTargetBottom: 80, bgLow: 60 };
      const initial = await ownerRequest('PUT', '/api/v1/tenant/settings', { expectedVersion: settingsBefore.body.version, values: initialValues });
      assert.equal(initial.status, 200); await runtime.tick(tenant); assertEvaluation(runtime.last(tenant), { high: false });
      await presentation('mg/dl', 200, true);
      const fixedB = JSON.stringify(runtime.last(foreign));
      const changed = await ownerRequest('PUT', '/api/v1/tenant/settings', { expectedVersion: initial.body.version,
        values: { ...initialValues, DISPLAY_UNITS: 'mmol', bgTargetTop: 180 } });
      assert.equal(changed.status, 200); await runtime.tick(tenant);
      assertEvaluation(runtime.last(tenant), { high: true });
      await presentation('mmol', 180, true);
      const disabled = await ownerRequest('PUT', '/api/v1/tenant/settings', { expectedVersion: changed.body.version,
        values: { ...initialValues, DISPLAY_UNITS: 'mmol', bgTargetTop: 180, alarmHigh: false } });
      assert.equal(disabled.status, 200); await runtime.tick(tenant); assertEvaluation(runtime.last(tenant), { high: false });
      await presentation('mmol', 180, false);
      const rollback = await ownerRequest('POST', '/api/v1/tenant/settings/rollback', { expectedVersion: disabled.body.version, restoredFrom: changed.body.version });
      assert.equal(rollback.status, 200); await runtime.tick(tenant); assertEvaluation(runtime.last(tenant), { high: true });
      await presentation('mmol', 180, true);
      assert.equal(initial.body.version, settingsBefore.body.version + 1);
      assert.equal(changed.body.version, initial.body.version + 1);
      assert.equal(disabled.body.version, changed.body.version + 1);
      assert.equal(rollback.body.version, disabled.body.version + 1);
      const history = (await admin.query('SELECT version,values,operation,restored_from FROM ' +
        table(parsed.ownerSettings.namespaces.settings, 'tenant_settings_history') + ' WHERE tenant_id=$1 ORDER BY version', [tenant])).rows;
      assert.ok([initial, changed, disabled, rollback].every(reply =>
        history.some(row => row.version === reply.body.version)), 'independent native history includes every committed revision');
      const restored = history.find(row => row.version === rollback.body.version);
      assert.equal(restored.operation, 'rollback'); assert.equal(restored.restored_from, changed.body.version);
      assert.deepEqual(restored.values, history.find(row => row.version === changed.body.version).values);
      assert.equal(JSON.stringify(runtime.last(foreign)), fixedB, 'A next-cycle work leaves B evaluator output unchanged');
      assertClinical(before, await snapshotData(tenant), beforeB, await snapshotData(foreign));
      const roleName = 'consumer_' + config.nonce;
      assert.equal((await ownerRequest('POST', '/api/v2/authorization/roles', { name: roleName, permissions: ['api:entries:read', 'api:status:read'] })).status, 200);
      const made = await ownerRequest('POST', '/api/v2/authorization/subjects', { name: 'Synthetic journey reader', roles: [roleName] });
      assert.equal(made.status, 200);
      const issued = await ownerRequest('POST', '/api/v2/authorization/subjects/' + made.body.subjectId + '/credential', {});
      assert.equal(issued.status, 200);
      const credential = issued.body.token;
      const exchanged = await compatibility.request({ tenant, path: compatibility.exchangePath(credential) });
      assert.equal(exchanged.status, 200); assert.equal(exchanged.body.exp - exchanged.body.iat, 28800);
      assert.equal((await compatibility.request({ tenant, path: '/api/v3/entries', headers: { authorization: 'Bearer ' + exchanged.body.token } })).status, 200);
      await runPinnedClient(tenant, credential, true);
      const foreignReply = await compatibility.request({ tenant: foreign, path: '/api/v1/entries.json?token=' + encodeURIComponent(credential) });
      assert.ok([401, 403].includes(foreignReply.status)); await runPinnedClient(foreign, credential, false);
      const rolesTable = table(parsed.namespaces.authorization, 'tenant_authorization_roles');
      await admin.query('UPDATE ' + rolesTable + ' SET permissions=ARRAY[]::text[] WHERE tenant_id=$1 AND name=$2', [tenant, roleName]);
      try {
        const narrowed = await compatibility.request({ tenant, path: '/api/v1/entries.json?token=' + encodeURIComponent(credential) });
        assert.ok([401, 403].includes(narrowed.status), 'next DATA operation must read current role authority');
      } finally { await admin.query('UPDATE ' + rolesTable + ' SET permissions=$3 WHERE tenant_id=$1 AND name=$2',
        [tenant, roleName, ['api:entries:read', 'api:status:read']]); }
      assert.equal((await ownerRequest('DELETE', '/api/v2/authorization/subjects/' + made.body.subjectId)).status, 200);
      const revoked = await compatibility.request({ tenant, path: '/api/v1/entries.json?token=' + encodeURIComponent(credential) });
      assert.ok([401, 403].includes(revoked.status));
      const revokedJWT = await compatibility.request({ tenant, path: '/api/v3/entries', headers: { authorization: 'Bearer ' + exchanged.body.token } });
      assert.ok([401, 403].includes(revokedJWT.status)); await runPinnedClient(tenant, credential, false);
      assertClinical(before, await snapshotData(tenant), beforeB, await snapshotData(foreign));
      return { classification: requirements().classification, families: {
        ownerCreateRoleIssueRevoke: true, settingsVersionHistoryRollback: true, httpPresentation: true,
        evaluatorCycle: true, clinicalImmutability: true, tenantBImmutability: true, dataCredentialReplay: true,
        pinnedClientReplay: true, dataRevocation: true, foreignTenantRefusal: true }, presentationHTTP: true, evaluatorCycle: true,
        clinicalImmutability: true, foreignClinicalImmutability: true, dataCredentialReplay: true,
        pinnedClientReplay: true, dataAuthorityRevocation: true, dataCredentialRevocation: true, foreignCredentialRefusal: true };
    }
    return { dataApps, compatibility, exercise, close, manifest: { ...requirements(), schemas: created.map(record => ({ ...record })) } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new globalThis.AggregateError([error, cleanup], 'CONSUMER_SETUP_AND_CLOSE_FAILED'); }
    throw error;
  }
}

module.exports = { admit, create, requirements, assertClinical, assertEvaluation, assertClientObservation };
