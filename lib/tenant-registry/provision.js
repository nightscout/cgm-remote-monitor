'use strict';

// Tenant provisioning (decision provisioning-split): the implementation behind
// the admin role's provisioning operation. No other caller writes these rows.
//
// One tenant, idempotency key = its id:
//   1. validate; read what the registry holds for the id and the hosts.
//      Same id, same hosts, active  -> 'existing', nothing written.
//      Same id, other hosts, or removed, or a host bound to another tenant
//                                   -> refused, nothing written.
//   2. Vault: create-or-adopt the tenant's one Transit key, `data`
//      (aes256-gcm96, rules.vaultKey), which encrypts its stored secrets. An
//      adopted key must have the expected type. Token-signing keys are not in
//      Vault: they are derived in process from the deployment signing secret
//      (decision deployment-signing-secret) at the tenant's signing version,
//      and only their public keys are written (step 3).
//   3. ONE PostgreSQL transaction, all or nothing: the registry row, hosts and
//      public keys; the encrypted root secret record and its audit; the legacy
//      root reference; anonymous access denied; the owner policy; access tenant
//      and key rows; the write clock; one checkpoint per configured consumer; the
//      lifecycle window (lock key by rule); the activity row and its audit;
//      the tenant settings row (version 1, no owner values: every setting at
//      its operator or shipped default), its history row, and the operator
//      policy row (generation 1, no rule), so every settings reader (api
//      display, evaluator, realtime) finds the tenant's settings at once.
// The registry row is the commit point: a failure anywhere leaves no registry
// row and no row of step 3. Vault keys from step 2 remain and are adopted by a
// re-run, which then yields the state a clean run yields.
//
// Operator inspection (`inspect`): what the registry, the provisioning tables
// and Vault hold for one id, classified, with the action that is safe next.
// It reads only, and reports presence, never a value:
//   absent      nothing anywhere                       -> provision
//   residue     Vault keys of an interrupted run, no row -> provision (adopts them)
//   complete    registry entry, every record, its key  -> none
//   incomplete  a record or key missing or of the wrong shape, or tenant rows
//               with no registry entry                 -> operator (never repaired here)
//   removed     removed from the registry              -> none
//   unverified  Vault could not be read                -> inspect-again
//
// Bootstrap (decision one-call-usable-provisioning), optional per tenant:
//   bootstrap: { owner: { consumer, principal?, name?, delegable? },
//                subject: { name, role: { name, permissions } } }
// In the same transaction as step 3: the role; the owner subject and the data
// subject (each with its legacy credential row and verifiers); the data
// subject's role link; the owner actor (delegable defaults to the catalogue);
// the owner's configure authority when that namespace is configured; and the
// subject-admin audit rows (create-role, create, owner-add). The role, the
// owner's delegation and the data subject's grant must fit the catalogue.
// 'created' returns { ownerSubject, subject, accessToken, jwt, jwtExpiresAt }:
// the shipping subject access token (derived from the root secret, never
// stored) and a data JWT for the subject (8 h, signed with the tenant's derived
// data key, as the api's exchange issues it). A retry answers 'existing' with
// the same subject ids and a fresh data JWT, never the access token: the
// provisioning identity can encrypt but not decrypt the root secret, so it
// cannot reveal that credential twice, and it never mints a second one.
// Not provisioning: access credentials and management sessions (the private
// management-session resource issues those), and data.
//
// After each 'created' commit, the optional afterCommit(tenantId) hook runs,
// off the caller's stack; it never delays, fails or changes the result.
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const rules = require('./rules');
const provisionLock = require('./provision-lock');
const { hostname } = require('../tenant-resolution');
const { createVaultKeys } = require('./vault-keys');
const { createVaultTransit } = require('../secrets/vault-transit');
const { createSecrets } = require('../secrets/component');
const activity = require('../tenant-activity/provisioning');
const ownerPolicy = require('../subject-admin/owner-policy');
const { permissionsValid, permissionsContained } = require('../subject-admin/permission-implication');
const legacyVerifiers = require('../secrets/legacy-verifiers');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR = /^[a-zA-Z0-9_-]{1,128}$/;
const REF = /^[A-Za-z0-9_.-]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_HOSTS = 16;
const MAX_BATCH = 100;
const BATCH_CONCURRENCY = 4;
const NAMESPACES = ['registry', 'legacy', 'secrets', 'authorization', 'access', 'clock', 'control', 'settings', 'operatorPolicy'];
// Written only by bootstrap; absent, bootstrap writes no configure authority.
const OPTIONAL_NAMESPACES = ['ownerConfiguration'];
const ROOT_ID = 'root';
// Provisioning writes every tenant's signing keys at version 1 (registry
// signing_version); kids encode the version (lib/secrets/derived-signing.js).
const SIGNING_VERSION = 1;
const derivedSigning = require('../secrets/derived-signing');
const KIDS = Object.freeze(Object.fromEntries(derivedSigning.PURPOSES.map(purpose => [purpose, derivedSigning.kid(purpose, SIGNING_VERSION)])));
// Kids of the human OIDC session keys (purposes human-data, human-management).
const HUMAN_KIDS = Object.freeze({ data: KIDS['human-data'], management: KIDS['human-management'] });
const fail = (code, detail) => Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });
const q = name => '"' + name + '"';
// PostgreSQL classes 42 (undefined table, column or function; insufficient
// privilege) and 3F (missing schema): the catalogues or the deployment grants
// (registry.grants and provisionerGrants, including the registry functions'
// pinned search_path) are not what this release needs. Retrying cannot help.
const unprepared = error => typeof error?.code === 'string' && /^(42|3F)[0-9A-Z]{3}$/.test(error.code);

function namespaceOf (value) {
  if (!NAME.test(value || '') || value === 'public' || value === 'information_schema' || value.startsWith('pg_')) {
    throw new TypeError('Explicit provisioning namespaces required');
  }
  return value;
}

const plain = (value, required, optional = []) => !!value && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const displayName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
// The shipping token prefix of a display name (lib/subject-admin/postgres.js).
const tokenPrefix = name => name.toLowerCase().replace(/[\W]/g, '').substring(0, 10);

// The bootstrap block's shape. Catalogue containment is checked by provisioning.
function parseBootstrap (value) {
  const invalid = () => fail('TENANT_PROVISION_BOOTSTRAP_INVALID');
  if (!plain(value, ['owner', 'subject'])) throw invalid();
  const { owner, subject } = value;
  if (!plain(owner, ['consumer'], ['principal', 'name', 'delegable']) || !ACTOR.test(owner.consumer) ||
      (owner.principal !== undefined && (typeof owner.principal !== 'string' || !ACTOR.test(owner.principal))) ||
      (owner.name !== undefined && !displayName(owner.name)) ||
      (owner.delegable !== undefined && !permissionsValid(owner.delegable))) throw invalid();
  if (!plain(subject, ['name', 'role']) || !displayName(subject.name) || !plain(subject.role, ['name', 'permissions']) ||
      typeof subject.role.name !== 'string' || !ACTOR.test(subject.role.name) || !permissionsValid(subject.role.permissions)) throw invalid();
  if (owner.principal !== undefined && owner.principal === 'root') throw invalid();
  return Object.freeze({
    owner: Object.freeze({ consumer: owner.consumer, principal: owner.principal, name: owner.name === undefined ? 'owner' : owner.name,
      delegable: owner.delegable === undefined ? undefined : Object.freeze(owner.delegable.slice()) }),
    subject: Object.freeze({ name: subject.name, role: Object.freeze({ name: subject.role.name, permissions: Object.freeze(subject.role.permissions.slice()) }) })
  });
}

// A tenant request: { id, hosts, internalHost?, ref?, issueRootSecret?, bootstrap? }.
// Hosts are stored as the resolver reads them: lower-case, no port.
function parseSpec (spec, { mode = 'direct-alias' } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
      Object.keys(spec).some(key => !['id', 'hosts', 'internalHost', 'ref', 'issueRootSecret', 'bootstrap'].includes(key))) throw fail('TENANT_PROVISION_INVALID');
  let id;
  try { id = rules.tenant(spec.id); } catch { throw fail('TENANT_PROVISION_INVALID'); }
  const hosts = spec.hosts === undefined ? [] : spec.hosts;
  if (!Array.isArray(hosts) || hosts.length > MAX_HOSTS) throw fail('TENANT_PROVISION_INVALID');
  const host = value => {
    if (typeof value !== 'string' || value.includes(':')) throw fail('TENANT_PROVISION_HOST_INVALID');
    try { return hostname(value); } catch { throw fail('TENANT_PROVISION_HOST_INVALID'); }
  };
  const aliases = hosts.map(host);
  const internal = spec.internalHost === undefined ? undefined : host(spec.internalHost);
  if (new Set([...aliases, ...(internal ? [internal] : [])]).size !== aliases.length + (internal ? 1 : 0)) throw fail('TENANT_PROVISION_HOST_INVALID');
  if (mode === 'direct-alias' ? (!aliases.length || internal !== undefined) : internal === undefined) throw fail('TENANT_PROVISION_HOST_INVALID');
  if (spec.ref !== undefined && (typeof spec.ref !== 'string' || !REF.test(spec.ref))) throw fail('TENANT_PROVISION_INVALID');
  if (spec.issueRootSecret !== undefined && typeof spec.issueRootSecret !== 'boolean') throw fail('TENANT_PROVISION_INVALID');
  const bootstrap = spec.bootstrap === undefined ? undefined : parseBootstrap(spec.bootstrap);
  return Object.freeze({ id, aliases: Object.freeze(aliases.slice().sort()), internal, ref: spec.ref, issueRootSecret: spec.issueRootSecret === true, bootstrap });
}

// Same pre-dispatch batch check used by runtime and published plan checking.
function checkBatch (inputs, { mode = 'direct-alias' } = {}) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_BATCH) throw fail('TENANT_PROVISION_BATCH_INVALID');
  const ids = new Set(), hosts = new Set();
  for (const input of inputs) {
    let spec; try { spec = parseSpec(input, { mode }); } catch { continue; }
    if (ids.has(spec.id)) throw fail('TENANT_PROVISION_BATCH_DUPLICATE');
    ids.add(spec.id);
    for (const host of [...spec.aliases, ...(spec.internal ? [spec.internal] : [])]) {
      if (hosts.has(host)) throw fail('TENANT_PROVISION_BATCH_DUPLICATE');
      hosts.add(host);
    }
  }
  return inputs;
}

function selectedNamespaces (namespaces) {
  const ns = Object.fromEntries(NAMESPACES.map(name => [name, namespaceOf(namespaces?.[name])]));
  for (const name of OPTIONAL_NAMESPACES) if (namespaces?.[name] !== undefined) ns[name] = namespaceOf(namespaces[name]);
  return ns;
}

function provisionerGrants ({ namespaces, role, checkpoints = [], intakeProfile }) {
  if (!NAME.test(role || '')) throw new TypeError('Explicit provisioning role required');
  const ns = selectedNamespaces(namespaces);
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const statements = [];
  const usage = new Set([...Object.values(ns), ...checkpoints.map(row => namespaceOf(row.namespace))]);
  for (const name of usage) statements.push('GRANT USAGE ON SCHEMA ' + q(name) + ' TO ' + q(role));
  statements.push(...require('./provision-residue').grantReads(ns,role));
  statements.push(...require('./postgres').grants({ namespace: ns.registry, provisioner: role }).filter(sql => /^(GRANT|REVOKE) /.test(sql)));
  statements.push(
    'GRANT SELECT, INSERT ON ' + t('legacy', 'legacy_data_keys') + ', ' + t('legacy', 'legacy_credential_config') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('secrets', 'secret_records') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('secrets', 'secret_audit') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('authorization', 'tenant_authorization_config') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('authorization', 'tenant_owner_policy') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('access', 'access_tenants') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('access', 'access_keys') + ' TO ' + q(role),
    // Signing-version rotation retires the previous key rows (rotateSigning).
    'GRANT UPDATE (active, signing) ON ' + t('legacy', 'legacy_data_keys') + ' TO ' + q(role),
    'GRANT UPDATE (active) ON ' + t('access', 'access_keys') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('clock', 'tenant_write_clock') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('control', 'tenant_lifecycle_windows') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('control', 'tenant_activity') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('control', 'tenant_activity_audit') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('settings', 'tenant_settings') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('settings', 'tenant_settings_history') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('operatorPolicy', 'tenant_operator_policy') + ' TO ' + q(role),
    // Removal reads whether the tenant's deletion ceremony has executed.
    'GRANT SELECT ON ' + t('control', 'tenant_lifecycle_ceremony') + ' TO ' + q(role),
    // Bootstrap: the initial role, subjects, owner actor and their audit; a
    // retry reads them back. No UPDATE or DELETE: provisioning only creates.
    'GRANT SELECT, INSERT ON ' + t('authorization', 'tenant_authorization_roles') + ', ' + t('authorization', 'tenant_authorization_subjects') + ', ' +
      t('authorization', 'tenant_authorization_subject_roles') + ', ' + t('authorization', 'tenant_owner_actors') + ', ' + t('legacy', 'legacy_credential_subjects') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('authorization', 'tenant_subject_admin_audit') + ' TO ' + q(role));
  if (ns.ownerConfiguration) {
    statements.push('GRANT USAGE ON SCHEMA ' + q(ns.ownerConfiguration) + ' TO ' + q(role),
      'GRANT SELECT, INSERT ON ' + t('ownerConfiguration', 'tenant_owner_configuration_authority') + ' TO ' + q(role));
  }
  statements.push(...require('../tenant-settings/function-privileges').writerGrants({namespace:ns.settings,role}));
  if (intakeProfile !== undefined) {
    const selected = require('../pgstream/pool-intake-profile').validate(intakeProfile);
    if (selected.binding.lifecycleNamespace !== ns.control) throw new TypeError('Provisioning lifecycle profile mismatch');
    statements.push(...require('../tenant-lifecycle/pool-authority').grants({ namespace: ns.control, role }));
  }
  for (const row of checkpoints) statements.push('GRANT SELECT, INSERT ON ' + q(namespaceOf(row.namespace)) + '.tenant_consumer_checkpoint TO ' + q(role));
  return Object.freeze(statements);
}

// options:
//   connectionString  the provisioning identity (admin role), never a serving one
//   namespaces        { registry, legacy, secrets, authorization, access, clock, control, settings, operatorPolicy }
//   checkpoints       [{ namespace, consumer, digest }] one row per consumer per tenant
//   ownerCatalogue    the deployment owner-policy catalogue (default ['*'])
//   vault             { address, mount, getToken, timeoutMs?, allowInsecureLoopback? }
//   actor             { principal, consumer } recorded in the activity and secrets audits
//   mode              'direct-alias' | 'canonical-internal'
//   inject            test-only failure hook, called with each step name
//   afterCommit       optional (tenantId) => void, after each 'created' commit
//                     (the internal-hints post-commit sender's call point)
function createProvisioningState (ns, checkpoints) {
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  // The structural records one tenant has, by name: `any` (a row exists) and
  // `ok` (the shape provisioning wrote). A retry is idempotent only for a
  // structurally provisioned tenant. Do not silently repair an incomplete
  // record or replace its root secret. Values may legitimately have changed
  // since provisioning (settings, grants, pause/suspend, credentials); audit
  // retention is not a completeness test.
  const exists = (kind, table) => 'EXISTS (SELECT 1 FROM ' + t(kind, table) + ' WHERE tenant_id=$1)';
  const RECORDS = [
    ['registryKeys', exists('registry', 'tenant_registry_keys'), '(SELECT count(DISTINCT purpose)=3 FROM ' + t('registry', 'tenant_registry_keys') +
      " WHERE tenant_id=$1 AND purpose IN ('management','human-data','human-management'))"],
    ['legacyCredential', exists('legacy', 'legacy_credential_config'), '(SELECT cardinality(root_verifiers)=2 AND verifier_root_reference_id=root_reference_id FROM ' + t('legacy', 'legacy_credential_config') + ' WHERE tenant_id=$1)'],
    ['localDataKey', exists('legacy', 'legacy_data_keys'), 'EXISTS(SELECT 1 FROM ' + t('legacy', 'legacy_data_keys') + ' WHERE tenant_id=$1 AND active AND signing)'],
    // ok: no root reference without its secret record (a tenant may have none).
    ['rootSecret', exists('secrets', 'secret_records'), 'NOT EXISTS (SELECT 1 FROM ' + t('legacy', 'legacy_credential_config') + ' l WHERE tenant_id=$1 AND root_reference_id IS NOT NULL' +
      ' AND NOT EXISTS (SELECT 1 FROM ' + t('secrets', 'secret_records') + ' s WHERE s.tenant_id=l.tenant_id AND s.id=l.root_reference_id))'],
    ['authorizationConfig', exists('authorization', 'tenant_authorization_config')],
    ['ownerPolicy', exists('authorization', 'tenant_owner_policy')],
    ['accessTenant', exists('access', 'access_tenants')],
    ['accessKeys', exists('access', 'access_keys'), "NOT EXISTS (SELECT 1 FROM (VALUES ('" + KIDS.management + "','management'), ('" + KIDS['human-data'] + "','data'), ('" + KIDS['human-management'] + "','management')) AS wanted(kid,purpose)" +
      ' WHERE NOT EXISTS (SELECT 1 FROM ' + t('access', 'access_keys') + ' k WHERE k.tenant_id=$1 AND k.kid=wanted.kid AND k.purpose=wanted.purpose))'],
    ['writeClock', exists('clock', 'tenant_write_clock')],
    ['lifecycleWindow', exists('control', 'tenant_lifecycle_windows')],
    ['activity', exists('control', 'tenant_activity')],
    ['settings', exists('settings', 'tenant_settings')],
    ['operatorPolicy', exists('operatorPolicy', 'tenant_operator_policy')]
  ];
  async function records (client, id) {
    const values = [id];
    const columns = RECORDS.map(([, any, ok], index) => any + ' AS a' + index + ', ' + (ok || any) + ' AS k' + index);
    checkpoints.forEach((row, index) => {
      values.push(row.consumer);
      columns.push('EXISTS (SELECT 1 FROM ' + q(row.namespace) + '.tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$' + values.length + ') AS c' + index);
    });
    const found = (await client.query('SELECT ' + columns.join(', '), values)).rows[0];
    const out = {};
    RECORDS.forEach(([name], index) => { out[name] = { any: found['a' + index] === true, ok: found['k' + index] === true }; });
    out.checkpoints = checkpoints.map((row, index) => ({ consumer: row.consumer, any: found['c' + index] === true, ok: found['c' + index] === true }));
    return out;
  }
  const entries = found => [...RECORDS.map(([name]) => found[name]), ...found.checkpoints];

  // What the registry holds for an id and for the requested hosts.
  async function current (client, spec) {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [spec.id]);
    const tenant = (await client.query('SELECT state FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id = $1', [spec.id])).rows[0];
    const own = (await client.query('SELECT host, kind FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE tenant_id = $1 LIMIT 18', [spec.id])).rows;
    const wanted = [...spec.aliases, ...(spec.internal ? [spec.internal] : [])];
    const taken = (await client.query('SELECT host FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE host = ANY($1::text[]) AND tenant_id <> $2', [wanted, spec.id])).rows;
    const held = tenant?.state === 'removed' ? null : await records(client, spec.id);
    return { state: tenant?.state, own, taken: taken.map(row => row.host), records: held,
      complete: tenant?.state === 'active' && entries(held).every(entry => entry.ok),
      // Tenant rows with no registry entry: not written by provisioning (its
      // transaction commits them with the registry row or not at all).
      unregistered: tenant === undefined && (entries(held).some(entry => entry.any) || await require('./provision-residue').present(client,ns,spec.id)) };
  }
  function sameHosts (spec, own) {
    const aliases = own.filter(row => row.kind === 'alias').map(row => row.host).sort();
    const internal = own.filter(row => row.kind === 'internal').map(row => row.host);
    return JSON.stringify(aliases) === JSON.stringify(spec.aliases) && JSON.stringify(internal) === JSON.stringify(spec.internal ? [spec.internal] : []);
  }
  function decide (spec, found) {
    if (found.own.length > MAX_HOSTS + 1) return { outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' };
    if (found.state === 'removed') return { outcome: 'refused', code: 'TENANT_PROVISION_REMOVED' };
    if (found.state === 'active') {
      if (!sameHosts(spec, found.own) || found.taken.length) return { outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' };
      return found.complete ? { outcome: 'existing' } : { outcome: 'refused', code: 'TENANT_PROVISION_INCOMPLETE' };
    }
    if (found.taken.length) return { outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' };
    // Never adopt or overwrite rows this operation did not write.
    if (found.unregistered) return { outcome: 'refused', code: 'TENANT_PROVISION_INCOMPLETE' };
    return null;
  }

  return { current, decide, RECORDS };
}

// One provisioned checkpoint row. The evaluator's completed-work row (the
// pending binding) is created typed and pending: the provisioning transaction's
// mark, so the sweep finds the new tenant and the first write's mark finds it.
function checkpointInsert (row, pending, tenant, at) {
  const table = '"' + namespaceOf(row.namespace) + '".tenant_consumer_checkpoint';
  if (pending && row.namespace === pending.namespace && row.consumer === pending.consumer) {
    const typed = require('../writer-driven').provisionedRow(at);
    return { text: 'INSERT INTO ' + table + ' (tenant_id, consumer, contract_digest, checkpoint, ' + typed.columns + ') VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9::jsonb)',
      values: [tenant, row.consumer, row.digest, ...typed.values] };
  }
  return { text: 'INSERT INTO ' + table + ' (tenant_id, consumer, contract_digest, checkpoint, projection) VALUES ($1, $2, $3, 0, NULL)', values: [tenant, row.consumer, row.digest] };
}

function createProvisioning ({ connectionString, namespaces, checkpoints = [], ownerCatalogue = ['*'], vault, actor, mode = 'direct-alias',
  inject, now = Date.now, fetchImpl, intakeProfile, afterCommit, signing, accessTokens, pendingConsumer } = {}) {
  const ns = selectedNamespaces(namespaces);
  if (typeof signing?.key !== 'function' || !accessTokens) throw new TypeError('Provisioning requires the deployment signing keys and the data token realm');
  // The api's data JWT codec: the bootstrap token is the one its exchange issues.
  const dataTokens = require('../tenant-authorization/legacy-data-token').create({ issuer: accessTokens.issuer, audience: accessTokens.audience,
    now: () => Math.floor(now() / 1000) });
  if (intakeProfile !== undefined) {
    intakeProfile = require('../pgstream/pool-intake-profile').validate(intakeProfile);
    if (intakeProfile.binding.lifecycleNamespace !== ns.control) throw new TypeError('Provisioning lifecycle profile mismatch');
  }
  if (new Set(Object.values(ns)).size !== Object.keys(ns).length) throw new TypeError('Distinct provisioning namespaces required');
  if (afterCommit !== undefined && typeof afterCommit !== 'function') throw new TypeError('Provisioning afterCommit hook must be a function');
  if (!Array.isArray(checkpoints) || checkpoints.length > 8 || checkpoints.some(row => !row || !ACTOR.test(row.consumer || '') || !DIGEST.test(row.digest || '') ||
      Object.keys(row).sort().join(',') !== 'consumer,digest,namespace') || new Set(checkpoints.map(row => row.namespace + ' ' + row.consumer)).size !== checkpoints.length) {
    throw new TypeError('Provisioning checkpoints must be explicit { namespace, consumer, digest } rows');
  }
  checkpoints.forEach(row => namespaceOf(row.namespace));
  // Writer-driven input (lib/writer-driven): the evaluator's completed-work row
  // is created typed and pending in the provisioning transaction (the mark), so
  // the sweep finds the new tenant and the first write's mark finds its row.
  const pending = pendingConsumer === undefined ? null : require('../writer-driven').binding({ namespace: pendingConsumer.namespace, consumer: pendingConsumer.consumer });
  if (pending && !checkpoints.some(row => row.namespace === pending.namespace && row.consumer === pending.consumer)) throw new TypeError('Provisioning pending consumer must be a provisioned checkpoint');
  if (!actor || !ACTOR.test(actor.principal || '') || !ACTOR.test(actor.consumer || '')) throw new TypeError('Explicit provisioning actor required');
  if (!['direct-alias', 'canonical-internal'].includes(mode)) throw new TypeError('Invalid tenant resolution mode');
  if (inject !== undefined && typeof inject !== 'function') throw new TypeError('Provisioning failure hook must be a function');
  const digest = ownerPolicy.catalogueDigest(ownerCatalogue);
  const keys = createVaultKeys({ ...vault, ...(fetchImpl ? { fetchImpl } : {}) });
  const selectedPoolOptions = { connectionString, max: BATCH_CONCURRENCY, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    application_name: 'nightscout-admin-provisioning' };
  const pool = new Pool(selectedPoolOptions);
  require('../diagnostics/m7').observePool(pool, 'storage');
  pool.on('error', () => {});
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const step = async name => { if (inject) await inject(name); };

  const { current, decide, RECORDS } = createProvisioningState(ns, checkpoints);
  async function inspect (spec, held) {
    const client = held || await pool.connect(); let failure;
    try {
      await client.query('BEGIN READ ONLY');
      const found = await current(client, spec);
      await client.query('COMMIT');
      return found;
    } catch (error) { failure = error; throw error; } finally { if (!held) client.release(failure); }
  }
  async function commit (spec, client) {
    let rootSecret;
    await client.query('BEGIN');
    // Re-check inside the transaction; a concurrent provisioning of the
    // same id or host fails on a unique key and is re-decided by the caller.
    const found = await current(client, spec);
    const decided = decide(spec, found);
    if (decided) { await client.query('ROLLBACK'); return decided; }
    const id = spec.id, run = (sql, values) => client.query(sql, values);
    await run('INSERT INTO ' + t('registry', 'tenant_registry') + " (tenant_id, state, signing_version) VALUES ($1, 'active', $2)", [id, SIGNING_VERSION]);
    await client.run(() => step('registry'));
    for (const host of spec.aliases) await run('INSERT INTO ' + t('registry', 'tenant_registry_hosts') + " (host, tenant_id, kind) VALUES ($1, $2, 'alias')", [host, id]);
    if (spec.internal) await run('INSERT INTO ' + t('registry', 'tenant_registry_hosts') + " (host, tenant_id, kind) VALUES ($1, $2, 'internal')", [spec.internal, id]);
    // Public keys of the derived management and human OIDC (human-data,
    // human-management) signing keys; kids encode the signing version.
    const key = purpose => signing.key(id, purpose, SIGNING_VERSION);
    await run('INSERT INTO ' + t('registry', 'tenant_registry_keys') + " (tenant_id, purpose, kid, public_key) VALUES ($1, 'management', $2, $3)," +
      " ($1, 'human-data', $4, $5), ($1, 'human-management', $6, $7)",
      [id, KIDS.management, key('management').raw, KIDS['human-data'], key('human-data').raw, KIDS['human-management'], key('human-management').raw]);
    await client.run(() => step('hosts'));
    // The root secret: encrypted by the secrets component, its record and
    // audit written in this transaction.
    rootSecret = randomBytes(24).toString('hex');
    const secrets = createSecrets({ maxTokenLifetimeSeconds: 28800, now,
      store: { get: async () => undefined,
        insert: async record => run('INSERT INTO ' + t('secrets', 'secret_records') + ' (tenant_id, id, format, ciphertext) VALUES ($1, $2, $3, $4)', [record.tenant, record.id, record.format, record.ciphertext]) },
      audit: async event => run('INSERT INTO ' + t('secrets', 'secret_audit') + ' (event_id, tenant_id, principal, consumer, operation, secret_id, phase, event_time) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [randomUUID(), event.tenant, event.principal, event.consumer, event.operation, event.id, event.phase, event.time]),
      authorize: async (identity, action) => identity.tenant === id && identity.principal === actor.principal && identity.consumer === actor.consumer &&
        action.operation === 'encrypt' && action.id === ROOT_ID,
      providerFor: async tenant => createVaultTransit({ address: vault.address, mount: vault.mount, timeoutMs: vault.timeoutMs, allowInsecureLoopback: vault.allowInsecureLoopback,
        encryptionKey: rules.vaultKey(tenant, 'data'), getToken: vault.getToken }) });
    await client.run(() => secrets.encrypt({ tenant: id, principal: actor.principal, consumer: actor.consumer }, ROOT_ID, Buffer.from(rootSecret)));
    await client.run(() => step('secret'));
    const material = require('../secrets/legacy-verifiers').prepare(Buffer.from(rootSecret), []);
    await run('INSERT INTO ' + t('legacy', 'legacy_credential_config') + ' (tenant_id, root_reference_id, verifier_root_reference_id, root_verifiers) VALUES ($1, $2, $2, $3)', [id, ROOT_ID, material.rootVerifiers]);
    // The data JWT verification key (public only; the issuer derives the private key).
    await run('INSERT INTO ' + t('legacy', 'legacy_data_keys') + ' (tenant_id,kid,public_key,active,signing) VALUES ($1,$2,$3,true,true)',
      [id, KIDS.data, key('data').spki]);
    await run('INSERT INTO ' + t('authorization', 'tenant_authorization_config') + " (tenant_id, anonymous_roles) VALUES ($1, ARRAY['denied'])", [id]);
    await run('INSERT INTO ' + t('authorization', 'tenant_owner_policy') + ' (tenant_id, catalogue_digest, ceiling) VALUES ($1, $2, $3)', [id, digest, ownerCatalogue]);
    await client.run(() => step('authorization'));
    await run('INSERT INTO ' + t('access', 'access_tenants') + ' (tenant_id, active) VALUES ($1, true)', [id]);
    // The human session store accepts a human token only while its kid is an
    // active access key of the tenant (lib/human-session/postgres.js).
    await run('INSERT INTO ' + t('access', 'access_keys') + " (tenant_id, kid, purpose, active) VALUES ($1, $2, 'management', true)," +
      " ($1, $3, 'data', true), ($1, $4, 'management', true)", [id, KIDS.management, HUMAN_KIDS.data, HUMAN_KIDS.management]);
    await client.run(() => step('access'));
    await run('INSERT INTO ' + t('clock', 'tenant_write_clock') + ' (tenant_id, last_stamp) VALUES ($1, $2)', [id, now()]);
    for (const row of checkpoints) {
      const insert = checkpointInsert(row, pending, id, now());
      await run(insert.text, insert.values);
    }
    await client.run(() => step('clock'));
    await run('INSERT INTO ' + t('control', 'tenant_lifecycle_windows') + " (tenant_id, lock_key, phase, generation) VALUES ($1, $2, 'active', 1)", [id, rules.lockKey(id)]);
    // The activity row in the same transaction as the window row
    // (decision activity-row-always-provisioned).
    await activity.provisionInTransaction(run, { namespace: ns.control, tenant: id, principal: actor.principal, consumer: actor.consumer });
    await client.run(() => step('lifecycle'));
    // Settings (decision tenant-registry: settings come from the settings
    // store in registry mode): an empty owner document and an operator policy
    // with no deployment rule or override (the shape lib/tenant-settings
    // component.js requires); the effective value of every setting is its default.
    const at = now();
    await run('INSERT INTO ' + t('settings', 'tenant_settings') + " (tenant_id, version, values) VALUES ($1, 1, '{}'::jsonb)", [id]);
    await run('INSERT INTO ' + t('settings', 'tenant_settings_history') +
      " (tenant_id, version, values, principal, consumer, operation, event_time) VALUES ($1, 1, '{}'::jsonb, $2, $3, 'replace', $4)", [id, actor.principal, actor.consumer, at]);
    await run('INSERT INTO ' + t('operatorPolicy', 'tenant_operator_policy') +
      " (tenant_id, generation, policy, principal, consumer, event_time) VALUES ($1, 1, '{\"deployment\":{},\"overrides\":{}}'::jsonb, $2, $3, $4)", [id, actor.principal, actor.consumer, at]);
    await client.run(() => step('settings'));
    const bootstrap = spec.bootstrap ? await writeBootstrap(run, id, spec.bootstrap, rootSecret, at) : undefined;
    if (bootstrap) await client.run(() => step('bootstrap'));
    const committed = await run('COMMIT');
    if (committed.command !== 'COMMIT') throw fail('TENANT_PROVISION_ABORTED');
    // Issued after COMMIT: the token names rows that now exist. A new subject
    // and root are at credential and root version 1 (the column defaults).
    return { outcome: 'created', ...(spec.issueRootSecret ? { rootSecret } : {}),
      ...(bootstrap ? { bootstrap: Object.freeze({ ...bootstrap, ...dataJwt(id, bootstrap.subject, 1, 1) }) } : {}) };
  }

  // A data JWT for a bootstrap subject, as the api's exchange issues it.
  function dataJwt (id, subjectId, credentialVersion, rootVersion, key = signing.key(id, 'data', SIGNING_VERSION)) {
    const issued = dataTokens.issue(id, { kind: 'subject', subjectId, credentialVersion, rootVersion }, key);
    return { jwt: issued.token, jwtExpiresAt: issued.exp };
  }
  // The catalogue bounds every bootstrap grant, as the owner-aware writer would.
  function bootstrapAdmitted (bootstrap) {
    const delegable = bootstrap.owner.delegable || ownerCatalogue;
    return permissionsContained(bootstrap.subject.role.permissions, ownerCatalogue) && permissionsContained(delegable, ownerCatalogue);
  }
  const auditRow = (run, id, subjectId, operation, at, extra = {}) => run('INSERT INTO ' + t('authorization', 'tenant_subject_admin_audit') +
    ' (event_id, tenant_id, principal, consumer, subject_id, operation, event_time, outcome, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
  [randomUUID(), id, actor.principal, actor.consumer, subjectId, operation, at, extra.outcome || null, extra.detail ? JSON.stringify(extra.detail) : null]);
  async function writeSubject (run, id, subjectId, name, root, at) {
    const prefix = tokenPrefix(name);
    const [prepared] = legacyVerifiers.prepare(Buffer.from(root), [{ subjectId, tokenPrefix: prefix }]).subjects;
    await run('INSERT INTO ' + t('authorization', 'tenant_authorization_subjects') + ' (tenant_id, subject_id, display_name, notes, created_at) VALUES ($1,$2,$3,NULL,$4)',
      [id, subjectId, name, new Date(at).toISOString()]);
    await run('INSERT INTO ' + t('legacy', 'legacy_credential_subjects') + ' (tenant_id, subject_id, token_prefix, verifiers, verifier_token_prefix) VALUES ($1,$2,$3,$4,$3)',
      [id, subjectId, prefix, prepared.verifiers]);
    await auditRow(run, id, subjectId, 'create', at);
    return prefix;
  }
  async function writeBootstrap (run, id, bootstrap, root, at) {
    const { owner, subject } = bootstrap;
    const delegable = (owner.delegable || ownerCatalogue).slice();
    const ownerSubject = owner.principal || randomUUID().replaceAll('-', '');
    const dataSubject = randomUUID().replaceAll('-', '');
    await run('INSERT INTO ' + t('authorization', 'tenant_authorization_roles') + ' (tenant_id, name, permissions) VALUES ($1,$2,$3)',
      [id, subject.role.name, subject.role.permissions.slice()]);
    await auditRow(run, id, subject.role.name, 'create-role', at);
    await writeSubject(run, id, ownerSubject, owner.name, root, at);
    const prefix = await writeSubject(run, id, dataSubject, subject.name, root, at);
    await run('INSERT INTO ' + t('authorization', 'tenant_authorization_subject_roles') + ' (tenant_id, subject_id, role_name) VALUES ($1,$2,$3)',
      [id, dataSubject, subject.role.name]);
    await run('INSERT INTO ' + t('authorization', 'tenant_owner_actors') + ' (tenant_id, principal, consumer, active, can_update, delegable) VALUES ($1,$2,$3,true,true,$4)',
      [id, ownerSubject, owner.consumer, delegable]);
    const ownerKey = { principal: ownerSubject, consumer: owner.consumer };
    if (ns.ownerConfiguration) {
      await run('INSERT INTO ' + t('ownerConfiguration', 'tenant_owner_configuration_authority') + ' (tenant_id, principal, consumer, active, can_configure) VALUES ($1,$2,$3,true,true)',
        [id, ownerSubject, owner.consumer]);
    }
    await auditRow(run, id, ownerSubject, 'owner-add', at, { outcome: 'applied',
      detail: { owner: ownerKey, expected: [], before: [], after: [ownerKey], bootstrap: true, ...(ns.ownerConfiguration ? { configureGranted: true } : {}) } });
    return Object.freeze({ ownerSubject, subject: dataSubject,
      accessToken: legacyVerifiers.subjectToken(Buffer.from(root), { subjectId: dataSubject, tokenPrefix: prefix }) });
  }
  // A retry of a bootstrapped tenant: the subject ids provisioning wrote, read
  // back (provisioning is their only creator at creation), with the data
  // subject's current credential and root versions, or null when the tenant
  // holds no bootstrap matching the request. Never the access token.
  async function readBootstrap (client, id, bootstrap) {
    await client.query('BEGIN READ ONLY');
    try {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [id]);
      const owners = (await client.query('SELECT principal FROM ' + t('authorization', 'tenant_owner_actors') +
        ' WHERE tenant_id=$1 AND consumer=$2 AND active AND can_update' + (bootstrap.owner.principal ? ' AND principal=$3' : '') + ' ORDER BY principal',
      bootstrap.owner.principal ? [id, bootstrap.owner.consumer, bootstrap.owner.principal] : [id, bootstrap.owner.consumer])).rows;
      const subjects = (await client.query('SELECT s.subject_id, c.credential_version, r.root_version FROM ' + t('authorization', 'tenant_authorization_subjects') + ' s JOIN ' +
        t('authorization', 'tenant_authorization_subject_roles') + ' l ON l.tenant_id=s.tenant_id AND l.subject_id=s.subject_id JOIN ' +
        t('legacy', 'legacy_credential_subjects') + ' c ON c.tenant_id=s.tenant_id AND c.subject_id=s.subject_id JOIN ' +
        t('legacy', 'legacy_credential_config') + ' r ON r.tenant_id=s.tenant_id' +
        ' WHERE s.tenant_id=$1 AND s.display_name=$2 AND l.role_name=$3 ORDER BY s.subject_id', [id, bootstrap.subject.name, bootstrap.subject.role.name])).rows;
      // The current signer: a signing-version rotation moves it past version 1.
      const signers = (await client.query('SELECT kid, public_key FROM ' + t('legacy', 'legacy_data_keys') + ' WHERE tenant_id=$1 AND active AND signing', [id])).rows;
      await client.query('COMMIT');
      if (owners.length !== 1 || subjects.length !== 1 || signers.length !== 1) return null;
      const [row] = subjects;
      const key = signing.matching(id, 'data', { kid: signers[0].kid, publicKey: signers[0].public_key });
      return Object.freeze({ ownerSubject: owners[0].principal, subject: row.subject_id, ...dataJwt(id, row.subject_id, row.credential_version, row.root_version, key) });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  }

  // The tenant's Vault key (rules.PURPOSES: `data`), created or adopted. The
  // only Vault key step of provisioning.
  async function ensureVaultKeys (spec, held) {
    for (const [purpose, type] of Object.entries(rules.PURPOSES)) await held.run(() => keys.ensure(rules.vaultKey(spec.id, purpose), type, held.check));
  }

  async function provisionOne (input) {
    let spec;
    try { spec = parseSpec(input, { mode }); } catch (error) {
      return { id: typeof input?.id === 'string' ? input.id : null, ...(typeof input?.ref === 'string' && REF.test(input.ref) ? { ref: input.ref } : {}),
        outcome: 'refused', code: error.code || 'TENANT_PROVISION_INVALID' };
    }
    const base = { id: spec.id, ...(spec.ref ? { ref: spec.ref } : {}) };
    if (spec.bootstrap && !bootstrapAdmitted(spec.bootstrap)) return { ...base, outcome: 'refused', code: 'TENANT_PROVISION_BOOTSTRAP_FORBIDDEN' };
    let held, failure, locked = false, lifecycle = false, created;
    try {
      held = await require('./held-client').checkout(pool);
      await provisionLock.acquire(held, ns.registry, spec.id); locked = true;
      const early = decide(spec, await inspect(spec, held));
      if (early?.outcome === 'existing' && spec.bootstrap) {
        const bootstrap = await readBootstrap(held, spec.id, spec.bootstrap);
        return bootstrap ? { ...base, ...early, bootstrap } : { ...base, outcome: 'refused', code: 'TENANT_PROVISION_BOOTSTRAP_CONFLICT' };
      }
      if (early) return { ...base, ...early };
      await provisionLock.acquireLifecycle(held,spec.id); lifecycle = true;
      await held.run(() => step('vault'));
      await ensureVaultKeys(spec, held);
      await held.run(() => step('database'));
      try { created = { ...base, ...await commit(spec, held) }; return created; }
      catch (error) {
        // Updated same-id writers share the new pre-Vault fence. Distinct
        // tenants can still race for one host; classify that actual constraint
        // without querying an aborted/uncertain client.
        if (error?.code === '23505') {
          if (error.table === 'tenant_registry_hosts') throw fail('TENANT_PROVISION_CONFLICT');
          // Another tenant's window holds this id's derived lock key: not
          // retryable, an operator decision (the key is a fixed rule of the id).
          if (error.table === 'tenant_lifecycle_windows' && /lock_key/.test(error.constraint || '')) throw fail('TENANT_PROVISION_LOCK_COLLISION');
        }
        throw error;
      }
    } catch (error) {
      failure = error;
      const code = typeof error?.code === 'string' && /^TENANT_PROVISION_[A-Z_]{1,64}$/.test(error.code) ? error.code
        : unprepared(error) ? 'TENANT_PROVISION_STORE_UNPREPARED' : 'TENANT_PROVISION_FAILED';
      return Object.freeze({ ...base, outcome: 'refused', code });
    } finally {
      if (held) await provisionLock.finish(held,ns.registry,spec.id,locked,failure,lifecycle);
      if (created?.outcome === 'created' && afterCommit) setImmediate(() => { try { afterCommit(spec.id); } catch { /* advisory only */ } });
    }
  }

  return Object.freeze({
    provision: provisionOne,
    // At most MAX_BATCH tenants; duplicate ids or hosts refuse the whole batch
    // before any work. One result per tenant, in request order.
    async provisionBatch (inputs) {
      checkBatch(inputs, { mode });
      const settled = await require('../server/serve/tenant-startup').limited(inputs, BATCH_CONCURRENCY, provisionOne);
      return settled.map((result, index) => result.status === 'fulfilled' ? result.value
        : { id: typeof inputs[index]?.id === 'string' ? inputs[index].id : null, outcome: 'refused', code: 'TENANT_PROVISION_FAILED' });
    },
    // Removal (decisions preview-deletion-confirmation, deletion-request-auto-pauses):
    // the registry step after the tenant's deletion ceremony has executed. The
    // ceremony is the only path that erases a tenant (owner request, operator
    // confirmation, execution, which suspends the site); removal then deletes
    // the host rows and marks the registry row removed, in one transaction,
    // with the revision bump the triggers make. Serving roles stop within one
    // refresh interval. Vault keys, the lifecycle window, the activity row and
    // the ceremony record stay (30-day key retention is the ceremony's). A
    // removed id is never provisioned again (TENANT_PROVISION_REMOVED).
    //   'removed'   this call removed it
    //   'existing'  it was already removed (a retry)
    //   refused TENANT_NOT_FOUND | TENANT_REMOVAL_REQUIRES_DELETION
    async remove (id) {
      try { rules.tenant(id); } catch { throw fail('TENANT_PROVISION_INVALID'); }
      const client = await pool.connect(); let failure;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [id]);
        // Selected-v2 removal cannot race the tenant's exclusive recommission,
        // or treat a superseded historical deletion as current authority.
        if (intakeProfile !== undefined && !await require('./recommission').removalAdmission(client.query.bind(client), { namespace: ns.control, tenant: id })) {
          await client.query('ROLLBACK'); return { id, outcome: 'refused', code: 'TENANT_REMOVAL_REQUIRES_DELETION' };
        }
        const row = (await client.query('SELECT state FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id = $1 FOR UPDATE', [id])).rows[0];
        if (!row) { await client.query('ROLLBACK'); return { id, outcome: 'refused', code: 'TENANT_NOT_FOUND' }; }
        if (row.state === 'removed') { await client.query('ROLLBACK'); return { id, outcome: 'existing', state: 'removed' }; }
        const executed = (await client.query('SELECT 1 FROM ' + t('control', 'tenant_lifecycle_ceremony') +
          " WHERE tenant_id = $1 AND phase = 'executed' LIMIT 1", [id])).rows.length === 1;
        if (!executed) { await client.query('ROLLBACK'); return { id, outcome: 'refused', code: 'TENANT_REMOVAL_REQUIRES_DELETION' }; }
        await step('remove-check');
        await client.query('DELETE FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE tenant_id = $1', [id]);
        await step('remove-hosts');
        await client.query('UPDATE ' + t('registry', 'tenant_registry') + " SET state = 'removed', updated_at = clock_timestamp() WHERE tenant_id = $1", [id]);
        await step('remove-state');
        const committed = await client.query('COMMIT');
        if (committed.command !== 'COMMIT') throw fail('TENANT_PROVISION_ABORTED');
        return { id, outcome: 'removed', state: 'removed' };
      } catch (error) {
        failure = error;
        try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ }
        throw error;
      } finally { client.release(failure); }
    },
    // Signing-version rotation (decision deployment-signing-secret: the
    // per-tenant version in PostgreSQL is the revocation and rotation lever).
    // In one transaction, under the provisioning and lifecycle locks: the
    // registry signing_version moves to v (one past every version the tenant
    // has used, so a recommission's data key is never reused); the registry
    // gains the management and human key rows at v and the access store their
    // grants, the old grants deactivated; the data JWT key at v becomes the
    // only active signer. The registry row change bumps the revision, so
    // serving caches refresh. Tokens and sessions under an older kid stop
    // verifying at once; issuance uses v. No Vault call.
    //   'rotated'  { signingVersion: v }
    //   refused TENANT_NOT_FOUND | TENANT_SIGNING_ROTATION_REQUIRES_ACTIVE | TENANT_PROVISION_BUSY
    async rotateSigning (id) {
      try { rules.tenant(id); } catch { throw fail('TENANT_PROVISION_INVALID'); }
      const client = await pool.connect(); let failure, locked = false, lifecycle = false, began = false;
      try {
        try {
          await provisionLock.acquire(client, ns.registry, id); locked = true;
          await provisionLock.acquireLifecycle(client, id); lifecycle = true;
        } catch (error) { if (error?.code === 'TENANT_PROVISION_BUSY') return { id, outcome: 'refused', code: 'TENANT_PROVISION_BUSY' }; throw error; }
        await client.query('BEGIN'); began = true;
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [id]);
        const row = (await client.query('SELECT state, signing_version FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id = $1 FOR UPDATE', [id])).rows[0];
        if (!row || row.state !== 'active') {
          await client.query('ROLLBACK'); began = false;
          return { id, outcome: 'refused', code: row ? 'TENANT_SIGNING_ROTATION_REQUIRES_ACTIVE' : 'TENANT_NOT_FOUND' };
        }
        const kids = (await client.query('SELECT kid FROM ' + t('registry', 'tenant_registry_keys') + ' WHERE tenant_id = $1 UNION ALL SELECT kid FROM ' +
          t('legacy', 'legacy_data_keys') + ' WHERE tenant_id = $1 UNION ALL SELECT kid FROM ' + t('access', 'access_keys') + ' WHERE tenant_id = $1', [id])).rows;
        const version = Math.max(row.signing_version, ...kids.map(entry => derivedSigning.parseKid(entry.kid)?.version || 0)) + 1;
        const key = purpose => signing.key(id, purpose, version);
        const updated = await client.query('UPDATE ' + t('registry', 'tenant_registry') + ' SET signing_version = $2, updated_at = clock_timestamp() WHERE tenant_id = $1', [id, version]);
        if (updated.rowCount !== 1) throw fail('TENANT_PROVISION_FAILED');
        await step('rotate-registry');
        await client.query('INSERT INTO ' + t('registry', 'tenant_registry_keys') + " (tenant_id, purpose, kid, public_key) VALUES ($1, 'management', $2, $3)," +
          " ($1, 'human-data', $4, $5), ($1, 'human-management', $6, $7)",
        [id, key('management').kid, key('management').raw, key('human-data').kid, key('human-data').raw, key('human-management').kid, key('human-management').raw]);
        await client.query('UPDATE ' + t('legacy', 'legacy_data_keys') + ' SET active = false, signing = false WHERE tenant_id = $1 AND (active OR signing)', [id]);
        await client.query('INSERT INTO ' + t('legacy', 'legacy_data_keys') + ' (tenant_id,kid,public_key,active,signing) VALUES ($1,$2,$3,true,true)', [id, key('data').kid, key('data').spki]);
        await step('rotate-data');
        await client.query('UPDATE ' + t('access', 'access_keys') + ' SET active = false WHERE tenant_id = $1 AND active', [id]);
        await client.query('INSERT INTO ' + t('access', 'access_keys') + " (tenant_id, kid, purpose, active) VALUES ($1, $2, 'management', true)," +
          " ($1, $3, 'data', true), ($1, $4, 'management', true)", [id, key('management').kid, key('human-data').kid, key('human-management').kid]);
        await step('rotate-access');
        const committed = await client.query('COMMIT'); began = false;
        if (committed.command !== 'COMMIT') throw fail('TENANT_PROVISION_ABORTED');
        return { id, outcome: 'rotated', signingVersion: version };
      } catch (error) {
        failure = error;
        if (began) { try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ } }
        throw error;
      } finally { await provisionLock.finish(client, ns.registry, id, locked, failure, lifecycle); }
    },
    // Operator inspection of one id (see the head of this file). Presence only:
    // no key material, secret, setting or credential value is returned.
    async inspect (id) {
      try { rules.tenant(id); } catch { throw fail('TENANT_PROVISION_INVALID'); }
      let found;
      try { found = await inspect({ id, aliases: [], internal: undefined }); }
      catch (error) { throw unprepared(error) ? fail('TENANT_PROVISION_STORE_UNPREPARED') : error; }
      const state = presence => presence.ok ? 'present' : presence.any ? 'partial' : 'absent';
      const held = found.records ? { ...Object.fromEntries(RECORDS.map(([name]) => [name, state(found.records[name])])),
        // A tenant may hold no root secret; `partial` is a root reference without its record.
        rootSecret: found.records.rootSecret.any ? (found.records.rootSecret.ok ? 'present' : 'partial') : (found.records.rootSecret.ok ? 'absent' : 'partial'),
        checkpoints: Object.fromEntries(found.records.checkpoints.map(row => [row.consumer, state(row)])) } : undefined;
      const internal = found.own.find(entry => entry.kind === 'internal');
      const registry = { state: found.state || null, hosts: found.own.filter(entry => entry.kind === 'alias').map(entry => entry.host).sort(),
        ...(internal ? { internalHost: internal.host } : {}) };
      const vaultKeys = {}; let vaultStatus = 'read';
      try {
        for (const [purpose, type] of Object.entries(rules.PURPOSES)) vaultKeys[purpose] = await keys.status(rules.vaultKey(id, purpose), type);
      } catch (error) { vaultStatus = error?.code === 'TENANT_PROVISION_VAULT_REFUSED' ? 'refused' : 'unavailable'; }
      const vaultView = { status: vaultStatus, ...(vaultStatus === 'read' ? { keys: vaultKeys } : {}) };
      const answer = (provisioning, action, findings = []) => Object.freeze({ id, provisioning, action, registry, ...(held ? { records: held } : {}), vault: vaultView, findings });
      if (found.state === 'removed') return answer('removed', 'none');
      const findings = [];
      const rows = held ? [...RECORDS.map(([name]) => [name, held[name]]), ...Object.entries(held.checkpoints).map(([consumer, value]) => ['checkpoint:' + consumer, value])] : [];
      if (found.state === 'active') {
        for (const [name, value] of rows) if (name !== 'rootSecret' && value !== 'present') findings.push('record:' + name + ':' + (value === 'absent' ? 'missing' : value));
        if (!found.records.rootSecret.ok) findings.push('record:rootSecret:missing');
      } else {
        for (const [name, value] of rows) if (value !== 'absent') findings.push('record:' + name + ':unregistered');
      }
      if (found.unregistered && !findings.length) findings.push('record:retained:unregistered');
      if (vaultStatus !== 'read') return answer('unverified', findings.length ? 'operator' : 'inspect-again', [...findings, 'vault:' + vaultStatus]);
      const present = Object.values(vaultKeys).filter(value => value === 'present').length;
      for (const [purpose, value] of Object.entries(vaultKeys)) {
        if (value === 'mismatch' || (found.state === 'active' && value !== 'present')) findings.push('vault:' + purpose + ':' + (value === 'absent' ? 'missing' : value));
      }
      if (findings.length) return answer('incomplete', 'operator', findings);
      if (found.state === 'active') return answer('complete', 'none');
      return present ? answer('residue', 'provision') : answer('absent', 'provision');
    },
    // The registry's view of one tenant: { id, state, hosts, internalHost } or null.
    async get (id) {
      try { rules.tenant(id); } catch { throw fail('TENANT_PROVISION_INVALID'); }
      const client = await pool.connect(); let failure;
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [id]);
        const row = (await client.query('SELECT state, signing_version FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id = $1', [id])).rows[0];
        const own = (await client.query('SELECT host, kind FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE tenant_id = $1 ORDER BY host', [id])).rows;
        await client.query('COMMIT');
        if (!row) return null;
        const internal = own.find(entry => entry.kind === 'internal');
        return Object.freeze({ id, state: row.state, signingVersion: row.signing_version, hosts: own.filter(entry => entry.kind === 'alias').map(entry => entry.host),
          ...(internal ? { internalHost: internal.host } : {}) });
      } catch (error) { failure = error; throw error; } finally { client.release(failure); }
    },
    close: () => pool.end()
  });
}

module.exports = { createProvisioning, checkpointInsert, provisionerGrants, parseSpec, checkBatch, MAX_BATCH, MAX_HOSTS, ROOT_ID, HUMAN_KIDS, KIDS, SIGNING_VERSION };
