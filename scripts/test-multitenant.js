#!/usr/bin/env node

'use strict';

// One command for the multitenant preview's opt-in test corpus: the suites
// that stay pending in the integration tier until an environment flag, a
// PostgreSQL admin URI, a MongoDB URI or a Vault address enables them
// (docs/multitenant-test-corpus.md holds the inventory as a table).
//
//   node scripts/test-multitenant.js                 run every suite
//   node scripts/test-multitenant.js --only <text>   suites whose path contains <text> (repeatable)
//   node scripts/test-multitenant.js --list          print the inventory and exit
//   node scripts/test-multitenant.js --record <file> also write the run record as JSON
//
// Unless NS_TEST_POSTGRES_ADMIN_URI is already set, the script starts one
// disposable PostgreSQL 16 container for the suites that share an admin URI;
// it starts one disposable MongoDB when a selected suite opens
// CUSTOMCONNSTR_mongo and the caller has not set it, and one disposable Vault
// dev server when a selected suite reads a Vault address from the
// environment. Suites that provision their own containers only get their
// flag. Every container runs on a random loopback port with generated
// credentials that live only in the child's environment; the script removes
// exactly the containers and anonymous volumes it created, by recorded id,
// and verifies they are gone. Exit status: 0 when every selected suite passed
// and at least one test ran; 1 on a failing test, zero passing tests or an
// unverifiable teardown; 2 on usage, inventory or provisioning errors.

const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const tiers = require('./test-tiers');
const parseEnv = require('../bin/with-env');

const ROOT = path.resolve(__dirname, '..');
const TIER = 'integration';
const ENV_FILE = path.join(ROOT, 'tests/ci.test.env');
const LABEL = 'ns.multitenant.run';
const POSTGRES_DATABASE = 'nightscout_multitenant_test';
const IMAGES = {
  postgres: process.env.NS_MULTITENANT_POSTGRES_IMAGE || 'postgres:16',
  mongo: process.env.NS_MULTITENANT_MONGO_IMAGE || 'mongo:8.0',
  // The digest the suites pin for their own Vault containers.
  vault: process.env.NS_MULTITENANT_VAULT_IMAGE ||
    'hashicorp/vault@sha256:962a92876e168d68eaaa24b0b8b49bbce1cb63024060a67bba95cd158a366fc2'
};

// The corpus. `flags` are set in the child's environment; `shared` names the
// services the script provides (postgres sets NS_TEST_POSTGRES_ADMIN_URI,
// mongo sets CUSTOMCONNSTR_mongo, vault sets the `vaultEnv` pair); `own`
// names the containers the suite starts for itself through Docker; `gate` is
// how the suite reports when disabled.
const PENDING = 'pending opt-in';
const CRUD = { NS_ENTRIES_CRUD_HTTP_TEST: '1' };
const INVENTORY = [
  { file: 'tests/realtime-placement-owner.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'actual held realtime worker owner exclusion, backend loss and independent worker' },
  { file: 'tests/realtime-placement-publication.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'controlled placement publication and actual maintenance-pin exclusion; fixture-owned Vault' },
  { file: 'tests/realtime-sharding-native.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'actual API/realtime roles, assigned live-add, polling/WebSocket/API3 move, alarm routing, deferred warm and observed cohort census; fixture-owned Vault' },
  { file: 'tests/connector-sources.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'durable registry connector definitions, encrypted credentials and independent revision refresh; fixture-owned Vault' },
  { file: 'tests/registry-realtime-settings.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'registry realtime persisted D15 settings, HTTP/socket serialization and missing-state refusal; fixture-owned Vault' },
  { file: 'tests/tenant-live-add.integration.test.js', flags: { NS_TENANT_LIVE_ADD_TEST: '1', MULTITENANT_STATIC_TENANTS: 'lab' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'live provision to clinical alarm/frame, existing-tenant continuity, deferred warm/activity resume and burst/removal; owned PostgreSQL and Vault' },
  { file: 'tests/api-fixed-roster.integration.test.js', flags: { NS_API_ROSTER_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'two API replica restore census with real private endpoints and roster controls; own PostgreSQL' },
  { file: 'tests/registry-human-session.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'registry-provisioned human keys and durable PostgreSQL sessions; fixture owns Vault' },
  { file: 'tests/change-feed.integration.test.js', flags: { NS_D6_FEED_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'D6 fixed-slot pgoutput reader, EXECUTE-only wrappers, LISTEN/paged recovery and semantic controls; own PostgreSQL' },
  { file: 'tests/tenant-insertion-upgrade.integration.test.js', flags: { NS_TENANT_INSERTION_UPGRADE_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'populated immutable-prefix upgrades through actual runner, per-tenant floors, old catalogue refusal and transaction rollback' },
  { file: 'tests/tenant-insertion-readiness.integration.test.js', flags: { NS_TENANT_INSERTION_READINESS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'actual typed tenant-local allocator schemas, exact function/trigger/RLS/ACL/floor admission with physical red/restored controls' },
  { file: 'tests/owner-configuration.integration.test.js', flags: { NS_OWNER_CONFIGURATION_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'explicit configure authority, actual owner settings CAS/history and DATA presentation-only reads; separate from original owner9' },
  { file: 'tests/owner-preview.integration.test.js', flags: { NS_OWNER_PREVIEW_TEST: '1' }, shared: ['postgres'], own: ['postgres', 'vault'], gate: PENDING,
    note: 'actual headless tenant-admin CLI workers; operator-provisioned synthetic management credentials, no human issuer' },
  { file: 'tests/tenant-socket-order-capability.integration.test.js', flags: { NS_SOCKET_ORDER_CAPABILITY_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'experimental optional successor; old catalogue MIG_UNKNOWN and populated upgrade refusal are expected' },

  { file: 'tests/tenant-socket-data-forwarding.integration.test.js', flags: { NS_SOCKET_DATA_FORWARDING_TEST: '1' }, shared: ['postgres', 'mongo'], own: [], gate: PENDING,
    note: 'real sockets; pinned AAPS DATA pattern replay, not an actual Android binary; selected fixture transport only' },

  { file: 'tests/postgres-connection.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING },
  { file: 'tests/entries-importer-postgres.integration.test.js', flags: { NS_POPULATED_RECOVERY_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['postgres', 'postgres'], gate: PENDING,
    note: 'existing import target plus owned stopped-write populated source/restore-target reference' },
  { file: 'tests/postgres-entries-read.test.js', flags: {}, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/postgres-entries-write.test.js', flags: {}, shared: ['postgres', 'mongo'], own: [], gate: 'describe.skip, silent' },
  { file: 'tests/api3.entries-crud.http.test.js', flags: CRUD, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-rest-entries.integration.test.js', flags: CRUD, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-rest-identifier-race.integration.test.js', flags: CRUD, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-rest-identity-differential.integration.test.js', flags: CRUD, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-frame-concurrency.integration.test.js', flags: CRUD, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-durable-replay.integration.test.js', flags: { NS_TENANT_DURABLE_REPLAY_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING },
  { file: 'tests/tenant-projection-evaluator.integration.test.js', flags: { NS_TENANT_PROJECTION_EVALUATOR_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING },
  { file: 'tests/tenant-current-state-recovery-proof.integration.test.js', flags: { NS_M5_CURRENT_STATE_PROOF_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'bounded current-state acquisition and explicit evaluator preview lifecycle; no notification/provider acceptance' },
  { file: 'tests/tenant-alarm-state.integration.test.js', flags: { NS_TENANT_ALARM_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'durable tenant-wide alarm suppression and consumed output; actual private transport acceptance is separate' },
  { file: 'tests/tenant-notifications.integration.test.js', flags: { NS_TENANT_NOTIFICATIONS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'durable notification intent, attempt/retry identity and selected-consumer semantics; no device-delivery claim' },
  { file: 'tests/evaluator-consumers.integration.test.js', flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'actual selected evaluator role, committed private producer state/outbox, controlled UDS sink and current ACK semantics; real recipient delivery is separate' },
  { file: 'tests/tenant-activity.integration.test.js', flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'pause/suspend eligibility: evaluator work lists from eligible tenants, recompute on unpause, other tenants unaffected' },
  { file: 'tests/evaluator-consumer-timer-churn.integration.test.js', flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'stale producer selection under evaluator timer churn is reselected, not refused; NS_CONSUMER_* knobs are for measurement' },
  { file: 'tests/evaluator-consumer-load.integration.test.js', flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'consumer wakes and producer selections per window with content-change revisions; NS_CONSUMER_LOAD_* knobs are for measurement' },
  { file: 'tests/change-stamps.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision change-stamp-definer-function: catalogue, deployment grants, attribute check and refusals' },
  { file: 'tests/tenant-registry.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision tenant-registry: definer lookup/revision/enumeration narrowness, per-tenant RLS on attributes, attribute check' },
  { file: 'tests/tenant-registry-provision.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'decision provisioning-split: idempotent provisioning, injected failures leave no partial tenant, bounded batches' },
  { file: 'tests/admin-provisioning.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'decision operator-rest-api: provisioning REST on the admin role and the `nightscout admin provision` client (secret never on stdout/stderr); spawns the shipping CLI as a child' },
  { file: 'tests/registry-tenant-set.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision tenant-registry stage 1: evaluator/realtime start set, removal within the bound, waiting count and alert, restart cost (NS_REGISTRY_RESTART_COUNTS)' },
  { file: 'tests/api-registry.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: ['postgres'], own: ['vault'], gate: PENDING,
    note: 'decision tenant-registry: api in registry mode serves a tenant provisioned while running within the refresh bound; spawns the shipping CLI as a child' },
  { file: 'tests/postgres-tenant-scan.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'scanTenants: one READ ONLY round trip under each tenant\'s forced-RLS binding' },
  { file: 'tests/pool-membership.integration.test.js', flags: {}, shared: ['postgres'], own: [], gate: PENDING,
    note: 'pool membership: two kinds, member/inspector/operator identities, operator-set count, agreement, lease expiry' },
  { file: 'tests/incremental-view.integration.test.js', flags: { NS_TENANT_DURABLE_REPLAY_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision incremental-refresh: edit, soft and hard delete, gap, mismatch' },
  { file: 'tests/tenant-write-clock-complete.integration.test.js', flags: { NS_TENANT_COMMIT_CLOCK_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision write-clock-complete: every supported write advances the clock, hard deletes also last_delete_stamp' },
  { file: 'tests/evaluator-wake.integration.test.js', flags: { NS_TENANT_PROJECTION_EVALUATOR_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'work on change: lost wake, duplicate delivery, restart, hard delete and unstamped update re-evaluated, idle, eviction' },
  { file: 'tests/evaluator-cost.integration.test.js', flags: { NS_TENANT_PROJECTION_EVALUATOR_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'evaluator cost lane C/D/E: copies stay independent of plugin mutation' },
  { file: 'tests/views-keep.integration.test.js', flags: { NS_TENANT_PROJECTION_EVALUATOR_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'evaluator cost lane B: a kept working set re-cut equals a fresh load' },
  { file: 'tests/projection-total-order.integration.test.js', flags: { NS_TENANT_PROJECTION_EVALUATOR_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'decision view-reads-total-order: SQL and in-process paths agree, ties broken on the insertion ordinal' },
  { file: 'tests/evaluator-consumer-wake.integration.test.js', flags: { NS_EVALUATOR_CONSUMERS_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING,
    note: 'consumers on change: an idle tenant is not polled; a new alarm is delivered by the revision wake' },
  { file: 'tests/operation-window-epoch.integration.test.js', flags: { NS_OPERATION_WINDOW_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'restore fence and catalogue admission epoch with the deployment plan\'s catalogue and grants' },
  { file: 'tests/tenant-operations.integration.test.js', flags: { NS_TENANT_OPERATIONS_PG_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'representative entries/clock recovery and upgrade contracts; full populated deployment recovery is separate' },
  { file: 'tests/tenant-commit-clock-port.integration.test.js', flags: { NS_TENANT_COMMIT_CLOCK_TEST: '1' }, shared: ['postgres'], own: [], gate: PENDING },
  { file: 'tests/tenant-commit-clock-http.integration.test.js', flags: { NS_TENANT_COMMIT_CLOCK_HTTP_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'functional cases enabled; benchmark remains pending unless NS_TENANT_COMMIT_CLOCK_BENCHMARK=1' },
  { file: 'tests/management-sessions.integration.test.js', flags: { NS_MANAGEMENT_SESSIONS_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'private operator issuance; current owner/key fencing, real Vault rotation, lifecycle shared lease and live issuer census' },
  { file: 'tests/operation-lifetime-discriminator.integration.test.js', flags: { NS_OPERATION_LIFETIME_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'explicit bounded lifetime sessions; full admission, held actual API responses, current authority, commit uncertainty and orphan refusal; timing is mechanism-only' },
  { file: 'tests/api-fixed-roster-serving.integration.test.js', flags: { NS_API_ROSTER_SERVING_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'two actual API CLI processes; response drain/current authority/census/uncertainty; non-API peers are synthetic lifecycle-only' },
  { file: 'tests/multitenant-preview-replicas.integration.test.js', flags: { NS_MULTITENANT_PREVIEW_REPLICAS_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'spawns the shipping CLI as independent processes on one host' },
  { file: 'tests/tenant-rest-derived.integration.test.js', flags: { NS_REST_DERIVED_HTTP_TEST: '1' }, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-rest-treatments.integration.test.js', flags: { NS_REST_TREATMENTS_HTTP_TEST: '1' }, shared: ['postgres', 'mongo'], own: [], gate: PENDING },
  { file: 'tests/tenant-rest-context.integration.test.js', flags: { NS_REST_CONTEXT_HTTP_TEST: '1' }, shared: ['postgres', 'mongo'], own: ['vault'], gate: PENDING },
  { file: 'tests/tenant-rest-device-activity.integration.test.js', flags: { NS_REST_DEVICE_ACTIVITY_TEST: '1' }, shared: ['postgres', 'mongo'], own: ['vault'], gate: PENDING,
    note: 'its own Vault is hashicorp/vault:latest, unpinned' },
  { file: 'tests/tenant-rest-profile-food.integration.test.js', flags: { NS_PROFILE_FOOD_HTTP_TEST: '1' }, shared: ['postgres', 'mongo', 'vault'], own: [], gate: PENDING,
    vaultEnv: { address: 'NS_PROFILE_FOOD_VAULT_ADDRESS', token: 'NS_PROFILE_FOOD_VAULT_TOKEN' },
    note: 'mounts transit at the fixed path "transit": one run per Vault' },
  { file: 'tests/tenant-rest-settings-differential.integration.test.js', flags: { NS_SETTINGS_DIFFERENTIAL_TEST: '1' }, shared: ['postgres', 'mongo', 'vault'], own: [], gate: PENDING,
    vaultEnv: { address: 'NS_SETTINGS_VAULT_ADDRESS', token: 'NS_SETTINGS_VAULT_TOKEN' } },
  { file: 'tests/postgres-migrations.integration.test.js', flags: { NS_MIGRATION_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/mongodb-migrations.integration.test.js', flags: { NS_MIGRATION_MONGO_DOCKER_TEST: '1' }, shared: [], own: ['mongo'], gate: PENDING,
    note: 'mongo:8.0.34 replica set' },
  { file: 'tests/postgres-secrets.integration.test.js', flags: { NS_SECRETS_POSTGRES_DOCKER_TEST: '1', NS_VAULT_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'NS_VAULT_DOCKER_TEST=1 enables its one backup-restore case, which starts raft Vaults' },
  { file: 'tests/vault-secrets.integration.test.js', flags: { NS_VAULT_DOCKER_TEST: '1' }, shared: [], own: ['vault'], gate: PENDING },
  { file: 'tests/tenant-key-retention.integration.test.js', flags: { NS_KEY_RETENTION_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'post-deletion 30-day key retention: destroys Transit keys in its own Vault dev' },
  { file: 'tests/tenant-runtime-vault.integration.test.js', flags: { NS_TENANT_RUNTIME_VAULT_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING },
  { file: 'tests/tenant-entries-http.integration.test.js', flags: { NS_TENANT_HTTP_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/tenant-credential-http.integration.test.js', flags: { NS_TENANT_CREDENTIAL_HTTP_DOCKER_TEST: '1' }, shared: ['mongo'], own: ['postgres'], gate: PENDING,
    note: 'owns its PostgreSQL; its differential cases open CUSTOMCONNSTR_mongo' },
  { file: 'tests/tenant-authorization-postgres.integration.test.js', flags: { NS_TENANT_AUTHORITY_POSTGRES_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/subject-management-http.integration.test.js', flags: { NS_SUBJECT_MANAGEMENT_HTTP_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/subject-admin-postgres.integration.test.js', flags: { NS_SUBJECT_ADMIN_POSTGRES_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/tenant-ownership-postgres.integration.test.js', flags: { NS_TENANT_OWNERSHIP_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'operator-assisted add/transfer/recover with concurrent-transfer and foreign-authority controls over the private ownership service' },
  { file: 'tests/admin-role-ownership.integration.test.js', flags: { NS_ADMIN_ROLE_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'spawns `nightscout multitenant admin`; ownership operations on the admin listener with the deployment plan\'s ownership_operator grants' },
  { file: 'tests/admin-lifecycle-fit.integration.test.js', flags: { NS_ADMIN_LIFECYCLE_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING,
    note: 'tenant A restore through the maintenance controller and remote cohort census with the admin role connected; ownership refusal while held; admin on the consumer address at another port' },
  { file: 'tests/owner-subject-policy.integration.test.js', flags: { NS_OWNER_SUBJECT_POLICY_DOCKER_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/tenant-rest-authority-review.test.js', flags: { NS_REST_AUTHORITY_REVIEW_TEST: '1' }, shared: [], own: ['postgres'], gate: PENDING },
  { file: 'tests/storage-port-contract.integration.test.js', flags: { NS_STORAGE_PORT_CONTRACT_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'mongo'], gate: PENDING,
    note: 'mongo:7.0' },
  { file: 'tests/tenant-frame-acquisition.integration.test.js', flags: { NS_FRAME_ACQUISITION_TEST: '1' }, shared: [], own: ['postgres', 'mongo'], gate: PENDING,
    note: 'mongo:8.0.34' },
  { file: 'tests/tenant-rest-client-replay.integration.test.js', flags: { NS_REST_CLIENT_REPLAY_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'spawns the shipping CLI as a child' },
  { file: 'tests/multitenant-preview-process.integration.test.js', flags: { NS_MULTITENANT_PREVIEW_PROCESS_DOCKER_TEST: '1' }, shared: [], own: ['postgres', 'vault'], gate: PENDING,
    note: 'spawns the shipping CLI as a child' }
];

function log (message) {
  console.error('# multitenant: ' + message);
}

function docker (args, options) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...options }).trim();
}

function dockerFails (args) {
  try { docker(args); return false; } catch (error) { return error; }
}

function usage () {
  console.error('usage: test-multitenant.js [--list] [--only <text>]... [--record <file>]');
  return 2;
}

function parseArgs (argv) {
  const options = { list: false, only: [], record: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--only' && argv[i + 1]) options.only.push(argv[++i]);
    else if (arg === '--record' && argv[i + 1]) options.record = path.resolve(argv[++i]);
    else return null;
  }
  return options;
}

// Inspect executable source, not mentions in fixture documents, comments or
// source-code examples. Babel is an existing direct test/build dependency; no
// repository Babel config/plugins or test code are executed by this parse.
function classifyOptInSource (text) {
  const babel = require('@babel/core');
  const ast = babel.parseSync(text, { configFile: false, babelrc: false, sourceType: 'unambiguous' });
  const reads = new Set(); let optIn = false, unknownEnvironmentRead = false;
  const member = p => p && (p.isMemberExpression() || p.isOptionalMemberExpression());
  function key (p, computed) {
    if (!computed && p.isIdentifier()) return p.node.name;
    if (p.isStringLiteral()) return p.node.value;
    if (p.isTemplateLiteral() && !p.node.expressions.length) return p.node.quasis[0].value.cooked;
    return null;
  }
  function processObject (p, seen = new Set()) {
    if (!p?.node) return false;
    if (p.isIdentifier({name: 'process'}) && !p.scope.getBinding('process')) return true;
    if (member(p) && key(p.get('property'), p.node.computed) === 'process' &&
        p.get('object').isIdentifier() && ['globalThis', 'global'].includes(p.node.object.name) && !p.scope.getBinding(p.node.object.name)) return true;
    if (p.isCallExpression() && p.get('callee').isIdentifier({name: 'require'}) && !p.scope.getBinding('require') &&
        p.node.arguments.length === 1 && p.get('arguments.0').isStringLiteral() && ['process', 'node:process'].includes(p.node.arguments[0].value)) return true;
    if (p.isIdentifier()) {
      const binding = p.scope.getBinding(p.node.name);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      if (binding.path.isVariableDeclarator() && binding.path.get('id').isIdentifier()) return processObject(binding.path.get('init'), seen);
      if (binding.path.isImportDefaultSpecifier() || binding.path.isImportNamespaceSpecifier()) return ['process', 'node:process'].includes(binding.path.parent.source.value);
    }
    return false;
  }
  function environment (p, seen = new Set()) {
    if (!p?.node) return false;
    if (member(p) && key(p.get('property'), p.node.computed) === 'env' && processObject(p.get('object'))) return true;
    if (!p.isIdentifier()) return false;
    const binding = p.scope.getBinding(p.node.name);
    if (!binding || seen.has(binding) || !binding.path.isVariableDeclarator()) return false;
    seen.add(binding);
    const declaration = binding.path;
    if (declaration.get('id').isIdentifier()) return environment(declaration.get('init'), seen);
    if (declaration.get('id').isObjectPattern() && processObject(declaration.get('init'))) {
      return declaration.get('id.properties').some(property => property.isObjectProperty() &&
        key(property.get('key'), property.node.computed) === 'env' && property.get('value').isIdentifier({name: p.node.name}));
    }
    return false;
  }
  function add (name) { if (typeof name === 'string') reads.add(name); }
  function pattern (p) {
    if (!p.isObjectPattern()) return;
    for (const property of p.get('properties')) if (property.isObjectProperty()) add(key(property.get('key'), property.node.computed));
  }
  function inspectMember (p) {
    const parent = p.parentPath;
    const writesOnly = parent.isAssignmentExpression({operator: '='}) && parent.node.left === p.node || parent.isUnaryExpression({operator: 'delete'});
    if (!writesOnly && environment(p.get('object'))) add(key(p.get('property'), p.node.computed));
  }
  // A copied, passed or dynamically indexed real environment cannot be
  // certified synthetic. Keep candidate files conservative on unresolved flow.
  function inspectEnvironmentUse (p) {
    if (!environment(p)) return;
    const parent = p.parentPath;
    if (member(parent) && parent.node.object === p.node) {
      if (key(parent.get('property'), parent.node.computed) === null) unknownEnvironmentRead = true;
      return;
    }
    if (parent.isVariableDeclarator() && parent.node.init === p.node &&
        (parent.get('id').isIdentifier() || parent.get('id').isObjectPattern() && !parent.node.id.properties.some(property => property.type === 'RestElement'))) return;
    if (parent.isAssignmentExpression() && parent.node.left === p.node) return;
    if (parent.isAssignmentExpression() && parent.node.right === p.node && parent.get('left').isObjectPattern()) return;
    unknownEnvironmentRead = true;
  }
  babel.traverse(ast, {
    MemberExpression (p) { inspectMember(p); inspectEnvironmentUse(p); },
    OptionalMemberExpression (p) { inspectMember(p); inspectEnvironmentUse(p); },
    ReferencedIdentifier: inspectEnvironmentUse,
    VariableDeclarator (p) { if (environment(p.get('init'))) pattern(p.get('id')); },
    AssignmentExpression (p) { if (environment(p.get('right'))) pattern(p.get('left')); },
    CallExpression (p) {
      const callee = p.get('callee');
      if (callee.isIdentifier({name: 'optInSuite'}) || member(callee) && key(callee.get('property'), callee.node.computed) === 'optInSuite') optIn = true;
      else if (callee.isIdentifier()) {
        const binding = callee.scope.getBinding(callee.node.name);
        if (binding?.path.isVariableDeclarator() && binding.path.get('id').isObjectPattern() &&
            binding.path.get('id.properties').some(property => property.isObjectProperty() &&
              key(property.get('key'), property.node.computed) === 'optInSuite' && property.get('value').isIdentifier({name: callee.node.name}))) optIn = true;
      }
    }
  });
  return { needed: reads.has('NS_TEST_POSTGRES_ADMIN_URI') || optIn && [...reads].some(name => name.startsWith('NS_')) ||
      unknownEnvironmentRead && (/NS_TEST_POSTGRES_ADMIN_URI/.test(text) || optIn && /\bNS_[A-Z0-9_]+\b/.test(text)),
    environmentReads: [...reads].sort(), optIn, unknownEnvironmentRead };
}

// The inventory must name files that exist, in the integration tier, and no
// opt-in test file may be missing from it: a new suite is added here (and to
// the docs table), never silently left out of the corpus.
function checkInventory ({ inventory = INVENTORY, testFiles = tiers.listTestFiles(), tierOf = tiers.tierOf,
  readSource = file => fs.readFileSync(path.join(ROOT, file), 'utf8') } = {}) {
  const problems = [];
  const known = new Set(testFiles);
  const listed = new Set(inventory.map(suite => suite.file));
  for (const suite of inventory) {
    if (!known.has(suite.file)) problems.push(suite.file + ': in the inventory but not a test file');
    else if (tierOf(suite.file) !== TIER) problems.push(suite.file + ': in tier ' + tierOf(suite.file) + ', not ' + TIER);
  }
  for (const file of known) {
    if (listed.has(file) || file.startsWith('tests/fixtures/')) continue;
    const text = readSource(file);
    // Avoid parsing unrelated files; these names alone never establish a read.
    if (!/NS_TEST_POSTGRES_ADMIN_URI|optInSuite|process/.test(text)) continue;
    try {
      if (classifyOptInSource(text).needed) problems.push(file + ': opt-in test file missing from scripts/test-multitenant.js INVENTORY');
    } catch {
      problems.push(file + ': cannot classify opt-in source; inventory validation refuses a parse failure');
    }
  }
  return problems;
}

function select (only) {
  if (!only.length) return INVENTORY.slice();
  return INVENTORY.filter(suite => only.some(text => suite.file.includes(text)));
}

function list (suites) {
  for (const suite of suites) {
    const flags = Object.entries(suite.flags).map(([k, v]) => k + '=' + v).join(' ') || '(admin URI only)';
    const provided = suite.shared.length ? suite.shared.join('+') : 'none';
    const own = suite.own.length ? suite.own.join('+') : 'none';
    console.log(suite.file + '\n  flags: ' + flags + '\n  provided by the script: ' + provided +
      '; starts its own: ' + own + '; disabled: ' + suite.gate + (suite.note ? '\n  note: ' + suite.note : ''));
  }
  console.log('# ' + suites.length + ' opt-in suites (' + INVENTORY.length + ' in the inventory); ' +
    suites.filter(s => s.own.length).length + ' start their own containers');
}

async function until (probe, what, ms = 60000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(what + ' not ready after ' + ms + ' ms' + (last ? ': ' + last.message : ''));
}

function publishedPort (id, port) {
  const line = docker(['port', id, port + '/tcp']).split('\n')[0];
  const value = Number(line.split(':').pop());
  if (!Number.isInteger(value) || value <= 0) throw new Error('docker port ' + id + ' ' + port + ': ' + JSON.stringify(line));
  return value;
}

// Starts a container, records its id and anonymous volume ids, and returns
// the record. Secrets reach docker only through `-e NAME` (value from env).
function start (run, kind, { image, options = [], command = [], env = {} }) {
  const id = docker(['run', '--detach', '--label', LABEL + '=' + run.id, ...options, image, ...command],
    { env: { ...process.env, ...env } });
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('docker run ' + kind + ' returned ' + JSON.stringify(id));
  const volumes = docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', id])
    .split(' ').filter(Boolean);
  const record = { kind, id, volumes, image };
  run.created.push(record);
  log('started ' + kind + ' container ' + id + (volumes.length ? ' with anonymous volumes ' + volumes.join(', ') : ''));
  return record;
}

async function provisionPostgres (run) {
  const password = crypto.randomBytes(24).toString('hex');
  const record = start(run, 'postgres', { image: IMAGES.postgres,
    options: ['--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB'],
    env: { POSTGRES_PASSWORD: password, POSTGRES_DB: POSTGRES_DATABASE } });
  // The container's init pass starts a socket-only server and restarts; wait
  // for the TCP listener and for a real session, the way the fixtures do.
  const port = publishedPort(record.id, 5432);
  const uri = 'postgres://postgres:' + password + '@127.0.0.1:' + port + '/' + POSTGRES_DATABASE;
  await until(() => !dockerFails(['exec', record.id, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', POSTGRES_DATABASE]), 'postgres');
  await until(() => reachablePostgres(uri).then(() => true), 'postgres session');
  log('postgres ready on 127.0.0.1:' + port);
  return uri;
}

async function reachablePostgres (uri) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: uri, connectionTimeoutMillis: 3000 });
  try { await client.connect(); await client.query('SELECT 1'); } finally { await client.end().catch(() => {}); }
}

async function reachableMongo (uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
  try { await client.connect(); await client.db().admin().ping(); } finally { await client.close().catch(() => {}); }
}

async function provisionMongo (run) {
  const record = start(run, 'mongo', { image: IMAGES.mongo,
    options: ['--publish', '127.0.0.1::27017', '--ulimit', 'nofile=64000:64000'] });
  const port = publishedPort(record.id, 27017);
  const uri = 'mongodb://127.0.0.1:' + port + '/multitenant_test';
  await until(() => reachableMongo(uri).then(() => true), 'mongo');
  log('mongo ready on 127.0.0.1:' + port);
  return uri;
}

async function provisionVault (run) {
  const token = crypto.randomBytes(32).toString('hex');
  const record = start(run, 'vault', { image: IMAGES.vault,
    options: ['--publish', '127.0.0.1::8200', '--env', 'VAULT_DEV_ROOT_TOKEN_ID'],
    command: ['server', '-dev', '-dev-listen-address=0.0.0.0:8200'], env: { VAULT_DEV_ROOT_TOKEN_ID: token } });
  const port = publishedPort(record.id, 8200);
  const address = 'http://127.0.0.1:' + port;
  await until(async () => {
    const response = await fetch(address + '/v1/sys/health', { signal: AbortSignal.timeout(1000) });
    await response.body.cancel();
    return response.ok;
  }, 'vault');
  log('vault ready on 127.0.0.1:' + port);
  return { address, token };
}

// Removes what this run created, by id, and verifies each container and
// volume is gone. Returns the list of anything still present.
function teardown (run) {
  const remaining = [];
  for (const record of run.created.slice().reverse()) {
    const failed = dockerFails(['rm', '--force', '--volumes', record.id]);
    if (failed && !/No such container/i.test(String(failed.stderr))) log('docker rm ' + record.id + ': ' + String(failed.stderr).trim());
    const present = [];
    if (!dockerFails(['inspect', '--type', 'container', record.id])) present.push('container ' + record.id);
    for (const volume of record.volumes) if (!dockerFails(['volume', 'inspect', volume])) present.push('volume ' + volume);
    remaining.push(...present);
    run.removed.push({ kind: record.kind, id: record.id, volumes: record.volumes, verifiedAbsent: !present.length });
    log('removed ' + record.kind + ' ' + record.id + (present.length ? ', STILL PRESENT: ' + present.join(', ') : ', container and volumes verified absent'));
  }
  return remaining;
}

function mochaArgs (files) {
  const tier = tiers.MAP.tiers[TIER];
  // The tier's first and last files (the shared-database safety gate and its
  // clean-up) guard a database the operator owns; this run's databases are
  // created and destroyed here, so they are not needed.
  const args = ['--fail-zero', '--reporter', './scripts/execution-reporter.js', '--timeout', String(tier.timeout)];
  (tier.require || []).forEach(r => args.push('--require', r));
  if (tier.exit) args.push('--exit');
  return args.concat(files.map(f => './' + f));
}

function runMocha (files, env, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/mocha/bin/mocha.js'), ...mochaArgs(files)],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    signal.child = child;
    child.on('error', reject);
    child.on('exit', (code, sig) => {
      // The Spec epilogue: "  N passing (time)", "  N pending", "  N failing".
      const counts = { passing: 0, pending: 0, failing: 0 };
      for (const line of output.split('\n')) {
        const m = /^\s*(\d+) (passing|pending|failing)\b/.exec(line);
        if (m) counts[m[2]] = Number(m[1]);
      }
      resolve({ status: code === null ? 1 : code, signal: sig, ...counts });
    });
  });
}

async function main (argv) {
  const options = parseArgs(argv);
  if (!options) return usage();
  const problems = checkInventory();
  if (problems.length) {
    problems.forEach(p => log(p));
    return 2;
  }
  const suites = select(options.only);
  if (options.list) { list(suites); return 0; }
  if (!suites.length) {
    log('no suite matches --only ' + options.only.map(o => JSON.stringify(o)).join(' ') + '; nothing ran');
    return 2;
  }
  if (dockerFails(['version', '--format', '{{.Server.Version}}'])) {
    log('docker is not available; every suite in the corpus needs it');
    return 2;
  }

  const needs = new Set(suites.flatMap(suite => suite.shared));
  const run = { id: crypto.randomBytes(6).toString('hex'), startedAt: new Date().toISOString(), suites: suites.map(s => s.file),
    created: [], removed: [], env: {} };
  const env = { ...process.env, ...parseEnv(fs.readFileSync(ENV_FILE, 'utf8')) };
  // Nothing in this run may reach a MongoDB the caller did not name: the env
  // file's default points at whatever listens on 127.0.0.1:27017.
  delete env.CUSTOMCONNSTR_mongo;
  // The CI jobs run every tier under TZ=UTC; the corpus runs the same way
  // wherever the machine's zone points, so a zone-dependent suite fails
  // the same way locally as it would in CI.
  env.TZ = 'UTC';
  for (const suite of suites) Object.assign(env, suite.flags);

  const signal = { child: null };
  let interrupted = null;
  const onSignal = name => { interrupted = name; if (signal.child) signal.child.kill('SIGTERM'); };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  let status = 2;
  try {
    if (needs.has('postgres')) {
      if (process.env.NS_TEST_POSTGRES_ADMIN_URI) {
        try { await reachablePostgres(process.env.NS_TEST_POSTGRES_ADMIN_URI); } catch (error) {
          log('NS_TEST_POSTGRES_ADMIN_URI is set but no PostgreSQL session could be opened on it (' + error.message + '); nothing ran');
          return 2;
        }
        run.env.NS_TEST_POSTGRES_ADMIN_URI = 'caller-provided';
        log('using the caller\'s NS_TEST_POSTGRES_ADMIN_URI (no PostgreSQL container started)');
      } else {
        env.NS_TEST_POSTGRES_ADMIN_URI = await provisionPostgres(run);
        run.env.NS_TEST_POSTGRES_ADMIN_URI = 'disposable';
      }
    }
    if (needs.has('mongo')) {
      if (process.env.CUSTOMCONNSTR_mongo) {
        try { await reachableMongo(process.env.CUSTOMCONNSTR_mongo); } catch (error) {
          log('CUSTOMCONNSTR_mongo is set but no MongoDB answered on it (' + error.message + '); nothing ran');
          return 2;
        }
        env.CUSTOMCONNSTR_mongo = process.env.CUSTOMCONNSTR_mongo;
        run.env.CUSTOMCONNSTR_mongo = 'caller-provided';
        log('using the caller\'s CUSTOMCONNSTR_mongo (no MongoDB container started)');
      } else {
        env.CUSTOMCONNSTR_mongo = await provisionMongo(run);
        run.env.CUSTOMCONNSTR_mongo = 'disposable';
      }
    }
    if (needs.has('vault')) {
      const vault = await provisionVault(run);
      for (const suite of suites) {
        if (!suite.vaultEnv) continue;
        env[suite.vaultEnv.address] = vault.address;
        env[suite.vaultEnv.token] = vault.token;
        run.env[suite.vaultEnv.address] = 'disposable';
      }
    }
    if (interrupted) throw new Error('interrupted by ' + interrupted + ' during provisioning');

    log('running ' + suites.length + ' suites with ' + Object.keys(env).filter(k => /^NS_/.test(k)).sort().join(' '));
    const result = await runMocha(suites.map(s => s.file), env, signal);
    run.result = result;
    if (interrupted) {
      log('interrupted by ' + interrupted);
      status = 1;
    } else if (result.status !== 0) {
      log('mocha exited ' + result.status + ' (' + result.passing + ' passing, ' + result.pending + ' pending, ' + result.failing + ' failing)');
      status = 1;
    } else if (!result.passing) {
      log('zero tests passed (' + result.pending + ' pending); a run that executes nothing is not green');
      status = 1;
    } else {
      log(result.passing + ' passing, ' + result.pending + ' pending, ' + result.failing + ' failing');
      status = 0;
    }
  } catch (error) {
    log(error.message);
    status = 2;
  } finally {
    const remaining = teardown(run);
    run.finishedAt = new Date().toISOString();
    run.remaining = remaining;
    if (remaining.length) {
      log('teardown could not verify absence of: ' + remaining.join(', ') + ' (docker ps -a --filter label=' + LABEL + '=' + run.id + ')');
      if (status === 0) status = 1;
    } else if (run.created.length) {
      log('every container and volume this run created is verified absent');
    }
    if (options.record) {
      fs.writeFileSync(options.record, JSON.stringify({ ...run, status }, null, 2) + '\n');
      log('run record written to ' + options.record);
    }
  }
  return status;
}

module.exports = { INVENTORY, checkInventory, classifyOptInSource, select, mochaArgs };

if (require.main === module) {
  main(process.argv.slice(2)).then(status => { process.exitCode = status; }, error => {
    log(error.stack || error.message);
    process.exitCode = 2;
  });
}
