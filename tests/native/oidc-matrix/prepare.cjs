'use strict';

// Test-private operator setup; called only after complete admission and shared
// nativeStore creation. No Docker, role creation, implicit schema reuse or logs.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const q = value => '"' + value.replaceAll('"', '""') + '"';

module.exports = async function prepare ({ req, admin, config, parsed, nativeStore, env }) {
  const created = [], roots = [];
  let closing;
  const ns = parsed.namespaces;
  const selected = parsed.ownerSettings.namespaces;
  const own = [ns.credentials, selected.settings, selected.operatorPolicy, selected.authority, parsed.ownerCredentials.namespace];
  const profiles = [
    ['owner', parsed.writerConnectionString], ['legacy', parsed.accessConnectionString],
    ['settings', parsed.ownerSettings.connectionString], ['secrets', parsed.ownerCredentials.connectionString],
    ['reader', env[config.settingsReaderConnectionEnv]]
  ];
  const role = Object.fromEntries(profiles.map(([name, url]) => [name, q(decodeURIComponent(new URL(url).username))]));
  const table = (schema, name) => q(schema) + '.' + name;
  async function close () {
    if (!closing) closing = (async () => {
      const errors = [];
      for (const value of roots) value.fill(0);
      for (const record of created.slice().reverse()) {
        try {
          const current = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [record.name])).rows[0];
          if (!current || String(current.oid) !== String(record.oid)) throw new Error('OWNER_NATIVE_SCHEMA_OWNERSHIP_CHANGED');
          await admin.query('DROP SCHEMA ' + q(record.name) + ' CASCADE');
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new globalThis.AggregateError(errors, 'OWNER_NATIVE_SETUP_CLOSE_FAILED');
    })();
    return closing;
  }
  async function bound (tenant, action) {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
      const result = await action(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  try {
    const { Pool } = req('pg');
    for (const [, address] of profiles) {
      const probe = new Pool({ connectionString: address, max: 1, connectionTimeoutMillis: 1000,
        statement_timeout: 2000, query_timeout: 2000 });
      try {
        const state = (await probe.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
        assert.ok(state && Object.values(state).every(value => value === false), 'dedicated non-bypass fixture identity required');
      } finally { await probe.end(); }
    }
    const existing = (await admin.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1)', [own])).rows;
    assert.deepEqual(existing, [], 'owner setup refuses any existing namespace');
    const migrations = [
      [ns.credentials, './lib/secrets/legacy-credentials-candidate.json'],
      [selected.settings, './lib/tenant-settings/postgres-candidate.json'],
      [selected.operatorPolicy, './lib/operator-policy/postgres-candidate.json'],
      [selected.authority, './lib/tenant-settings/owner-authority-candidate.json'],
      [parsed.ownerCredentials.namespace, './lib/secrets/postgres-candidate.json']
    ];
    for (const [name, catalogue] of migrations) {
      await admin.query('CREATE SCHEMA ' + q(name));
      const oid = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [name])).rows[0]?.oid;
      if (!oid) throw new Error('OWNER_NATIVE_SCHEMA_CREATE_UNCONFIRMED');
      created.push({ name, oid });
      const input = { direct: true, connectionString: env[config.adminConnectionEnv], namespace: name,
        catalogue: req(catalogue), statementTimeoutMs: 5000 };
      await req('./lib/migrations/postgres').run('up', input);
      await req('./lib/migrations/postgres').run('check', input);
    }
    const grant = (bits, tables, recipient) => admin.query('GRANT ' + bits + ' ON ' + tables.join(',') + ' TO ' + recipient);
    for (const [, address] of profiles) {
      const r = q(decodeURIComponent(new URL(address).username));
      await admin.query('GRANT USAGE ON SCHEMA ' + own.concat(ns.authorization, ns.access).map(q).join(',') + ' TO ' + r);
    }
    const subjects = table(ns.authorization, 'tenant_authorization_subjects'), roles = table(ns.authorization, 'tenant_authorization_roles');
    const links = table(ns.authorization, 'tenant_authorization_subject_roles'), audit = table(ns.authorization, 'tenant_subject_admin_audit');
    const metadata = table(ns.credentials, 'legacy_credential_subjects'), legacy = table(ns.credentials, 'legacy_credential_config');
    const policy = table(ns.authorization, 'tenant_owner_policy'), actors = table(ns.authorization, 'tenant_owner_actors');
    const defaults = table(ns.authorization, 'tenant_authorization_config');
    await grant('SELECT,INSERT,UPDATE,DELETE', [subjects, metadata], role.owner);
    await grant('SELECT,INSERT', [roles], role.owner);
    await grant('SELECT,INSERT,DELETE', [links], role.owner);
    await grant('INSERT', [audit], role.owner);
    await grant('SELECT,UPDATE(owner_fence)', [roles, policy, actors, defaults], role.owner);
    await grant('SELECT', [legacy, metadata], role.legacy);
    await grant('SELECT', [subjects, roles, links, defaults].concat(['tenants', 'credentials', 'sessions', 'keys'].map(name => table(ns.access, 'access_' + name))), role.legacy);
    await grant('SELECT,INSERT', [table(parsed.ownerCredentials.namespace, 'secret_records')], role.secrets);
    await grant('INSERT', [table(parsed.ownerCredentials.namespace, 'secret_audit')], role.secrets);
    const settings = table(selected.settings, 'tenant_settings'), history = table(selected.settings, 'tenant_settings_history');
    const op = table(selected.operatorPolicy, 'tenant_operator_policy'), configuration = table(selected.authority, 'tenant_owner_configuration_authority');
    await grant('SELECT,INSERT,UPDATE', [settings], role.settings);
    await grant('SELECT,INSERT', [history], role.settings);
    await grant('SELECT', [op], role.settings);
    await grant('SELECT,UPDATE(owner_fence)', [configuration], role.settings);
    await grant('SELECT', [settings, history, op], role.reader);
    // lib/tenant-settings/effective-postgres runs the migration ledger `check` through the reader identity.
    await grant('SELECT', [table(selected.settings, 'schema_migrations'), table(selected.operatorPolicy, 'schema_migrations')], role.reader);
    const digest = req('./lib/subject-admin/owner-policy').catalogueDigest(parsed.ownerPolicy.catalogue);
    for (const [index, tenant] of config.tenants.entries()) {
      const principal = index ? 'synthetic_b' : nativeStore.subject;
      const root = randomBytes(32); roots.push(root);
      const rootText = Buffer.from(root.toString('hex'));
      const reference = 'fixture_root_' + index;
      let ciphertext;
      try { ciphertext = await parsed.ownerCredentials.providers.get(tenant).encrypt(Buffer.from(JSON.stringify({
        tenant, id: reference, data: rootText.toString('base64') }))); }
      finally { rootText.fill(0); }
      await bound(tenant, async client => {
        if (index === 0) {
          const before = (await client.query('SELECT catalogue_digest,ceiling FROM ' + policy + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
          assert.deepEqual(before, { catalogue_digest: 'a'.repeat(64), ceiling: [] }, 'only the known fresh shared native fixture may be widened explicitly');
          await client.query('UPDATE ' + policy + ' SET catalogue_digest=$2,ceiling=$3 WHERE tenant_id=$1', [tenant, digest, config.fixturePolicy.ceiling]);
          const actor = (await client.query('UPDATE ' + actors + ' SET delegable=$4 WHERE tenant_id=$1 AND principal=$2 AND consumer=$3 AND active AND can_update AND delegable=ARRAY[]::text[] RETURNING principal',
            [tenant, principal, parsed.consumer, config.fixturePolicy.delegable])).rows;
          assert.equal(actor.length, 1, 'explicit fresh fixture actor required');
        } else {
          await client.query('INSERT INTO ' + defaults + ' (tenant_id,anonymous_roles) VALUES ($1,$2)', [tenant, ['denied']]);
          await client.query('INSERT INTO ' + subjects + ' (tenant_id,subject_id,display_name) VALUES ($1,$2,$3)', [tenant, principal, 'Synthetic B']);
          await client.query('INSERT INTO ' + policy + ' (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)', [tenant, digest, config.fixturePolicy.ceiling]);
          await client.query('INSERT INTO ' + actors + ' (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,$2,$3,true,true,$4)', [tenant, principal, parsed.consumer, config.fixturePolicy.delegable]);
        }
        await req('./lib/subject-admin/provision-default-roles')(client, { namespace: ns.authorization, tenant });
        await client.query('INSERT INTO ' + links + ' (tenant_id,subject_id,role_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [tenant, principal, 'readable']);
        await client.query('INSERT INTO ' + legacy + ' (tenant_id,root_reference_id) VALUES ($1,$2)', [tenant, reference]);
        await client.query('INSERT INTO ' + metadata + ' (tenant_id,subject_id,token_prefix) VALUES ($1,$2,$3)', [tenant, principal, 'synthetic']);
        await client.query('INSERT INTO ' + table(parsed.ownerCredentials.namespace, 'secret_records') + ' VALUES ($1,$2,1,$3)', [tenant, reference, ciphertext]);
        await client.query('INSERT INTO ' + audit + ' (event_id,tenant_id,principal,consumer,subject_id,operation,event_time) VALUES ($1,$2,$3,$4,$3,$5,$6)', [randomUUID(), tenant, principal, parsed.consumer, 'create', Date.now()]);
        await client.query('INSERT INTO ' + settings + ' (tenant_id,version,values) VALUES ($1,1,$2)', [tenant, {}]);
        await client.query('INSERT INTO ' + history + ' (tenant_id,version,values,principal,consumer,operation,event_time) VALUES ($1,1,$2,$3,$4,$5,$6)', [tenant, {}, principal, parsed.consumer, 'replace', Date.now()]);
        await client.query('INSERT INTO ' + op + ' (tenant_id,generation,policy,principal,consumer,event_time) VALUES ($1,1,$2,$3,$4,$5)', [tenant, { deployment: {}, overrides: {} }, principal, 'operator', Date.now()]);
        await client.query('INSERT INTO ' + configuration + ' (tenant_id,principal,consumer,active,can_configure) VALUES ($1,$2,$3,true,true)', [tenant, principal, parsed.consumer]);
      });
    }
    return { close, created: created.map(value => ({ ...value })) };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new globalThis.AggregateError([error, cleanup], 'OWNER_NATIVE_PREPARE_AND_CLOSE_FAILED'); }
    throw error;
  }
};
