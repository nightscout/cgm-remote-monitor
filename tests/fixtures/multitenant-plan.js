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
//                        no per-tenant key, no lock list. `variant: 'full'`
//                        sets every optional field the contract names and a
//                        fixed roster (two api instances, a named realtime
//                        worker), so each field's type meets its loader;
//                        its Vault credentials are environment references,
//                        and `full-token-files` is the same with token files.
//                        `selected-pool` carries the canonical pool operation profile
//   documentSet(docs)    those documents as `nightscout plan check` takes them
const { createHash } = require('node:crypto');
const { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle } = require('./multitenant-registry-layout');

const CONFIG_DIRECTORY = '/run/ns-config', SOCKET_DIRECTORY = '/run/ns-ipc';
const CONFIG_ENV = { api: 'MULTITENANT_PREVIEW_CONFIG', realtime: 'MULTITENANT_REALTIME_CONFIG', evaluator: 'MULTITENANT_EVALUATOR_CONFIG',
  'tenant-admin': 'MULTITENANT_OWNER_PREVIEW_CONFIG' };
// Identities a registry-mode deployment adds to the layout's; a suite that only
// needs the participant manifest passes no connection address for them.
const REGISTRY_IDENTITIES = ['display_reader', 'activity_reader', 'provisioner', 'management_issuer', 'connector_writer',
  'owner_settings', 'owner_activity', 'owner_credentials', 'pool_operator', 'stream_reader'];

function documents ({ layout: l, urls = {}, vaultAddress = 'https://vault.example.test:8200', variant = 'default' }) {
  if (!['default', 'full', 'full-token-files', 'selected-pool'].includes(variant)) throw new TypeError('Unknown test plan variant');
  const full = variant !== 'default';
  const ns = l.namespaces, named = name => l.prefix + '_' + name;
  // Registry-mode namespaces. The suites that load this plan do not migrate
  // them; the documents only name them.
  const registry = { namespace: named('registry'), maxTenants: 10000, refreshMs: 2000 };
  const tenantSettings = { connectionEnv: 'NS_DISPLAY_PG', namespaces: { settings: named('display_settings'), operatorPolicy: named('operator_policy') } };
  const activity = { connectionEnv: 'NS_ACTIVITY_PG', namespace: ns.control };

  const vault = file => ({ address: vaultAddress, mount: l.mount, timeoutMs: 5000, tokenFile: CONFIG_DIRECTORY + '/' + file });
  const domainNamespaces = Object.fromEntries(clinical.map(name => [name, ns[name]]));
  const limits = { maxRows: 10000, maxBytes: 8388608, maxTenants: 10000 };
  const trustedWorker = { activity: ns.control, clock: ns.clock, settings: named('display_settings'), operatorPolicy: named('operator_policy') };
  const pgstream = { receiver:{url:'http://127.0.0.1:'+19042+'/',trust:'network',bindHost:'127.0.0.1',maxBytes:16777216,timeoutMs:5000}, slot: named('stream'), streamRole: named('stream_reader'), transactionRows:10000, generation:'a'.repeat(32),
    recovery:{connectionEnv:'NS_STREAM_RECOVERY_PG',timeoutMs:5000,maxQueued:32},
    bounds: { stepMs: 5000, recoveryMs: 30000, pendingMs: 30000 } };
  const datastore = urls.evaluator ? (address => ({ hostname: address.hostname, port: Number(address.port || 5432), database: decodeURIComponent(address.pathname.slice(1)) }))(new URL(urls.evaluator)) : undefined;
  const evaluator = { version: 1, ...(datastore ? { datastore } : {}),
    postgres: { connectionEnv: 'NS_EVALUATOR_PG', namespaces: { ...domainNamespaces, clock: ns.clock, checkpoint: ns.eval_checkpoint } },
    consumer: 'evaluator-test-plan', ...limits, pageSize: 100, timeIntervalMs: 1000, socketOrderDomains: ['treatments', 'devicestatus', 'profile'],
    consumers: { realtime: { outbox: { connectionEnv: 'NS_OUTBOX_PG', namespace: ns.outbox, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      suppression: { connectionEnv: 'NS_SUPPRESSION_PG', namespace: ns.alarm, maxRows: 10000, maxBytes: 8388608, maxConnections: 2 },
      route: { id: 'realtime-test-plan', maxMessageBytes: 1048576, operationTimeoutMs: 5000 },
      maxPayloadBytes: 524288, maxInflight: 4, attemptTimeoutMs: 10000, retryDelayMs: 1000, pollIntervalMs: 1000, retryIntervalMs: 1000 } },
    registry: { ...registry }, tenantSettings, activity, pgstream, trustedWorker };
  const realtime = { version: 1, postgres: { connectionEnv: 'NS_REALTIME_PG', namespaces: { clock: ns.clock, checkpoint: ns.rt_checkpoint } },
    consumer: 'realtime-test-plan', ...limits,
    maxMessageBytes: 1048576, operationTimeoutMs: 5000, authorizationRecheckMs: 30000,
    registry: { ...registry }, tenantSettings, activity: { namespace: ns.control }, trustedWorker, completedOutput: { namespace: ns.eval_checkpoint, consumer: evaluator.consumer } };
  // Decision root-grant-ceiling-default-all: every tenant data permission unless
  // the operator narrows it. Owner and root share this catalogue (one policy row).
  const api = { version: 1, domains: [...clinical, 'settings'], legacy: true, context: true, writeClock: true,
    subjectAdmin: { writerConnectionEnv: 'NS_API_ROOT_WRITER_PG', ownerPolicy: { catalogue: ['*'] } },
    postgres: { connectionEnv: 'NS_API_PG', readinessConnectionEnv: 'NS_READINESS_PG',
      namespaces: { ...domainNamespaces, settings: ns.settings, authorization: ns.authorization, secrets: ns.secrets, legacy: ns.legacy, access: ns.access, clock: ns.clock } },
    vault: vault('vault-token'), resolution: { mode: 'direct-alias' }, registry: { ...registry }, tenantSettings, activity: { namespace: ns.control },
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
      NS_REALTIME_PG: urls.realtime, ...readers },
    evaluator: { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('evaluator'), MULTITENANT_EVALUATOR_CONFIG: file('config.json'), NS_EVALUATOR_PG: urls.evaluator,
      NS_OUTBOX_PG: urls.outbox, NS_SUPPRESSION_PG: urls.suppression, NS_STREAM_RECOVERY_PG: urls.stream_reader, NS_PLAN_PGSTREAM_BINARY: '/usr/local/bin/pgstream', NS_PLAN_PGSTREAM_CONFIG: '/run/synthetic/pgstream.yaml', ...readers },
    'tenant-admin': { ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('tenant-admin'), TENANT_ADMIN_HOSTNAME: '0.0.0.0', TENANT_ADMIN_PORT: '1341',
      MULTITENANT_OWNER_PREVIEW_CONFIG: file('config.json'), NS_OWNER_WRITER_PG: urls.owner_writer, NS_OWNER_READER_PG: urls.owner_reader } };
  // The participant manifest: each role's protected namespaces as the role
  // process computes them (the api also protects the notification outbox it
  // reads through the evaluator's metadata), the control namespace excluded.
  const protectedNamespaces = require('../../lib/server/serve/role-topology').protectedNamespaces;
  const protects = role => [...new Set([...protectedNamespaces(configs[role]), ...(role === 'api' ? [ns.outbox] : [])])].filter(name => name !== ns.control).sort();
  const participants = serviceRoles.map(role => ({ id: role, roles: [role], namespaces: protects(role), maxMessageBytes: 1048576, timeoutMs: 5000 }));
  const operations = {};
  for (const role of serviceRoles) {
    operations[role] = { version: 2, namespace: ns.control, connectionEnv: 'NS_LIFETIME_PG', registry: { namespace: registry.namespace }, participantId: role, participants };
    Object.assign(environments[role], { NS_LIFETIME_PG: urls['lifetime_' + role.replace('-', '_')], MULTITENANT_OPERATION_CONFIG: file('operation.json') });
  }
  const remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces,
    endpoint: { socketPath: socketOf(peer.id), maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
  // Lock keys follow the tenant-id rule, as the registry's do.
  const locks = [A, B].map(tenant => ({ tenant, key: require('../../lib/tenant-registry/rules').lockKey(tenant) }));
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
  const vcpool = { config: { version: 1, api: { url: 'https://api.example.test/' },
    postgres: { connectionEnv: 'NS_VCPOOL_SECRETS_PG', namespaces: { secrets: ns.secrets } },
    vault: { ...vault('vcpool-token'), allowInsecureLoopback: false }, activity: { connectionEnv: 'NS_VCPOOL_ACTIVITY_PG', namespace: ns.control },
    registry: { ...registry }, definitions: { connectionEnv: 'NS_VCPOOL_DEFINITIONS_PG', namespaces: { settings: named('connector_settings'), registry: registry.namespace, secrets: ns.secrets, control: ns.control } },
    sources: { allowHosts: ['source.example.test'], allowInsecureHttp: false }, cycleMs: 15000, pollIntervalMs: 300000, retryMs: 150000, maxTenants: 1000, maxSources: 10000 },
    environment: { MULTITENANT_VCPOOL_CONFIG: file('config.json'), NS_SERVE_INTERNAL_SOCKET: socketOf('vcpool'),
      NS_VCPOOL_SECRETS_PG: urls.api, NS_VCPOOL_ACTIVITY_PG: urls.activity_reader, NS_VCPOOL_DEFINITIONS_PG: urls.provisioner } };
  if (variant === 'full') { delete vcpool.config.vault.tokenFile; vcpool.config.vault.tokenEnv = 'NS_VAULT_TOKEN'; vcpool.environment.NS_VAULT_TOKEN = 'synthetic-placeholder'; }
  const docs = { configs, environments, operations, remote, locks, admin, vcpool };
  return full ? everyOptionalField(docs, { l, named, urls, vaultAddress, socketOf, envName, protects, tokenFiles: variant === 'full-token-files', selectedPool: variant === 'selected-pool' }) : docs;
}

// The `full` variant: each optional field the contract names, with a value its loader accepts.
function everyOptionalField (docs, { l, named, urls, vaultAddress, socketOf, envName, protects, tokenFiles, selectedPool }) {
  const ns = l.namespaces, { api, realtime, evaluator } = docs.configs, owner = docs.configs['tenant-admin'], env = docs.environments;
  evaluator.pgstream.startupTransport={timeoutMs:30000,retryIntervalMs:50};
  for (const role of [evaluator, realtime]) role.trustedWorker = { activity: ns.control, clock: ns.clock, settings: named('display_settings'), operatorPolicy: named('operator_policy') };
  // Exactly one credential source per Vault block: a token file, or an environment reference.
  const tokenVault = { address: vaultAddress, mount: l.mount, timeoutMs: 5000, allowInsecureLoopback: false,
    ...(tokenFiles ? { tokenFile: CONFIG_DIRECTORY + '/vault-token' } : { tokenEnv: 'NS_VAULT_TOKEN' }) };
  const canonical = { mode: 'canonical-internal', trustedPeers: ['192.0.2.10'] };
  api.localDataAuthentication = 'node';
  const intake = require('../../lib/pgstream/intake-profile').create({ namespace: ns.eval_checkpoint, membershipNamespace: named('intake_members'), lifecycleNamespace: ns.control, role: named('intake_writer'), consumer: evaluator.consumer, revision: '1', members: 1, tenants: [A, B], codec: require('../../lib/pgstream/intake-profile').CODEC, generationDomain: require('../../lib/pgstream/intake-profile').GENERATION_DOMAIN });
  const selected = selectedPool ? require('../../lib/pgstream/pool-intake-profile').create({ namespace: ns.eval_checkpoint,
    membershipNamespace: named('intake_members'), lifecycleNamespace: ns.control, role: named('intake_writer'), operatorRole: named('intake_operator'),
    consumer: evaluator.consumer, codec: intake.binding.codec, generationDomain: intake.binding.generationDomain,
    sliceRule: require('../../lib/pool-membership/slice').RULE }) : intake;
  for (const operation of Object.values(docs.operations)) operation.intakeProfile = JSON.parse(JSON.stringify(selected));
  api.vault = { ...tokenVault }; api.resolution = { ...canonical }; env.api.NS_VAULT_TOKEN = 'synthetic-placeholder';
  realtime.unauthorizedDeadlineMs = 5000;
  Object.assign(evaluator, { evictAfterMs: 600000, evaluationAlertMs: 60000 });
  Object.assign(evaluator.consumers.realtime, { maxConcurrentTenants: 8 });
  owner.resolution = { ...canonical };
  owner.ownerSettings = { connectionEnv: 'NS_OWNER_SETTINGS_PG', namespaces: { settings: named('display_settings'), operatorPolicy: named('operator_policy'), authority: named('settings_authority') } };
  owner.ownerActivity = { connectionEnv: 'NS_OWNER_ACTIVITY_PG', namespace: ns.control };
  owner.ownerCredentials = { connectionEnv: 'NS_OWNER_CREDENTIALS_PG', namespace: ns.secrets, vault: { ...tokenVault } };
  Object.assign(env['tenant-admin'], { NS_OWNER_SETTINGS_PG: urls.owner_settings, NS_OWNER_ACTIVITY_PG: urls.owner_activity, NS_OWNER_CREDENTIALS_PG: urls.owner_credentials, NS_VAULT_TOKEN: 'synthetic-placeholder' });
  const admin = docs.admin.config;
  for (const role of ['api', 'evaluator', 'realtime']) docs.configs[role].platformVerification = { namespace: named('platform_verification'), role };
  // vcpool checks the proof at start too (decision vcpool-proof-role); it has no operation plane.
  docs.vcpool.config.platformVerification = { namespace: named('platform_verification'), role: 'vcpool' };
  admin.platformVerification = { connectionEnv: 'NS_PLATFORM_VERIFY_PG', namespace: named('platform_verification'),
    targets: ['api', 'evaluator', 'realtime'].map(role => ({ role, configFile: CONFIG_DIRECTORY + '/verification/' + role + '.config.json',
      operationConfigFile: CONFIG_DIRECTORY + '/verification/' + role + '.operation.json', environmentFile: CONFIG_DIRECTORY + '/verification/' + role + '.env.json' }))
      .concat([{ role: 'vcpool', configFile: CONFIG_DIRECTORY + '/verification/vcpool.config.json', environmentFile: CONFIG_DIRECTORY + '/verification/vcpool.env.json' }]) };
  docs.admin.environment.NS_PLATFORM_VERIFY_PG = urls.provisioner;

  admin.pools = { connectionEnv: 'NS_POOL_OPERATOR_PG', namespace: named('pool'), kinds: ['evaluator'] };
  admin.provisioning.mode = 'canonical-internal';
  admin.provisioning.vault = { ...tokenVault, timeoutMs: 10000 }; admin.managementSessions.vault = { ...tokenVault, timeoutMs: 10000 };
  Object.assign(docs.admin.environment, { NS_POOL_OPERATOR_PG: urls.pool_operator, NS_VAULT_TOKEN: 'synthetic-placeholder' });
  // A fixed roster: the api role is two instances behind one service address, and
  // every row names its own instance address; the realtime row names its worker.
  const service = 'http://api-internal.example.test:7001', instance = n => 'http://api-' + n + '.example.test:7001';
  const original = docs.operations.api.participants.find(row => row.id === 'api');
  const participants = [1, 2].map(n => ({ ...original, id: 'api-' + n, address: { url: instance(n) } }))
    .concat(docs.operations.api.participants.filter(row => row.id !== 'api').map(row => ({ ...row, namespaces: protects(row.id),
      ...(row.id === 'realtime' ? { slice: {count:1,ordinal:0} } : {}), address: { socket: socketOf(row.id + '-1') } })));
  for (const [role, environment] of Object.entries(env)) {
    delete environment.NS_API_INTERNAL_SOCKET; environment.NS_API_INTERNAL_URL = service;
    // A process that listens on its instance address does not also name its own role's service address.
    if (role !== 'api') { environment.NS_SERVE_INTERNAL_SOCKET = socketOf(role + '-1'); delete environment[envName(role) + 'SOCKET']; }
    docs.operations[role] = { ...docs.operations[role], leaseSessions: 2, participants };
  }
  for (const n of [1, 2]) {
    const name = 'api-' + n;
    docs.configs[name] = api;
    env[name] = { ...env.api, NS_SERVE_INTERNAL_HOST: '0.0.0.0', NS_SERVE_INTERNAL_PORT: '7001' }; delete env[name].NS_SERVE_INTERNAL_SOCKET;
    docs.operations[name] = { ...docs.operations.api, participantId: name };
  }
  delete docs.configs.api; delete env.api; delete docs.operations.api;
  docs.remote = participants.map(peer => ({ id: peer.id, roles: peer.roles, namespaces: peer.namespaces, ...(peer.slice ? { slice: peer.slice } : {}),
    endpoint: { ...(peer.address.url ? { url: peer.address.url + '/', trust: 'network' } : { socketPath: peer.address.socket }), maxBytes: peer.maxMessageBytes, timeoutMs: peer.timeoutMs } }));
  return docs;
}

// One process per configured service, each with the files its environment names.
function documentSet (docs) {
  const file = name => CONFIG_DIRECTORY + '/' + name;
  const roleOf = name => name.startsWith('api-') ? 'api' : name;
  const processes = Object.keys(docs.configs).map(name => ({ name, roles: [roleOf(name)], environment: docs.environments[name],
    files: { [docs.environments[name][CONFIG_ENV[roleOf(name)]]]: docs.configs[name], [file('operation.json')]: docs.operations[name],
      ...(roleOf(name) === 'api' ? { [file('evaluator-metadata.json')]: docs.configs.evaluator } : {}) } }));
  processes.push({ name: 'admin', roles: ['admin'], environment: docs.admin.environment, files: { [file('config.json')]: docs.admin.config } });
  processes.push({ name: 'vcpool', roles: ['vcpool'], environment: docs.vcpool.environment, files: { [file('config.json')]: docs.vcpool.config } });
  return { contract: 1, processes };
}

// Synthetic connection addresses for every identity the documents name.
function syntheticUrls (l) {
  return Object.fromEntries([...Object.keys(l.roles), ...REGISTRY_IDENTITIES].map(kind =>
    [kind, 'postgres://' + (l.roles[kind] || l.prefix + '_' + kind) + ':synthetic@postgres.example.test:5432/nightscout_test_plan']));
}

module.exports = { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle, documents, documentSet, syntheticUrls };
