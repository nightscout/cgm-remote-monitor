'use strict';

// Multitenant role configuration from the environment (decision
// config-few-dozen-env). A role builds the configuration value its loader's
// parse() validates from a handful of settings with documented defaults; there
// is no per-role JSON document. Secrets (database connection strings, Vault
// tokens) arrive as mounted files. Reference: docs/multitenant-settings.md.
//
// Every database name is `<NS_PG_PREFIX>_<kind>` (kinds below), byte-identical
// to the names the deployment's documents carried, so an existing database
// keeps its schemas. The bookkeeping identities (checkpoint consumers, token
// issuers, operator principals) keep the deployment's values for the same
// reason: checkpoint rows and their contract digests are keyed by them.
//
// Settings read here (defaults in SETTINGS):
//   NS_PG_PREFIX                       namespace prefix                       nsdemo
//   NS_SECRETS_DIR                     directory of mounted secret files      /run/ns-config
//   NS_VAULT_ADDR                      Vault origin (api, tenant-admin, admin provisioning and sessions, vcpool)
//   NS_VAULT_ALLOW_INSECURE_LOOPBACK   true admits http:// to a loopback Vault false
//   NS_TENANT_RESOLUTION               direct-alias | canonical-internal      direct-alias
//   NS_TRUSTED_PEERS                   comma list of IPs (canonical-internal)
//   NS_REGISTRY_REFRESH_MS             registry refresh                       2000
//   NS_REGISTRY_MAX_TENANTS            registry working-set bound             10000
//   NS_OWNER_CATALOGUE                 comma list, owner/root ceiling         *
//   NS_PGSTREAM_RECEIVER_URL           this evaluator's intake receiver       http://evaluator:19913/
//   NS_PGSTREAM_RECEIVER_BIND_HOST     its bind address                       0.0.0.0
//   NS_EVALUATOR_SLICES                evaluator K; the ordinal is the hostname's trailing
//                                      number and receiver i is <base>-<i>.<base> on the
//                                      receiver port (lib/pgstream/assigned-worker.js)  1
//   NS_INPUT_TRANSPORT                 pgstream | writer-driven (lib/writer-driven) pgstream
//   NS_EVALUATOR_SWEEP_MS              writer-driven pending sweep interval   5000
//   NS_PGSTREAM_GENERATION             stream incarnation, 32 hex characters (evaluator; seeded
//                                      once per stream, rotated by a destructive wipe)
//   NS_VCPOOL_API_URL, NS_VCPOOL_ALLOW_HOSTS (comma list), NS_VCPOOL_ALLOW_INSECURE_HTTP (false)
//
// A secret NAME (for example NS_API_PG) is read from the environment variable
// NAME, else from the file named by NAME_FILE, else from
// <NS_SECRETS_DIR>/<name in lower case> when that file exists. The Vault token
// is <NS_SECRETS_DIR>/vault-token (admin's management signer:
// management-vault-token; vcpool: vcpool-token) unless NS_VAULT_TOKEN is set.

const fs = require('node:fs');
const path = require('node:path');
const { privateSource } = require('../../human-session/private-setting');
const { PreviewConfigError } = require('./preview-config-error');

const CLINICAL = Object.freeze(['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity']);
// Namespace kinds, in the deployment's layout order.
const KINDS = Object.freeze([...CLINICAL, 'settings', 'authorization', 'secrets', 'legacy', 'access', 'clock',
  'rt_checkpoint', 'eval_checkpoint', 'alarm', 'outbox', 'control', 'registry', 'display_settings', 'operator_policy',
  'human_session', 'subject_policy', 'owner_configuration']);
// Bookkeeping identities kept from the deployment's documents (see header).
const IDENTITY = Object.freeze({
  evaluatorConsumer: 'evaluator-compose-demo', realtimeConsumer: 'realtime-compose-demo',
  accessIssuer: 'nightscout-compose-demo', accessAudience: 'nightscout-data',
  managementIssuer: 'nightscout-compose-management', managementAudience: 'nightscout-management', managementConsumer: 'compose-owner',
  operator: 'compose-operator', management: 'compose-management', ownership: 'compose-ownership', connectors: 'compose-connectors',
  provisioning: 'compose-provisioning'
});
const SETTINGS = Object.freeze({
  NS_PG_PREFIX: 'nsdemo', NS_SECRETS_DIR: '/run/ns-config', NS_VAULT_ALLOW_INSECURE_LOOPBACK: 'false',
  NS_TENANT_RESOLUTION: 'direct-alias', NS_REGISTRY_REFRESH_MS: '2000', NS_REGISTRY_MAX_TENANTS: '10000', NS_OWNER_CATALOGUE: '*',
  NS_PGSTREAM_RECEIVER_URL: 'http://evaluator:19913/', NS_PGSTREAM_RECEIVER_BIND_HOST: '0.0.0.0',
  NS_VCPOOL_ALLOW_INSECURE_HTTP: 'false'
});
// Every secret a role may read, by role.
const SECRETS = Object.freeze({
  api: ['NS_API_PG', 'NS_READINESS_PG', 'NS_API_ROOT_WRITER_PG', 'NS_ALARM_PG', 'NS_DISPLAY_PG'],
  realtime: ['NS_REALTIME_PG', 'NS_DISPLAY_PG'],
  evaluator: ['NS_EVALUATOR_PG', 'NS_OUTBOX_PG', 'NS_SUPPRESSION_PG', 'NS_DISPLAY_PG', 'NS_ACTIVITY_PG', 'NS_STREAM_RECOVERY_PG'],
  'tenant-admin': ['NS_OWNER_WRITER_PG', 'NS_OWNER_READER_PG', 'NS_OWNER_CREDENTIALS_PG', 'NS_OWNER_SETTINGS_PG'],
  admin: ['NS_PROVISIONER_PG', 'NS_OWNERSHIP_PG', 'NS_CONNECTOR_SOURCES_PG', 'NS_MANAGEMENT_SESSIONS_PG'],
  vcpool: ['NS_VCPOOL_SECRETS_PG', 'NS_VCPOOL_ACTIVITY_PG', 'NS_VCPOOL_DEFINITIONS_PG'],
  operation: ['NS_LIFETIME_PG']
});
const ALL_SECRETS = Object.freeze([...new Set(Object.values(SECRETS).flat())]);

const refuse = message => { throw new PreviewConfigError('deployment settings: ' + message); };
const setting = (source, name) => {
  const value = source?.[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : SETTINGS[name];
};
function integerSetting (source, name, min, max) {
  const raw = setting(source, name);
  if (!/^[0-9]{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) refuse(name + ' must be a whole number from ' + min + ' to ' + max);
  return Number(raw);
}
const list = raw => raw === undefined ? [] : raw.split(',').map(item => item.trim()).filter(Boolean);
function flag (source, name) {
  const raw = setting(source, name);
  if (!['true', 'false'].includes(raw)) refuse(name + ' must be true or false');
  return raw === 'true';
}

function prefix (source) {
  const value = setting(source, 'NS_PG_PREFIX');
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(value) || value.startsWith('pg_')) refuse('NS_PG_PREFIX must be a lower-case SQL name of at most 24 characters');
  return value;
}
// The namespace of each kind, the Vault transit mount and the stream identities.
function layout (source) {
  const p = prefix(source);
  return Object.freeze({ prefix: p, namespaces: Object.freeze(Object.fromEntries(KINDS.map(kind => [kind, p + '_' + kind]))),
    mount: p + '_transit', slot: p + '_pgstream', streamRole: p + '_pgstream' });
}

// The secret NAME: inline, NAME_FILE, or <NS_SECRETS_DIR>/<name>.
function secret (source, name) {
  const found = privateSource(source, name);
  if (found.value !== undefined) return found.value.trim();
  const file = path.join(setting(source, 'NS_SECRETS_DIR'), name.toLowerCase());
  // A fixed name under the operator's secrets directory; no request selects it.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!fs.existsSync(file)) return undefined;
  return privateSource({ [name + '_FILE']: file }, name).value.trim();
}
// `source` with every secret it names resolved, for the loaders' existing
// environment references. The process environment is not changed.
function withSecrets (source) {
  const resolved = { ...source };
  for (const name of ALL_SECRETS) {
    const value = secret(source, name);
    if (value !== undefined) {
      resolved[name] = value;
      // A nested loader receives the resolved setting as its single source.
      delete resolved[name + '_FILE'];
    }
  }
  return resolved;
}

function vault (source, l, file, timeoutMs) {
  const address = setting(source, 'NS_VAULT_ADDR');
  if (!address) refuse('NS_VAULT_ADDR is required');
  const inline = setting(source, 'NS_VAULT_TOKEN');
  const sink = setting(source, 'NS_VAULT_TOKEN_FILE');
  if (inline && sink) refuse('choose one Vault token source');
  const token = inline ? { tokenEnv: 'NS_VAULT_TOKEN' }
    : { tokenFile: sink || path.join(setting(source, 'NS_SECRETS_DIR'), file) };
  return { address, mount: l.mount, timeoutMs, ...token,
    ...(flag(source, 'NS_VAULT_ALLOW_INSECURE_LOOPBACK') ? { allowInsecureLoopback: true } : {}) };
}
function resolution (source) {
  const mode = setting(source, 'NS_TENANT_RESOLUTION');
  return mode === 'canonical-internal' ? { mode, trustedPeers: list(source.NS_TRUSTED_PEERS) } : { mode };
}
function registry (source, l) {
  const maxTenants = integerSetting(source, 'NS_REGISTRY_MAX_TENANTS', 1, Number.MAX_SAFE_INTEGER);
  return { namespace: l.namespaces.registry, refreshMs: integerSetting(source, 'NS_REGISTRY_REFRESH_MS', 1, 3600000),
    ...(maxTenants === 10000 ? {} : { maxTenants }) };
}
const ownerCatalogue = source => list(setting(source, 'NS_OWNER_CATALOGUE'));
const tenantSettings = l => ({ connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: l.namespaces.display_settings, operatorPolicy: l.namespaces.operator_policy } });
const trustedWorker = l => ({ activity: l.namespaces.control, clock: l.namespaces.clock, settings: l.namespaces.display_settings, operatorPolicy: l.namespaces.operator_policy });
const pick = (l, kinds) => Object.fromEntries(kinds.map(kind => [kind, l.namespaces[kind]]));

function api (source) {
  const l = layout(source);
  return { version: 1, domains: [...CLINICAL, 'settings'], legacy: true, context: true, writeClock: true,
    subjectAdmin: { writerConnectionEnv: 'NS_API_ROOT_WRITER_PG', ownerPolicy: { catalogue: ownerCatalogue(source) } },
    postgres: { connectionEnv: 'NS_API_PG', readinessConnectionEnv: 'NS_READINESS_PG',
      namespaces: pick(l, [...CLINICAL, 'settings', 'authorization', 'secrets', 'legacy', 'access', 'clock']) },
    vault: vault(source, l, 'vault-token', 5000), resolution: resolution(source),
    accessTokens: { issuer: IDENTITY.accessIssuer, audience: IDENTITY.accessAudience },
    socketForwarding: { maxTenants: 10000, maxMessageBytes: 1048576, operationTimeoutMs: 5000,
      alarm: { connectionEnv: 'NS_ALARM_PG', namespace: l.namespaces.alarm }, consumerState: {} },
    registry: registry(source, l), tenantSettings: tenantSettings(l), activity: { namespace: l.namespaces.control },
    localDataAuthentication: 'node', ...(writerDriven(source) ? { writerDriven: { pending: pendingBinding(l) } } : {}) };
}
// Writer-driven input (NS_INPUT_TRANSPORT): the evaluator's completed-work row
// that every supported writer marks pending in its own transaction.
const writerDriven = source => { try { return require('../../writer-driven').selection(source) === 'writer-driven'; } catch (error) { refuse(error.message); } };
const pendingBinding = l => ({ namespace: l.namespaces.eval_checkpoint, consumer: IDENTITY.evaluatorConsumer + '-completed' });
function realtime (source) {
  const l = layout(source);
  return { version: 1, postgres: { connectionEnv: 'NS_REALTIME_PG', namespaces: { clock: l.namespaces.clock, checkpoint: l.namespaces.rt_checkpoint } },
    consumer: IDENTITY.realtimeConsumer, maxRows: 10000, maxBytes: 8388608, maxMessageBytes: 1048576, operationTimeoutMs: 5000,
    authorizationRecheckMs: 30000, registry: registry(source, l), tenantSettings: tenantSettings(l), activity: { namespace: l.namespaces.control },
    trustedWorker: trustedWorker(l), completedOutput: { namespace: l.namespaces.eval_checkpoint, consumer: IDENTITY.evaluatorConsumer } };
}
// The evaluator's configuration. `metadata` is the api's read-only view of it
// (notification outbox and suppression), where the datastore is the database
// the api's alarm identity reaches.
function evaluator (source, { metadata = false } = {}) {
  const l = layout(source);
  const datastoreURL = source[metadata ? 'NS_ALARM_PG' : 'NS_EVALUATOR_PG'];
  const writer = !metadata && writerDriven(source);
  const generation = metadata || writer ? undefined : secret(source, 'NS_PGSTREAM_GENERATION');
  let datastore;
  if (typeof datastoreURL === 'string' && datastoreURL) {
    let url;
    try { url = new URL(datastoreURL); } catch { refuse('the evaluator datastore connection is not a URL'); }
    datastore = { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432), database: decodeURIComponent(url.pathname.slice(1)) };
  }
  return { version: 1, ...(datastore ? { datastore } : {}),
    postgres: { connectionEnv: 'NS_EVALUATOR_PG', namespaces: { ...pick(l, CLINICAL), clock: l.namespaces.clock, checkpoint: l.namespaces.eval_checkpoint } },
    consumer: IDENTITY.evaluatorConsumer, pageSize: 100, maxRows: 10000, maxBytes: 8388608, timeIntervalMs: 60000,
    socketOrderDomains: ['treatments', 'devicestatus', 'profile'],
    consumers: { realtime: { outbox: { connectionEnv: 'NS_OUTBOX_PG', namespace: l.namespaces.outbox, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      suppression: { connectionEnv: 'NS_SUPPRESSION_PG', namespace: l.namespaces.alarm, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      route: { id: IDENTITY.realtimeConsumer, maxMessageBytes: 1048576, operationTimeoutMs: 5000 },
      maxPayloadBytes: 524288, maxInflight: 4, attemptTimeoutMs: 10000, retryDelayMs: 1000, pollIntervalMs: 1000, retryIntervalMs: 1000 } },
    registry: registry(source, l), tenantSettings: tenantSettings(l), activity: { connectionEnv: 'NS_ACTIVITY_PG', namespace: l.namespaces.control },
    trustedWorker: trustedWorker(l),
    // Writer-driven input keeps the receiver shape (its port names the slice
    // receivers, its bounds the clinical deadlines) and drops the stream source.
    pgstream: { receiver: { url: setting(source, 'NS_PGSTREAM_RECEIVER_URL'), trust: 'network', bindHost: setting(source, 'NS_PGSTREAM_RECEIVER_BIND_HOST'),
      maxBytes: 16777216, timeoutMs: 5000 }, transactionRows: 10000, slot: l.slot, streamRole: l.streamRole,
    ...(generation ? { generation } : {}),
    ...(writer ? {} : { startupTransport: { timeoutMs: 300000, retryIntervalMs: 50 },
      recovery: { connectionEnv: 'NS_STREAM_RECOVERY_PG', timeoutMs: 5000, maxQueued: 32 } }),
    bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 } },
    ...(writer ? { writerDriven: { sweepMs: require('../../writer-driven').sweepMs(source), lifecycleNamespace: l.namespaces.control } } : {}) };
}
function tenantAdmin (source) {
  const l = layout(source);
  return { version: 1, postgres: { writerConnectionEnv: 'NS_OWNER_WRITER_PG', accessConnectionEnv: 'NS_OWNER_READER_PG',
    namespaces: { authorization: l.namespaces.authorization, credentials: l.namespaces.legacy, access: l.namespaces.access } },
  ownerPolicy: { catalogue: ownerCatalogue(source) }, resolution: resolution(source),
  management: { issuer: IDENTITY.managementIssuer, audience: IDENTITY.managementAudience, purpose: 'management', consumer: IDENTITY.managementConsumer, maxLifetimeSeconds: 600 },
  registry: registry(source, l),
  ...(source.NS_OWNER_SETTINGS_PG ? { ownerSettings: { connectionEnv: 'NS_OWNER_SETTINGS_PG',
    namespaces: { settings: l.namespaces.display_settings, operatorPolicy: l.namespaces.operator_policy, authority: l.namespaces.owner_configuration } },
    ...(writerDriven(source) ? { writerDriven: { pending: pendingBinding(l) } } : {}) } : {}),
  ownerCredentials: { connectionEnv: 'NS_OWNER_CREDENTIALS_PG', namespace: l.namespaces.secrets, vault: vault(source, l, 'vault-token', 5000) } };
}
// The provisioning checkpoints: the three consumer rows a new tenant is created
// with, and their contract digests, computed from the same modules that check them.
function checkpoints (l) {
  const ns = l.namespaces, evaluated = evaluator({}, {}), consumer = IDENTITY.evaluatorConsumer;
  const replay = require('../../storage/postgres-durable-replay')({ connection: { query () { throw new Error('CONSTRUCTOR_ONLY'); },
    snapshotTransaction () { throw new Error('CONSTRUCTOR_ONLY'); } }, checkpointTable: ns.eval_checkpoint + '.tenant_consumer_checkpoint',
  clockTable: ns.clock + '.tenant_write_clock', consumer, domains: Object.fromEntries(CLINICAL.map(name => [name, ns[name] + '.' + name])),
  projectionVersion: 'clinical-current-rows-v1', pageSize: evaluated.pageSize, maxRows: evaluated.maxRows });
  return [{ namespace: ns.rt_checkpoint, consumer: IDENTITY.realtimeConsumer,
    digest: require('../../pgstream/realtime-receipt').contractDigest(ns.rt_checkpoint, IDENTITY.realtimeConsumer) },
  { namespace: ns.eval_checkpoint, consumer, digest: replay.digest },
  { namespace: ns.eval_checkpoint, consumer: consumer + '-completed', digest: nativeSelection(l).contractDigest }];
}
// Each admin service is composed when this process has its connection secret.
function admin (source) {
  const l = layout(source), ns = l.namespaces, operator = consumer => ({ principal: IDENTITY.operator, consumer });
  const has = name => typeof source[name] === 'string' && source[name] !== '';
  return { version: 1, maxBytes: 1048576, timeoutMs: 60000,
    ...(has('NS_MANAGEMENT_SESSIONS_PG') ? { managementSessions: { connectionEnv: 'NS_MANAGEMENT_SESSIONS_PG', namespaces: pick(l, ['registry', 'authorization', 'access', 'control']),
      issuer: IDENTITY.managementIssuer, audience: IDENTITY.managementAudience, consumer: IDENTITY.managementConsumer, maxLifetimeSeconds: 600,
      vault: vault(source, l, 'management-vault-token', 10000), operator: operator(IDENTITY.management) } } : {}),
    ...(has('NS_OWNERSHIP_PG') ? { ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: ns.authorization, lifecycleNamespace: ns.control, configurationNamespace: ns.owner_configuration,
      registry: registry(source, l), operator: operator(IDENTITY.ownership) } } : {}),
    ...(has('NS_CONNECTOR_SOURCES_PG') ? { connectorSources: { connectionEnv: 'NS_CONNECTOR_SOURCES_PG',
      namespaces: { settings: ns.display_settings, registry: ns.registry, secrets: ns.secrets, control: ns.control }, operator: operator(IDENTITY.connectors) } } : {}),
    ...(has('NS_PROVISIONER_PG') ? { provisioning: { connectionEnv: 'NS_PROVISIONER_PG', namespaces: require('../ordinary-deployment-grants').provisioningNamespaces(ns),
      checkpoints: checkpoints(l), vault: vault(source, l, 'vault-token', 10000), ownerPolicy: { catalogue: ownerCatalogue(source) },
      // In both input transports (coordinator 2026-11-20): admin needs no transport setting.
      pendingConsumer: pendingBinding(l),
      operator: operator(IDENTITY.provisioning) } } : {}) };
}
function vcpool (source) {
  const l = layout(source), ns = l.namespaces, url = setting(source, 'NS_VCPOOL_API_URL'), hosts = list(source.NS_VCPOOL_ALLOW_HOSTS);
  if (!url) refuse('NS_VCPOOL_API_URL is required');
  if (!hosts.length) refuse('NS_VCPOOL_ALLOW_HOSTS is required');
  return { version: 1, api: { url }, postgres: { connectionEnv: 'NS_VCPOOL_SECRETS_PG', namespaces: { secrets: ns.secrets } },
    vault: vault(source, l, 'vcpool-token', 5000), activity: { connectionEnv: 'NS_VCPOOL_ACTIVITY_PG', namespace: ns.control },
    registry: registry(source, l), definitions: { connectionEnv: 'NS_VCPOOL_DEFINITIONS_PG',
      namespaces: { settings: ns.display_settings, registry: ns.registry, secrets: ns.secrets, control: ns.control } },
    sources: { allowHosts: hosts, allowInsecureHttp: flag(source, 'NS_VCPOOL_ALLOW_INSECURE_HTTP') } };
}
// The native lifecycle selection: the evaluator checkpoint namespace and
// consumer the lifecycle control namespace serves. It names no database
// identity (decision stream-source-identity-in-data).
function nativeSelection (l) {
  const native = require('../../tenant-lifecycle/native-selection');
  return native.create({ namespace: l.namespaces.eval_checkpoint, lifecycleNamespace: l.namespaces.control, consumer: IDENTITY.evaluatorConsumer });
}
// The operation lease: present when this process has the lifetime identity.
function operation (source) {
  if (typeof source.NS_LIFETIME_PG !== 'string' || !source.NS_LIFETIME_PG) return null;
  const l = layout(source);
  return { namespace: l.namespaces.control, connectionEnv: 'NS_LIFETIME_PG', registry: { namespace: l.namespaces.registry },
    nativeSelection: nativeSelection(l) };
}

const BUILDERS = Object.freeze({ api, realtime, evaluator, 'tenant-admin': tenantAdmin, admin, vcpool });
// The configuration value role `role` parses.
function configuration (role, source) {
  if (!Object.hasOwn(BUILDERS, role)) throw new TypeError('Unknown multitenant role ' + role);
  return BUILDERS[role](source);
}

module.exports = { KINDS, IDENTITY, SETTINGS, SECRETS, layout, secret, withSecrets, configuration, evaluator, operation, nativeSelection, checkpoints };
