'use strict';

const { Client } = require('pg');
const { run } = require('../../migrations/postgres');
const scope = require('../../storage/tenant-scope');
const createAccess = require('../../tenant-authorization/access-postgres');
const createStore = require('../../subject-admin/postgres');
const { createSubjectAdmin } = require('../../subject-admin/component');
const { createSubjectManagementApp } = require('../subject-management-app');
const authentication = require('./owner-preview-authentication');
const express = require('express');

// All startup probes read. Schema/credentials/session/key provisioning is the
// private operator's job; this entrypoint never migrates or issues credentials.
async function readiness (config) {
  for (const [connectionString, readOnly] of [[config.accessConnectionString, true], [config.writerConnectionString, false]]) {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000 });
    try {
      await client.connect(); await client.query('BEGIN READ ONLY');
      const role = (await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user')).rows[0];
      if (!role || Object.values(role).some(Boolean)) throw new Error('unsafe owner preview identity');
      for (const namespace of Object.values(config.namespaces)) {
        const allowed = readOnly ? [] : namespace === config.namespaces.authorization
          ? ['tenant_authorization_subjects', 'tenant_authorization_roles', 'tenant_authorization_subject_roles',
            'tenant_subject_admin_audit', 'tenant_authorization_config', 'tenant_owner_policy', 'tenant_owner_actors']
          : namespace === config.namespaces.credentials ? ['legacy_credential_subjects'] : [];
        const state = (await client.query(`SELECT has_schema_privilege($1,'CREATE') AS creates,
          EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND NOT(c.relname=ANY($2::text[]))
            AND (pg_has_role(current_user,c.relowner,'MEMBER') OR
              has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
              has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES'))) AS mutates`, [namespace, allowed])).rows[0];
        if (state.creates || state.mutates) throw new Error('unsafe owner preview schema privileges');
      }
      await client.query('ROLLBACK');
    } finally { await client.end(); }
  }
  const catalogues = { authorization: require('../../tenant-authorization/postgres-candidate.json'),
    credentials: require('../../secrets/legacy-credentials-candidate.json'), access: require('../../tenant-authorization/access-candidate.json') };
  for (const [kind, catalogue] of Object.entries(catalogues)) await run('check', { direct: true,
    connectionString: config.accessConnectionString, namespace: config.namespaces[kind], catalogue, statementTimeoutMs: 5000 });
  if (config.ownerSettings) {
    const selected = config.ownerSettings;
    await require('../../tenant-settings/readiness')({ connectionString: selected.connectionString,
      writable: [selected.namespaces.settings + '.tenant_settings', selected.namespaces.settings + '.tenant_settings_history',
        selected.namespaces.authority + '.tenant_owner_configuration_authority'] });
    for (const [kind, catalogue] of Object.entries({
      settings: require('../../tenant-settings/postgres-candidate.json'),
      operatorPolicy: require('../../operator-policy/postgres-candidate.json'),
      authority: require('../../tenant-settings/owner-authority-candidate.json')
    })) await run('check', { direct: true, connectionString: selected.connectionString,
      namespace: selected.namespaces[kind], catalogue, statementTimeoutMs: 5000 });
  }
}
async function boot (config) {
  const resources = []; let closed = false;
  async function close () {
    if (closed) return; closed = true;
    const results = await Promise.allSettled(resources.reverse().map(resource => resource.close()));
    if (results.some(result => result.status === 'rejected')) throw new Error('owner preview shutdown failed');
  }
  try {
    await readiness(config); scope.setTenancyMode('multi');
    const access = await createAccess({ connectionString: config.accessConnectionString,
      namespace: config.namespaces.access, authorityNamespace: config.namespaces.authorization }); resources.push(access);
    const store = await createStore({ connectionString: config.writerConnectionString,
      namespace: config.namespaces.authorization, credentialNamespace: config.namespaces.credentials,
      ownerPolicy: config.ownerPolicy }); resources.push(store);
    const subjectAdmin = createSubjectAdmin({ store,
      // The selected store fences current actor/catalogue/ceiling and proposal
      // in its own update transaction. DELETE remains refused by that policy.
      authorizeManagement: async actor => actor.consumer === config.consumer });
    const authenticateManagement = authentication({ verification: config.verification, snapshot: access.snapshot, consumer: config.consumer });
    const subjects = createSubjectManagementApp({ resolver: config.resolver, subjectAdmin, authenticateManagement });
    let app = subjects;
    if (config.ownerSettings) {
      const selected = config.ownerSettings;
      const settingsStore = await require('../../tenant-settings/postgres')({
        connectionString: selected.connectionString, namespace: selected.namespaces.settings,
        policyNamespace: selected.namespaces.operatorPolicy, configurationAuthorityNamespace: selected.namespaces.authority
      }); resources.push(settingsStore);
      const policies = await require('../../operator-policy/postgres-read')({
        connectionString: selected.connectionString, namespace: selected.namespaces.operatorPolicy
      }); resources.push(policies);
      const tenantSettings = require('../../tenant-settings/component').createTenantSettings({
        store: settingsStore,
        policyFor: async tenant => {
          const current = await policies.read(tenant);
          if (!current) throw Object.assign(new Error('SETTINGS_POLICY_UNAVAILABLE'), { code: 'SETTINGS_POLICY_UNAVAILABLE' });
          return { ...current.policy, generation: current.generation };
        },
        authorize: async actor => {
          if (actor.consumer !== config.consumer) return false;
          const current = await settingsStore.currentConfigurationAuthority(actor);
          return !!current && current.active === true && current.canConfigure === true;
        }
      });
      app = express(); app.disable('x-powered-by'); app.disable('etag'); app.set('trust proxy', false);
      app.use('/api/v1/tenant', require('../tenant-app/owner-settings')({ resolver: config.resolver,
        authenticateManagement, tenantSettings }));
      app.use(subjects);
    }
    return { app, close };
  } catch (error) { await close(); throw error; }
}
module.exports = { boot, readiness };
