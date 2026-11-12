'use strict';

// Tenant provisioning (decision provisioning-split): the implementation behind
// the admin role's provisioning operation. No other caller writes these rows.
//
// One tenant, idempotency key = its id:
//   1. validate; read what the registry holds for the id and the hosts.
//      Same id, same hosts, active  -> 'existing', nothing written.
//      Same id, other hosts, or removed, or a host bound to another tenant
//                                   -> refused, nothing written.
//   2. Vault: create-or-adopt the six Transit keys named by rules.vaultKey
//      (data, signing: aes256-gcm96; access, management, human-data,
//      human-management: ed25519) and read the public keys. Adopted keys must
//      have the expected type.
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
// Not provisioning (lab priming; the bench and lab harness do it through the
// tenant's own data API): subjects, roles, owner actors, access credentials and
// sessions, tokens and data.
const { randomBytes, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const rules = require('./rules');
const { hostname } = require('../tenant-resolution');
const { createVaultKeys } = require('./vault-keys');
const { createVaultTransit } = require('../secrets/vault-transit');
const { createSecrets } = require('../secrets/component');
const activity = require('../tenant-activity/provisioning');
const ownerPolicy = require('../subject-admin/owner-policy');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR = /^[a-zA-Z0-9_-]{1,128}$/;
const REF = /^[A-Za-z0-9_.-]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_HOSTS = 16;
const MAX_BATCH = 100;
const BATCH_CONCURRENCY = 4;
const NAMESPACES = ['registry', 'legacy', 'secrets', 'authorization', 'access', 'clock', 'control', 'settings', 'operatorPolicy'];
const ROOT_ID = 'root';
// Kids of the human OIDC session keys (purposes human-data, human-management).
const HUMAN_KIDS = Object.freeze({ data: 'human-data-1', management: 'human-management-1' });
const fail = (code, detail) => Object.assign(new Error(code), { code, ...(detail ? { detail } : {}) });
const q = name => '"' + name + '"';

function namespaceOf (value) {
  if (!NAME.test(value || '') || value === 'public' || value === 'information_schema' || value.startsWith('pg_')) {
    throw new TypeError('Explicit provisioning namespaces required');
  }
  return value;
}

// A tenant request: { id, hosts, internalHost?, ref?, issueRootSecret? }.
// Hosts are stored as the resolver reads them: lower-case, no port.
function parseSpec (spec, { mode = 'direct-alias' } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
      Object.keys(spec).some(key => !['id', 'hosts', 'internalHost', 'ref', 'issueRootSecret'].includes(key))) throw fail('TENANT_PROVISION_INVALID');
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
  return Object.freeze({ id, aliases: Object.freeze(aliases.slice().sort()), internal, ref: spec.ref, issueRootSecret: spec.issueRootSecret === true });
}

function provisionerGrants ({ namespaces, role, checkpoints = [] }) {
  if (!NAME.test(role || '')) throw new TypeError('Explicit provisioning role required');
  const ns = Object.fromEntries(NAMESPACES.map(name => [name, namespaceOf(namespaces?.[name])]));
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const statements = [];
  const usage = new Set([...Object.values(ns), ...checkpoints.map(row => namespaceOf(row.namespace))]);
  for (const name of usage) statements.push('GRANT USAGE ON SCHEMA ' + q(name) + ' TO ' + q(role));
  statements.push(...require('./postgres').grants({ namespace: ns.registry, provisioner: role }).filter(sql => sql.startsWith('GRANT')));
  statements.push(
    'GRANT SELECT, INSERT ON ' + t('legacy', 'legacy_credential_config') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('secrets', 'secret_records') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('secrets', 'secret_audit') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('authorization', 'tenant_authorization_config') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('authorization', 'tenant_owner_policy') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('access', 'access_tenants') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('access', 'access_keys') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('clock', 'tenant_write_clock') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('control', 'tenant_lifecycle_windows') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('control', 'tenant_activity') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('control', 'tenant_activity_audit') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('settings', 'tenant_settings') + ' TO ' + q(role),
    'GRANT INSERT ON ' + t('settings', 'tenant_settings_history') + ' TO ' + q(role),
    'GRANT SELECT, INSERT ON ' + t('operatorPolicy', 'tenant_operator_policy') + ' TO ' + q(role),
    // Removal reads whether the tenant's deletion ceremony has executed.
    'GRANT SELECT ON ' + t('control', 'tenant_lifecycle_ceremony') + ' TO ' + q(role));
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
function createProvisioning ({ connectionString, namespaces, checkpoints = [], ownerCatalogue = ['*'], vault, actor, mode = 'direct-alias',
  inject, now = Date.now, fetchImpl } = {}) {
  const ns = Object.fromEntries(NAMESPACES.map(name => [name, namespaceOf(namespaces?.[name])]));
  if (new Set(Object.values(ns)).size !== NAMESPACES.length) throw new TypeError('Distinct provisioning namespaces required');
  if (!Array.isArray(checkpoints) || checkpoints.length > 8 || checkpoints.some(row => !row || !ACTOR.test(row.consumer || '') || !DIGEST.test(row.digest || '') ||
      Object.keys(row).length !== 3) || new Set(checkpoints.map(row => row.namespace + ' ' + row.consumer)).size !== checkpoints.length) {
    throw new TypeError('Provisioning checkpoints must be explicit { namespace, consumer, digest } rows');
  }
  checkpoints.forEach(row => namespaceOf(row.namespace));
  if (!actor || !ACTOR.test(actor.principal || '') || !ACTOR.test(actor.consumer || '')) throw new TypeError('Explicit provisioning actor required');
  if (!['direct-alias', 'canonical-internal'].includes(mode)) throw new TypeError('Invalid tenant resolution mode');
  if (inject !== undefined && typeof inject !== 'function') throw new TypeError('Provisioning failure hook must be a function');
  const digest = ownerPolicy.catalogueDigest(ownerCatalogue);
  const keys = createVaultKeys({ ...vault, ...(fetchImpl ? { fetchImpl } : {}) });
  const pool = new Pool({ connectionString, max: BATCH_CONCURRENCY, connectionTimeoutMillis: 5000, statement_timeout: 10000,
    application_name: 'nightscout-admin-provisioning' });
  pool.on('error', () => {});
  const t = (name, table) => q(ns[name]) + '.' + q(table);
  const step = async name => { if (inject) await inject(name); };

  // A retry is idempotent only for a structurally provisioned tenant. Do not
  // silently repair an incomplete record or replace its root secret. Values
  // may legitimately have changed since provisioning (settings, grants,
  // pause/suspend, credentials); audit retention is not a completeness test.
  async function complete (client, id) {
    const values = [id];
    const required = [
      ['legacy', 'legacy_credential_config'], ['authorization', 'tenant_authorization_config'], ['authorization', 'tenant_owner_policy'],
      ['access', 'access_tenants'], ['clock', 'tenant_write_clock'], ['control', 'tenant_lifecycle_windows'], ['control', 'tenant_activity'],
      ['settings', 'tenant_settings'], ['operatorPolicy', 'tenant_operator_policy']
    ].map(([kind, table]) => 'EXISTS (SELECT 1 FROM ' + t(kind, table) + ' WHERE tenant_id=$1)');
    required.push('(SELECT count(DISTINCT purpose)=4 FROM ' + t('registry', 'tenant_registry_keys') +
      " WHERE tenant_id=$1 AND purpose IN ('access','management','human-data','human-management'))");
    required.push('NOT EXISTS (SELECT 1 FROM ' + t('legacy', 'legacy_credential_config') + ' l WHERE tenant_id=$1 AND root_reference_id IS NOT NULL' +
      ' AND NOT EXISTS (SELECT 1 FROM ' + t('secrets', 'secret_records') + ' s WHERE s.tenant_id=l.tenant_id AND s.id=l.root_reference_id))');
    required.push("NOT EXISTS (SELECT 1 FROM (VALUES ('key1','data'), ('management1','management'), ('human-data-1','data'), ('human-management-1','management')) AS wanted(kid,purpose)" +
      ' WHERE NOT EXISTS (SELECT 1 FROM ' + t('access', 'access_keys') + ' k WHERE k.tenant_id=$1 AND k.kid=wanted.kid AND k.purpose=wanted.purpose))');
    for (const row of checkpoints) {
      values.push(row.consumer);
      required.push('EXISTS (SELECT 1 FROM ' + q(row.namespace) + '.tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$' + values.length + ')');
    }
    return (await client.query('SELECT ' + required.join(' AND ') + ' AS complete', values)).rows[0]?.complete === true;
  }

  // What the registry holds for an id and for the requested hosts.
  async function current (client, spec) {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [spec.id]);
    const tenant = (await client.query('SELECT state FROM ' + t('registry', 'tenant_registry') + ' WHERE tenant_id = $1', [spec.id])).rows[0];
    const own = (await client.query('SELECT host, kind FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE tenant_id = $1', [spec.id])).rows;
    const wanted = [...spec.aliases, ...(spec.internal ? [spec.internal] : [])];
    const taken = (await client.query('SELECT host FROM ' + t('registry', 'tenant_registry_hosts') + ' WHERE host = ANY($1::text[]) AND tenant_id <> $2', [wanted, spec.id])).rows;
    return { state: tenant?.state, own, taken: taken.map(row => row.host), complete: tenant?.state === 'active' ? await complete(client, spec.id) : false };
  }
  function sameHosts (spec, own) {
    const aliases = own.filter(row => row.kind === 'alias').map(row => row.host).sort();
    const internal = own.filter(row => row.kind === 'internal').map(row => row.host);
    return JSON.stringify(aliases) === JSON.stringify(spec.aliases) && JSON.stringify(internal) === JSON.stringify(spec.internal ? [spec.internal] : []);
  }
  async function inspect (spec) {
    const client = await pool.connect(); let failure;
    try {
      await client.query('BEGIN READ ONLY');
      const found = await current(client, spec);
      await client.query('COMMIT');
      return found;
    } catch (error) { failure = error; throw error; } finally { client.release(failure); }
  }
  function decide (spec, found) {
    if (found.state === 'removed') return { outcome: 'refused', code: 'TENANT_PROVISION_REMOVED' };
    if (found.state === 'active') {
      if (!sameHosts(spec, found.own) || found.taken.length) return { outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' };
      return found.complete ? { outcome: 'existing' } : { outcome: 'refused', code: 'TENANT_PROVISION_INCOMPLETE' };
    }
    if (found.taken.length) return { outcome: 'refused', code: 'TENANT_PROVISION_CONFLICT' };
    return null;
  }

  async function commit (spec, publicKeys) {
    const client = await pool.connect(); let failure, rootSecret;
    try {
      await client.query('BEGIN');
      // Re-check inside the transaction; a concurrent provisioning of the
      // same id or host fails on a unique key and is re-decided by the caller.
      const found = await current(client, spec);
      const decided = decide(spec, found);
      if (decided) { await client.query('ROLLBACK'); return decided; }
      const id = spec.id, run = (sql, values) => client.query(sql, values);
      await run('INSERT INTO ' + t('registry', 'tenant_registry') + " (tenant_id, state, signing_version) VALUES ($1, 'active', 1)", [id]);
      await step('registry');
      for (const host of spec.aliases) await run('INSERT INTO ' + t('registry', 'tenant_registry_hosts') + " (host, tenant_id, kind) VALUES ($1, $2, 'alias')", [host, id]);
      if (spec.internal) await run('INSERT INTO ' + t('registry', 'tenant_registry_hosts') + " (host, tenant_id, kind) VALUES ($1, $2, 'internal')", [spec.internal, id]);
      // Headless (access, management) and human OIDC (human-data,
      // human-management) public keys; kids by rule (HUMAN_KIDS).
      await run('INSERT INTO ' + t('registry', 'tenant_registry_keys') + " (tenant_id, purpose, kid, public_key) VALUES ($1, 'access', 'key1', $2), ($1, 'management', 'management1', $3)," +
        " ($1, 'human-data', $4, $5), ($1, 'human-management', $6, $7)",
        [id, publicKeys.access, publicKeys.management, HUMAN_KIDS.data, publicKeys['human-data'], HUMAN_KIDS.management, publicKeys['human-management']]);
      await step('hosts');
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
          encryptionKey: rules.vaultKey(tenant, 'data'), signingKey: rules.vaultKey(tenant, 'signing'), signingVersion: 1, getToken: vault.getToken }) });
      await secrets.encrypt({ tenant: id, principal: actor.principal, consumer: actor.consumer }, ROOT_ID, Buffer.from(rootSecret));
      await step('secret');
      await run('INSERT INTO ' + t('legacy', 'legacy_credential_config') + ' (tenant_id, root_reference_id) VALUES ($1, $2)', [id, ROOT_ID]);
      await run('INSERT INTO ' + t('authorization', 'tenant_authorization_config') + " (tenant_id, anonymous_roles) VALUES ($1, ARRAY['denied'])", [id]);
      await run('INSERT INTO ' + t('authorization', 'tenant_owner_policy') + ' (tenant_id, catalogue_digest, ceiling) VALUES ($1, $2, $3)', [id, digest, ownerCatalogue]);
      await step('authorization');
      await run('INSERT INTO ' + t('access', 'access_tenants') + ' (tenant_id, active) VALUES ($1, true)', [id]);
      // The human session store accepts a human token only while its kid is an
      // active access key of the tenant (lib/human-session/postgres.js).
      await run('INSERT INTO ' + t('access', 'access_keys') + " (tenant_id, kid, purpose, active) VALUES ($1, 'key1', 'data', true), ($1, 'management1', 'management', true)," +
        " ($1, $2, 'data', true), ($1, $3, 'management', true)", [id, HUMAN_KIDS.data, HUMAN_KIDS.management]);
      await step('access');
      await run('INSERT INTO ' + t('clock', 'tenant_write_clock') + ' (tenant_id, last_stamp) VALUES ($1, $2)', [id, now()]);
      for (const row of checkpoints) {
        await run('INSERT INTO ' + q(row.namespace) + '.tenant_consumer_checkpoint (tenant_id, consumer, contract_digest, checkpoint, projection) VALUES ($1, $2, $3, 0, NULL)',
          [id, row.consumer, row.digest]);
      }
      await step('clock');
      await run('INSERT INTO ' + t('control', 'tenant_lifecycle_windows') + " (tenant_id, lock_key, phase, generation) VALUES ($1, $2, 'active', 1)", [id, rules.lockKey(id)]);
      // The activity row in the same transaction as the window row
      // (decision activity-row-always-provisioned).
      await activity.provisionInTransaction(run, { namespace: ns.control, tenant: id, principal: actor.principal, consumer: actor.consumer });
      await step('lifecycle');
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
      await step('settings');
      const committed = await run('COMMIT');
      if (committed.command !== 'COMMIT') throw fail('TENANT_PROVISION_ABORTED');
      return { outcome: 'created', ...(spec.issueRootSecret ? { rootSecret } : {}) };
    } catch (error) {
      failure = error;
      try { await client.query('ROLLBACK'); } catch { /* the client is released as failed */ }
      throw error;
    } finally { client.release(failure); }
  }

  async function provisionOne (input) {
    let spec;
    try { spec = parseSpec(input, { mode }); } catch (error) {
      return { id: typeof input?.id === 'string' ? input.id : null, ...(typeof input?.ref === 'string' && REF.test(input.ref) ? { ref: input.ref } : {}),
        outcome: 'refused', code: error.code || 'TENANT_PROVISION_INVALID' };
    }
    const base = { id: spec.id, ...(spec.ref ? { ref: spec.ref } : {}) };
    try {
      const early = decide(spec, await inspect(spec));
      if (early) return { ...base, ...early };
      await step('vault');
      const publicKeys = {};
      for (const [purpose, type] of Object.entries(rules.PURPOSES)) {
        const key = await keys.ensure(rules.vaultKey(spec.id, purpose), type);
        if (key.publicKey) publicKeys[purpose] = key.publicKey;
      }
      await step('database');
      try { return { ...base, ...await commit(spec, publicKeys) }; }
      catch (error) {
        // A concurrent request for the same id or host committed first.
        if (error?.code === '23505') { const again = decide(spec, await inspect(spec)); if (again) return { ...base, ...again }; }
        throw error;
      }
    } catch (error) {
      const code = typeof error?.code === 'string' && /^TENANT_PROVISION_[A-Z_]{1,64}$/.test(error.code) ? error.code : 'TENANT_PROVISION_FAILED';
      return { ...base, outcome: 'refused', code };
    }
  }

  return Object.freeze({
    provision: provisionOne,
    // At most MAX_BATCH tenants; duplicate ids or hosts refuse the whole batch
    // before any work. One result per tenant, in request order.
    async provisionBatch (inputs) {
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

module.exports = { createProvisioning, provisionerGrants, parseSpec, MAX_BATCH, MAX_HOSTS, ROOT_ID, HUMAN_KIDS };
