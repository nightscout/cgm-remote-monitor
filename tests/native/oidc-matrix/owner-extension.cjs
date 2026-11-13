'use strict';

// Local acceptance instrument, never imported by serving. Native work is opt-in
// through makeFactory().admit() BEFORE the shared HTTPS driver acquires runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const NS = /^[a-z][a-z0-9_]{0,62}$/;
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const refuse = () => { throw new Error('OWNER_NATIVE_EXPLICIT_RESERVED_CONFIG_REQUIRED'); };

async function closeResources (resources) {
  const errors = [];
  for (const resource of resources.slice().reverse()) {
    try { await resource.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new globalThis.AggregateError(errors, 'OWNER_NATIVE_EXTENSION_CLOSE_FAILED');
}

function admit (config, env = process.env) {
  // This is the first executable admission condition. No app require, driver
  // constructor, network, child process, migration or listener precedes it.
  if (env.HUMAN_SESSION_NATIVE_RESERVED !== '1' || env.HUMAN_HTTPS_RESERVED !== '1' || !config ||
      typeof config.nonce !== 'string' || !/^[a-f0-9]{16,64}$/.test(config.nonce)) refuse();
  // The harness records the executed source: `git rev-parse HEAD` of the tree at
  // sourceRoot and an empty `git status --porcelain`. No pinned file hashes.
  if (!/^[0-9a-f]{40}$/.test(config.sourceCommit || '') || !path.isAbsolute(config.sourceRoot || '') ||
      !fs.existsSync(path.join(config.sourceRoot, 'package.json')) || !Array.isArray(config.tenants) || config.tenants.length !== 2 ||
      new Set(config.tenants).size !== 2 || config.tenants.some(value => !UUID.test(value)) ||
      !config.ownerPreview?.ownerSettings || !config.ownerPreview?.ownerCredentials ||
      !config.fixturePolicy || !['ceiling', 'delegable'].every(key => Array.isArray(config.fixturePolicy[key]) &&
        config.fixturePolicy[key].length && config.fixturePolicy[key].every(value => typeof value === 'string' && value.length))) refuse();
  const p = config.ownerPreview;
  if (p.postgres?.namespaces?.authorization !== '$native.authority' ||
      p.postgres?.namespaces?.access !== '$native.access' ||
      !Array.isArray(p.tenants) || p.tenants.length !== 2 ||
      p.tenants.some(row => !config.tenants.includes(row.id))) refuse();
  if (config.adminConnectionEnv !== 'HUMAN_SESSION_PG_ADMIN_URL' || config.humanConnectionEnv !== 'HUMAN_SESSION_PG_APP_URL') refuse();
  const ownedNames = [p.postgres.namespaces.credentials, p.ownerSettings.namespaces?.settings,
    p.ownerSettings.namespaces?.operatorPolicy, p.ownerSettings.namespaces?.authority, p.ownerCredentials.namespace];
  if (new Set(ownedNames).size !== ownedNames.length || ownedNames.some(value => typeof value !== 'string' ||
      !NS.test(value) || !value.startsWith('oc_' + config.nonce + '_'))) refuse();
  const refs = [config.adminConnectionEnv, config.humanConnectionEnv, config.settingsReaderConnectionEnv,
    p.postgres.writerConnectionEnv, p.postgres.accessConnectionEnv,
    p.ownerSettings.connectionEnv, p.ownerCredentials.connectionEnv];
  if (refs.some(name => typeof name !== 'string' || !ENV.test(name) || typeof env[name] !== 'string' || !env[name]) ||
      new Set(refs).size !== refs.length) refuse();
  const urls = refs.map(name => {
    let url;
    try { url = new URL(env[name]); } catch { refuse(); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.port || ['18080', '18081', '18082', '5432'].includes(url.port) || !url.username || !url.password ||
        url.pathname !== '/owner_oidc_' + config.nonce || url.search || url.hash) refuse();
    return url;
  });
  if (new Set(urls.map(url => decodeURIComponent(url.username))).size !== urls.length ||
      urls.some(url => url.host !== urls[0].host || url.pathname !== urls[0].pathname)) refuse();
  // Validate all non-dynamic preview fields before the shared driver listens.
  const req = createRequire(path.join(config.sourceRoot, 'package.json'));
  const preview = structuredClone(p);
  preview.postgres.namespaces.authorization = 'hh_authority_preflight';
  preview.postgres.namespaces.access = 'hh_access_preflight';
  req('./lib/server/serve/owner-preview-config').parse(preview, env);
  const { permissionsValid } = req('./lib/subject-admin/owner-policy');
  if (!permissionsValid(config.fixturePolicy.ceiling, true) || !permissionsValid(config.fixturePolicy.delegable, true)) refuse();
  require('./stage-contract.cjs').admit(config.execution, env);
  require('./consumer-journey.cjs').admit({ config, env });
  require('./owner-browser-journey.cjs').admit({ config, env, binding: { persistence: 'postgres', signing: 'configured-transit' } });
  if (!ENV.test(config.operatorCredentialEnv || '') || (env[config.operatorCredentialEnv] || '').length < 32) refuse();
  return true;
}

function makeFactory ({ config, env = process.env } = {}) {
  const factory = async context => {
    admit(config, env); // Remains required even if a caller skips shared preflight.
    const { nativeStore, human, tenant, origin } = context || {};
    if (!nativeStore || nativeStore.kind !== 'postgres' || nativeStore.tenant !== config.tenants[0] ||
        tenant !== nativeStore.tenant || !human || typeof human.authenticate !== 'function' ||
        !['human', 'authority', 'access'].every(key => /^hh_(human|authority|access)_[a-f0-9]{16}$/.test(nativeStore.resources?.[key] || '') &&
          nativeStore.resources[key].startsWith('hh_' + key + '_'))) {
      throw new Error('OWNER_NATIVE_SHARED_CONTEXT_MISMATCH');
    }
    const req = createRequire(path.join(config.sourceRoot, 'package.json'));
    const preview = structuredClone(config.ownerPreview);
    preview.postgres.namespaces.authorization = nativeStore.resources.authority;
    preview.postgres.namespaces.access = nativeStore.resources.access;
    const parsed = req('./lib/server/serve/owner-preview-config').parse(preview, env);
    if (parsed.consumer !== 'oidc') throw new Error('OWNER_NATIVE_CURRENT_CONSUMER_MISMATCH');
    const resources = [];
    let closing;
    async function close () {
      if (!closing) closing = closeResources(resources);
      return closing;
    }
    try {
      const { Pool } = req('pg');
      const admin = new Pool({ connectionString: env[config.adminConnectionEnv], max: 1,
        connectionTimeoutMillis: 1000, statement_timeout: 2000, query_timeout: 2000,
        application_name: 'nightscout-owner-native-oracle' });
      resources.push({ close: () => admin.end() });
      const setup = await require('./prepare.cjs')({ req, admin, config, parsed, nativeStore, env });
      resources.push(setup);
      const store = await req('./lib/subject-admin/postgres')({ connectionString: parsed.writerConnectionString,
        namespace: parsed.namespaces.authorization, credentialNamespace: parsed.namespaces.credentials,
        ownerPolicy: parsed.ownerPolicy }); resources.push(store);
      const issuer = await req('./lib/server/serve/owner-credential-runtime')(parsed.ownerCredentials); resources.push(issuer);
      const subjects = req('./lib/subject-admin/component').createSubjectAdmin({ store,
        issueCredential: issuer.issueCredential, authorizeManagement: async actor => actor.consumer === parsed.consumer });
      const chosen = parsed.ownerSettings;
      const settings = await req('./lib/tenant-settings/postgres')({ connectionString: chosen.connectionString,
        namespace: chosen.namespaces.settings, policyNamespace: chosen.namespaces.operatorPolicy,
        configurationAuthorityNamespace: chosen.namespaces.authority }); resources.push(settings);
      const policy = await req('./lib/operator-policy/postgres-read')({ connectionString: chosen.connectionString,
        namespace: chosen.namespaces.operatorPolicy }); resources.push(policy);
      const service = req('./lib/tenant-settings/component').createTenantSettings({ store: settings,
        policyFor: async id => { const value = await policy.read(id); return { ...value.policy, generation: value.generation }; },
        authorize: async actor => { const value = await settings.currentConfigurationAuthority(actor);
          return actor.consumer === parsed.consumer && value?.active === true && value.canConfigure === true; } });
      const reader = await req('./lib/tenant-settings/effective-postgres')({
        connectionString: env[config.settingsReaderConnectionEnv], namespaces: {
          settings: chosen.namespaces.settings, operatorPolicy: chosen.namespaces.operatorPolicy } }); resources.push(reader);
      const accessAuthority = await req('./lib/tenant-authorization/access-postgres')({
        connectionString: parsed.accessConnectionString, namespace: parsed.namespaces.access,
        authorityNamespace: parsed.namespaces.authorization }); resources.push(accessAuthority);
      const legacy = req('./lib/server/serve/owner-preview-authentication')({
        verification: parsed.verification, snapshot: accessAuthority.snapshot, consumer: parsed.consumer });
      const authenticateManagement = req('./lib/human-session/management')({ human, legacy });
      const express = req('express');
      const router = express.Router();
      const table = (schema, name) => quote(schema) + '.' + name;
      const tables = [table(parsed.namespaces.authorization, 'tenant_authorization_subjects'),
        table(parsed.namespaces.authorization, 'tenant_authorization_roles'),
        table(parsed.namespaces.authorization, 'tenant_authorization_subject_roles'),
        table(parsed.namespaces.authorization, 'tenant_subject_admin_audit'),
        table(parsed.namespaces.credentials, 'legacy_credential_subjects'),
        table(chosen.namespaces.settings, 'tenant_settings'), table(chosen.namespaces.settings, 'tenant_settings_history')];
      async function snapshot (id) {
        // Raw data remains in memory only. Never emit credentials/ciphertext/URLs.
        const result = {};
        for (const name of tables) result[name] = (await admin.query('SELECT to_jsonb(t) value FROM ' + name +
          ' t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text', [id])).rows.map(row => row.value);
        return result;
      }
      const common = { ...context, config, env, req, admin, parsed, nativeStore,
        binding: context.binding, nativeBinding: context.binding, snapshot,
        services: { subjects, subjectStore: store, issuer, settings: service, settingsReader: reader, policy, authenticateManagement } };
      const phase = context.stage.id;
      let consumer, authority, browser, operatorOrigin, boundTransport;
      if (['owner-consumer', 'owner-compatibility'].includes(phase)) {
        consumer = await require('./consumer-journey.cjs').create(common); resources.push(consumer);
      }
      if (phase === 'owner-authority') {
        authority = await require('./authority-races.cjs').create(common); resources.push(authority);
        // Its dedicated project-bound router must precede subject app's 404.
        router.use(authority.router);
      }
      if (phase === 'owner-compatibility') {
        // A private fixture credential exercises the actual operator HTTP plane.
        // It is no production operator identity or service-login design.
        const secret = env[config.operatorCredentialEnv];
        const actor = { principal: 'synthetic_operator', consumer: 'operator' };
        const operator = req('./lib/server/tenant-app').createOperatorApp({
          authenticateOperator: async request => request.headers.authorization === 'Bearer ' + secret ? actor : null,
          operatorPolicy: {
            read: async value => { assert.equal(value.principal, actor.principal); assert.equal(value.consumer, actor.consumer);
              assert.ok(config.tenants.includes(value.tenant)); return policy.read(value.tenant); },
            replace: async () => { throw Object.assign(new Error('Fixture operator is read-only'), { code: 'OPERATOR_POLICY_FORBIDDEN' }); }
          }
        });
        operatorOrigin = await context.listenOwned(operator, { plane: 'operator', tenant, host: '127.0.0.1' });
        common.compatibility = { ...consumer.compatibility, operatorPath: '/api/v1/operator/tenants/' + tenant + '/policy',
          request: async input => {
            if (input.plane === 'data' || input.plane === undefined) return consumer.compatibility.request(input);
            if (!['owner', 'operator'].includes(input.plane) || input.tenant !== tenant || !boundTransport) refuse();
            const response = await boundTransport((input.plane === 'owner' ? origin : operatorOrigin) + input.path,
              { method: input.method || 'GET', headers: input.headers || {},
                ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
            return { status: response.status, body: await response.json() };
          }
        };
      }
      if (['owner-browser', 'owner-compatibility'].includes(phase)) {
        browser = require('./owner-browser-journey.cjs').create(common); resources.push(browser);
      }
      router.use('/api/v1/tenant', req('./lib/server/tenant-app/owner-settings')({
        resolver: parsed.resolver, authenticateManagement, tenantSettings: service }));
      router.use(req('./lib/server/subject-management-app').createSubjectManagementApp({
        resolver: parsed.resolver, authenticateManagement, subjectAdmin: subjects }));
      async function exercise (input) {
        assert.equal(input.site, origin);
        boundTransport = input.transport;
        const foreign = await snapshot(config.tenants[1]);
        assert.ok(Object.values(foreign).every(rows => rows.length > 0), 'nonempty independent B sentinels required');
        if (phase === 'owner-authority') return authority.exercise(input);
        if (phase === 'owner-browser') return { families: await browser.exerciseHttp(input) };
        if (phase === 'owner-consumer') {
          const reply = await input.login('bearer', 'management'); assert.equal(reply.status, 200);
          const token = (await reply.json()).token;
          const ownerRequest = async (method, route, body) => {
            const response = await input.transport(origin + route, { method, headers: {
              authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            return { status: response.status, body: await response.json() };
          };
          return consumer.exercise({ transport: input.transport, ownerRequest });
        }
        if (phase === 'owner-compatibility') {
          consumer.compatibility.bindTransport(input.transport);
          const positive = await input.transport(operatorOrigin + common.compatibility.operatorPath,
            { headers: { authorization: 'Bearer ' + env[config.operatorCredentialEnv] } });
          assert.equal(positive.status, 200, 'actual operator route has a positive private-fixture control');
          const reply = await input.login('bearer', 'management'); assert.equal(reply.status, 200);
          return { families: await browser.exerciseCompatibility({ managementToken: (await reply.json()).token }) };
        }
        throw new Error('OWNER_NATIVE_UNKNOWN_PHASE');
      }
      const exerciseBrowser = phase === 'owner-browser' ? async input => ({ families: await browser.exerciseBrowser(input) }) : undefined;
      return { router, exercise, exerciseBrowser, close,
        custody: () => ({ schemas: setup.created, authority: authority?.custody?.(), consumer: consumer?.manifest }) };
    } catch (error) {
      try { await close(); } catch (cleanup) { throw new globalThis.AggregateError([error, cleanup], 'OWNER_NATIVE_SETUP_AND_CLOSE_FAILED'); }
      throw error;
    }
  };
  factory.admit = () => admit(config, env);
  return factory;
}

module.exports = { admit, makeFactory, closeResources };
