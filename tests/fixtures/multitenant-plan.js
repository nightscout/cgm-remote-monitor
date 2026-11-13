'use strict';

// The test plan: a small registry-mode deployment plan for core's own tests
// (decisions core-static-plan-retired and deployment-plan-contract). The one
// deployment plan is nightscout-deploy's; this one exists so core can test the
// contract it publishes (lib/server/serve/plan-contract) and give its
// integration suites a database layout with the plan's grants. Synthetic only.
// No database, network or filesystem I/O.
//
//   layout(prefix)       namespaces, database identities and the Vault mount, by name
//   catalogues()         the catalogue each namespace is migrated with
//   grants(layout)       the SQL grants of every identity
//   lifecycle(layout)    the restore driver's catalogue list
//   documents(options)   every role's configuration document, environment and
//                        operation manifest, in registry mode: no tenant list,
//                        no per-tenant key, no lock list
//   documentSet(docs)    those documents as `nightscout plan check` takes them
const { createHash } = require('node:crypto');
const base = require('../../deploy/multitenant/config');
const { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle } = base;

const CONFIG_DIRECTORY = '/run/ns-config', SOCKET_DIRECTORY = '/run/ns-ipc';
const CONFIG_ENV = { api: 'MULTITENANT_PREVIEW_CONFIG', realtime: 'MULTITENANT_REALTIME_CONFIG', evaluator: 'MULTITENANT_EVALUATOR_CONFIG',
  'tenant-admin': 'MULTITENANT_OWNER_PREVIEW_CONFIG' };
// Identities a registry-mode deployment adds to the layout's; a suite that only
// needs the participant manifest passes no connection address for them.
const REGISTRY_IDENTITIES = ['display_reader', 'activity_reader', 'feed_reader', 'feed_listener', 'provisioner', 'management_issuer', 'connector_writer'];

function documents ({ layout: l, urls = {}, vaultAddress = 'https://vault.example.test:8200' }) {
  const ns = l.namespaces, named = name => l.prefix + '_' + name;
  // Registry-mode namespaces. The suites that load this plan do not migrate
  // them; the documents only name them.
  const registry = { namespace: named('registry'), maxTenants: 10000, refreshMs: 2000 };
  const tenantSettings = { connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: named('display_settings'), operatorPolicy: named('operator_policy') } };
  const activity = { connectionEnv: 'NS_ACTIVITY_PG', namespace: ns.control };
  const changeFeed = { connectionEnv: 'NS_FEED_LISTENER_PG', channel: named('changes'), pageSize: 256, degradedPages: 4, intervalMs: 1000, heartbeatTimeoutMs: 5000 };
  const vault = file => ({ address: vaultAddress, mount: l.mount, timeoutMs: 5000, tokenFile: CONFIG_DIRECTORY + '/' + file });
  const domainNamespaces = Object.fromEntries(clinical.map(name => [name, ns[name]]));
  const limits = { pageSize: 100, maxRows: 10000, maxBytes: 8388608, maxTenants: 10000, recoveryIntervalMs: 1000 };
  const datastore = urls.evaluator ? (address => ({ hostname: address.hostname, port: Number(address.port || 5432), database: decodeURIComponent(address.pathname.slice(1)) }))(new URL(urls.evaluator)) : undefined;
  const evaluator = { version: 1, ...(datastore ? { datastore } : {}),
    postgres: { connectionEnv: 'NS_EVALUATOR_PG', namespaces: { ...domainNamespaces, clock: ns.clock, checkpoint: ns.eval_checkpoint, changeStamps: ns.change_stamps } },
    consumer: 'evaluator-test-plan', ...limits, timeIntervalMs: 1000, socketOrderDomains: ['treatments', 'devicestatus', 'profile'],
    consumers: { realtime: { outbox: { connectionEnv: 'NS_OUTBOX_PG', namespace: ns.outbox, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      suppression: { connectionEnv: 'NS_SUPPRESSION_PG', namespace: ns.alarm, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      route: { id: 'realtime-test-plan', maxMessageBytes: 1048576, operationTimeoutMs: 5000 },
      maxPayloadBytes: 524288, maxInflight: 4, attemptTimeoutMs: 10000, retryDelayMs: 1000, pollIntervalMs: 1000, retryIntervalMs: 1000 } },
    registry: { ...registry }, tenantSettings, activity, changeFeed };
  const realtime = { version: 1, postgres: { connectionEnv: 'NS_REALTIME_PG', namespaces: { ...domainNamespaces, clock: ns.clock, checkpoint: ns.rt_checkpoint, changeStamps: ns.change_stamps } },
    consumer: 'realtime-test-plan', ...limits, socketOrderDomains: ['treatments', 'devicestatus', 'profile'],
    maxMessageBytes: 1048576, operationTimeoutMs: 5000, authorizationRecheckMs: 30000,
    registry: { ...registry }, tenantSettings, activity, changeFeed };
  // Decision root-grant-ceiling-default-all: every tenant data permission unless
  // the operator narrows it. Owner and root share this catalogue (one policy row).
  const api = { version: 1, domains: [...clinical, 'settings'], legacy: true, context: true, writeClock: true,
    subjectAdmin: { writerConnectionEnv: 'NS_API_ROOT_WRITER_PG', ownerPolicy: { catalogue: ['*'] } },
    postgres: { connectionEnv: 'NS_API_PG', readinessConnectionEnv: 'NS_READINESS_PG',
      namespaces: { ...domainNamespaces, settings: ns.settings, authorization: ns.authorization, secrets: ns.secrets, legacy: ns.legacy, access: ns.access, clock: ns.clock } },
    vault: vault('vault-token'), resolution: { mode: 'direct-alias' }, registry: { ...registry }, tenantSettings, activity,
    accessTokens: { issuer: 'nightscout-test-plan', audience: 'nightscout-data' },
    socketForwarding: { maxTenants: 10000, maxMessageBytes: 1048576, operationTimeoutMs: 5000,
      alarm: { connectionEnv: 'NS_ALARM_PG', namespace: ns.alarm }, consumerState: { evaluatorConfigEnv: 'MULTITENANT_EVALUATOR_CONFIG' } } };
  const owner = { version: 1, postgres: { writerConnectionEnv: 'NS_OWNER_WRITER_PG', accessConnectionEnv: 'NS_OWNER_READER_PG',
    namespaces: { authorization: ns.authorization, credentials: ns.legacy, access: ns.access } },
    ownerPolicy: { catalogue: ['*'] }, resolution: { mode: 'direct-alias' }, registry: { ...registry },
    management: { issuer: 'nightscout-test-plan-management', audience: 'nightscout-management', purpose: 'management', consumer: 'test-plan-owner', maxLifetimeSeconds: 600 } };
  const configs = { api, realtime, evaluator, 'tenant-admin': owner };
  // serve.internal: one socket per role process on the shared private
  // directory; every peer address names the same paths.
  const socketOf = role => SOCKET_DIRECTORY + '/' + role + '.sock';
  const envName = require('../../lib/server/internal-api/listener-config').envName;
  const file = name => CONFIG_DIRECTORY + '/' + name;
  const common = Object.fromEntries(serviceRoles.map(role => [envName(role) + 'SOCKET', socketOf(role)]));
  const readers = { NS_DISPLAY_PG: urls.display_reader, NS_ACTIVITY_PG: urls.activity_reader };
  const environments = {
    api: { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('api'), API_HOSTNAME: '0.0.0.0', API_PORT: '1337', MULTITENANT_PREVIEW_CONFIG: file('config.json'),
      MULTITENANT_EVALUATOR_CONFIG: file('evaluator-metadata.json'), NS_API_PG: urls.api, NS_READINESS_PG: urls.readiness, NS_API_ROOT_WRITER_PG: urls.root_writer, NS_ALARM_PG: urls.alarm, ...readers },
    realtime: { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('realtime'), REALTIME_HOSTNAME: '0.0.0.0', REALTIME_PORT: '1339', MULTITENANT_REALTIME_CONFIG: file('config.json'),
      NS_REALTIME_PG: urls.realtime, NS_FEED_LISTENER_PG: urls.feed_listener, ...readers },
    evaluator: { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('evaluator'), MULTITENANT_EVALUATOR_CONFIG: file('config.json'), NS_EVALUATOR_PG: urls.evaluator,
      NS_OUTBOX_PG: urls.outbox, NS_SUPPRESSION_PG: urls.suppression, NS_FEED_LISTENER_PG: urls.feed_listener, ...readers },
    'tenant-admin': { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('tenant-admin'), TENANT_ADMIN_HOSTNAME: '0.0.0.0', TENANT_ADMIN_PORT: '1341',
      MULTITENANT_OWNER_PREVIEW_CONFIG: file('config.json'), NS_OWNER_WRITER_PG: urls.owner_writer, NS_OWNER_READER_PG: urls.owner_reader } };
  // The participant manifest: each role's protected namespaces as the role
  // process computes them (the api also protects the notification outbox it
  // reads through the evaluator's metadata), the control namespace excluded.
  const protectedNamespaces = require('../../lib/server/serve/operation-cohort').protectedNamespaces;
  const participants = serviceRoles.map(role => ({ id: role, roles: [role],
    namespaces: [...new Set([...protectedNamespaces(configs[role]), ...(role === 'api' ? [ns.outbox] : [])])].filter(name => name !== ns.control).sort(),
    maxMessageBytes: 1048576, timeoutMs: 5000 }));
  const operations = {};
  for (const role of serviceRoles) {
    operations[role] = { version: 2, namespace: ns.control, connectionEnv: 'NS_LIFETIME_PG', registry: { namespace: registry.namespace }, participantId: role, participants };
    Object.assign(environments[role], { NS_LIFETIME_PG: urls['lifetime_' + role.replace('-', '_')], MULTITENANT_OPERATION_CONFIG: file('operation.json') });
  }
  const remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
    endpoint: { socketPath: socketOf(peer.id), maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
  // Lock keys follow the tenant-id rule, as the registry's do.
  const locks = [A, B].map(tenant => ({ tenant, key: require('../../lib/tenant-registry/rules').lockKey(tenant) }));
  const feed = { config: { connectionEnv: 'NS_FEED_PG', namespace: named('feed'), clockNamespace: ns.clock, activityNamespace: ns.control,
    settingsNamespace: tenantSettings.namespaces.settings, policyNamespace: tenantSettings.namespaces.operatorPolicy,
    slot: named('feed_slot'), publication: named('feed_publication'), owner: named('feed_owner'), channel: changeFeed.channel,
    pollMs: 50, heartbeatMs: 1000, targetChanges: 128, maxMessages: 10000, maxBytes: 1048576, statementTimeoutMs: 2000, rssRefuseBytes: 268435456 },
    environment: { MULTITENANT_FEED_CONFIG: file('config.json'), NS_FEED_PG: urls.feed_reader } };
  const operator = consumer => ({ principal: 'test-plan-operator', consumer });
  const digest = consumer => createHash('sha256').update(consumer).digest('hex');
  const admin = { config: { version: 1, maxBytes: 1048576, timeoutMs: 60000,
    managementSessions: { connectionEnv: 'NS_MANAGEMENT_SESSIONS_PG',
      namespaces: { registry: registry.namespace, authorization: ns.authorization, access: ns.access, control: ns.control },
      issuer: owner.management.issuer, audience: owner.management.audience, consumer: owner.management.consumer, maxLifetimeSeconds: 600,
      vault: { ...vault('management-vault-token'), timeoutMs: 10000 }, operator: operator('test-plan-management') },
    ownership: { connectionEnv: 'NS_OWNERSHIP_PG', namespace: ns.authorization, lifecycleNamespace: ns.control, registry: { ...registry }, operator: operator('test-plan-ownership') },
    connectorSources: { connectionEnv: 'NS_CONNECTOR_SOURCES_PG',
      namespaces: { settings: tenantSettings.namespaces.settings, registry: registry.namespace, secrets: ns.secrets, control: ns.control }, operator: operator('test-plan-connectors') },
    provisioning: { connectionEnv: 'NS_PROVISIONER_PG',
      namespaces: { registry: registry.namespace, legacy: ns.legacy, secrets: ns.secrets, authorization: ns.authorization, access: ns.access, clock: ns.clock,
        control: ns.control, settings: tenantSettings.namespaces.settings, operatorPolicy: tenantSettings.namespaces.operatorPolicy },
      checkpoints: [{ namespace: ns.rt_checkpoint, consumer: realtime.consumer, digest: digest(realtime.consumer) },
        { namespace: ns.eval_checkpoint, consumer: evaluator.consumer, digest: digest(evaluator.consumer) }],
      vault: { ...vault('vault-token'), timeoutMs: 10000 }, ownerPolicy: { catalogue: ['*'] }, operator: operator('test-plan-provisioning') } },
    environment: { ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: '1342', MULTITENANT_ADMIN_CONFIG: file('config.json'), NS_PROVISIONER_PG: urls.provisioner,
      NS_OWNERSHIP_PG: urls.ownership_operator, NS_CONNECTOR_SOURCES_PG: urls.connector_writer, NS_MANAGEMENT_SESSIONS_PG: urls.management_issuer } };
  return { configs, environments, operations, remote, locks, feed, admin };
}

// One process per role, each with the files its environment names.
function documentSet (docs) {
  const file = name => CONFIG_DIRECTORY + '/' + name;
  const processes = serviceRoles.map(role => ({ name: role, roles: [role], environment: docs.environments[role],
    files: { [docs.environments[role][CONFIG_ENV[role]]]: docs.configs[role], [file('operation.json')]: docs.operations[role],
      ...(role === 'api' ? { [file('evaluator-metadata.json')]: docs.configs.evaluator } : {}) } }));
  processes.push({ name: 'feed-reader', roles: ['feed-reader'], environment: docs.feed.environment, files: { [file('config.json')]: docs.feed.config } });
  processes.push({ name: 'admin', roles: ['admin'], environment: docs.admin.environment, files: { [file('config.json')]: docs.admin.config } });
  return { contract: 1, processes };
}

// Synthetic connection addresses for every identity the documents name.
function syntheticUrls (l) {
  return Object.fromEntries([...Object.keys(l.roles), ...REGISTRY_IDENTITIES].map(kind =>
    [kind, 'postgres://' + (l.roles[kind] || l.prefix + '_' + kind) + ':synthetic@postgres.example.test:5432/nightscout_test_plan']));
}

module.exports = { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle, documents, documentSet, syntheticUrls };
