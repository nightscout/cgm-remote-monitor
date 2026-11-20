'use strict';

// The test plan: a small registry-mode deployment for core's own tests. Roles
// are configured by environment settings (decision config-few-dozen-env,
// lib/server/serve/deployment-settings.js); this fixture gives its integration
// suites a database layout with the deployment's grants and the environment
// each role runs with. Synthetic only. No database, network or filesystem I/O.
//
//   layout(prefix)       namespaces, database identities and the Vault mount, by name
//   catalogues()         the catalogue each namespace is migrated with
//   grants(layout)       the SQL grants of every identity
//   lifecycle(layout)    the restore driver's catalogue list
//   documents(options)   every role's environment, and the configuration value
//                        each role's loader builds from it (`configs`, for
//                        suites that parse a changed value directly)
//   syntheticUrls(l)     a connection address for every identity
const { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle } = require('./multitenant-registry-layout');

const CONFIG_DIRECTORY = '/run/ns-config', SOCKET_DIRECTORY = '/run/ns-ipc';
// Identities a registry-mode deployment adds to the layout's.
const REGISTRY_IDENTITIES = ['display_reader', 'activity_reader', 'provisioner', 'management_issuer', 'connector_writer',
  'owner_settings', 'owner_activity', 'owner_credentials', 'pool_operator', 'pgstream'];

// `settings`: further environment settings for every role (for example NS_VAULT_ALLOW_INSECURE_LOOPBACK).
function documents ({ layout: l, urls = {}, vaultAddress = 'https://vault.example.test:8200', settings: extra = {} }) {
  const settings = require('../../lib/server/serve/deployment-settings');
  // serve.internal: one socket per role process on the shared private
  // directory; every peer address names the same paths.
  const socketOf = role => SOCKET_DIRECTORY + '/' + role + '.sock';
  const envName = require('../../lib/server/internal-api/listener-config').envName;
  // The synthetic deployment signing secret (decision deployment-signing-secret).
  const signingSecret = require('./signing-secret').env();
  const common = { NS_PG_PREFIX: l.prefix, NS_VAULT_ADDR: vaultAddress, NS_SECRETS_DIR: CONFIG_DIRECTORY, ...signingSecret, ...extra,
    ...Object.fromEntries(serviceRoles.map(role => [envName(role) + 'SOCKET', socketOf(role)])) };
  const present = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
  const readers = { NS_DISPLAY_PG: urls.display_reader };
  const lifetime = role => ({ NS_LIFETIME_PG: urls['lifetime_' + role.replace('-', '_')] });
  const environments = {
    api: present({ ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('api'), API_HOSTNAME: '0.0.0.0', API_PORT: '1337',
      NS_API_PG: urls.api, NS_READINESS_PG: urls.readiness, NS_API_ROOT_WRITER_PG: urls.root_writer, NS_ALARM_PG: urls.alarm, ...readers, ...lifetime('api') }),
    realtime: present({ ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('realtime'), REALTIME_HOSTNAME: '0.0.0.0', REALTIME_PORT: '1339',
      NS_REALTIME_PG: urls.realtime, ...readers, ...lifetime('realtime') }),
    evaluator: present({ ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('evaluator'), NS_EVALUATOR_PG: urls.evaluator,
      NS_OUTBOX_PG: urls.outbox, NS_SUPPRESSION_PG: urls.suppression, NS_ACTIVITY_PG: urls.activity_reader, NS_STREAM_RECOVERY_PG: urls.pgstream,
      NS_PGSTREAM_RECEIVER_URL: 'http://127.0.0.1:19042/', NS_PGSTREAM_RECEIVER_BIND_HOST: '127.0.0.1', NS_PGSTREAM_GENERATION: 'a'.repeat(32), ...readers, ...lifetime('evaluator') }),
    'tenant-admin': present({ ...common, NS_SERVE_INTERNAL_SOCKET: socketOf('tenant-admin'), TENANT_ADMIN_HOSTNAME: '0.0.0.0', TENANT_ADMIN_PORT: '1341',
      NS_OWNER_WRITER_PG: urls.owner_writer, NS_OWNER_READER_PG: urls.owner_reader, NS_OWNER_CREDENTIALS_PG: urls.owner_credentials, NS_OWNER_SETTINGS_PG: urls.owner_settings, ...lifetime('tenant-admin') }) };
  const configs = Object.fromEntries(serviceRoles.map(role => [role, settings.configuration(role, environments[role])]));
  const adminEnvironment = present({ NS_PG_PREFIX: l.prefix, NS_VAULT_ADDR: vaultAddress, NS_SECRETS_DIR: CONFIG_DIRECTORY, ...signingSecret, ...extra,
    ADMIN_HOSTNAME: '127.0.0.1', ADMIN_PORT: '1342', NS_PROVISIONER_PG: urls.provisioner,
    NS_OWNERSHIP_PG: urls.ownership_operator, NS_CONNECTOR_SOURCES_PG: urls.connector_writer, NS_MANAGEMENT_SESSIONS_PG: urls.management_issuer });
  const vcpoolEnvironment = present({ NS_PG_PREFIX: l.prefix, NS_VAULT_ADDR: vaultAddress, NS_SECRETS_DIR: CONFIG_DIRECTORY, ...extra,
    NS_SERVE_INTERNAL_SOCKET: socketOf('vcpool'), NS_VCPOOL_API_URL: 'https://api.example.test/', NS_VCPOOL_ALLOW_HOSTS: 'source.example.test',
    NS_VCPOOL_SECRETS_PG: urls.api, NS_VCPOOL_ACTIVITY_PG: urls.activity_reader, NS_VCPOOL_DEFINITIONS_PG: urls.provisioner });
  return { configs, environments,
    admin: { config: settings.configuration('admin', adminEnvironment), environment: adminEnvironment },
    vcpool: { config: settings.configuration('vcpool', vcpoolEnvironment), environment: vcpoolEnvironment } };
}

function roleNames (l) {
  return [...new Set([...Object.keys(l.roles), ...REGISTRY_IDENTITIES])];
}

// Synthetic connection addresses for every identity the documents name.
function syntheticUrls (l) {
  return Object.fromEntries(roleNames(l).map(kind =>
    [kind, 'postgres://' + (l.roles[kind] || l.prefix + '_' + kind) + ':synthetic@postgres.example.test:5432/nightscout_test_plan']));
}

module.exports = { A, B, subject, clinical, ordered, serviceRoles, quote, catalogues, layout, insertionGrants, grants, lifecycle, documents, syntheticUrls, roleNames };
