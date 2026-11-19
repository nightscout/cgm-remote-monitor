'use strict';

const configFile = require('./config-file');
const verifier = require('./platform-verification');
const diagnostics = require('./platform-verification-diagnostic');
const failure = code => Object.assign(new Error(code), { code });
const KEYS = { api: 'MULTITENANT_PREVIEW_CONFIG', evaluator: 'MULTITENANT_EVALUATOR_CONFIG', realtime: 'MULTITENANT_REALTIME_CONFIG', vcpool: 'MULTITENANT_VCPOOL_CONFIG' };
function sourceFor (target, source) {
  let extra = {};
  if (target.environmentFile) {
    extra = configFile.readJson(target.environmentFile, { source, label: 'platform verification environment' });
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.entries(extra).some(([key, value]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== 'string')) throw failure('PLATFORM_VERIFICATION_ENVIRONMENT');
  }
  return { ...source, ...extra, [KEYS[target.role]]: target.configFile, ...(target.operationConfigFile ? { MULTITENANT_OPERATION_CONFIG: target.operationConfigFile } : {}) };
}
function loadTarget (target, source) {
  const own = sourceFor(target, source);
  let config;
  if (target.role === 'api') config = require('./preview-config').load(own);
  else if (target.role === 'evaluator') config = require('./evaluator-config').load(own);
  else if (target.role === 'vcpool') {
    // The connector has no tenant operation plane to bind.
    if (target.operationConfigFile) throw failure('PLATFORM_VERIFICATION_TARGET');
    config = require('../../tenant-connector/config').load(own);
  } else config = require('../realtime/config').load(own);
  if (config.platformVerification?.role !== target.role) throw failure('PLATFORM_VERIFICATION_TARGET');
  const operationConfig = target.operationConfigFile ? require('./operation-cohort-config').load(own) : null;
  return { role: target.role, config, source: own, target, operationConfig };
}
async function checkTarget (item) {
  const { config, role, operationConfig: selected } = item;
  const owned = [];
  const catalogue = require('./platform-verification-lifecycle');
  let checkPhase = 'OPERATION_READINESS';
  try {
    const lifecycle = await catalogue.inspect(selected);
    if (lifecycle) {
      const connections = new Set([config.subjectAdmin?.connectionString, config.activity?.connectionString, config.tenantSettings?.connectionString,
        config.socketForwarding?.alarm.connectionString]);
      if (role === 'api') connections.add(config.connectionString);
      for (const connectionString of connections) {
        if (connectionString) await catalogue.withClient({ connectionString }, client => lifecycle.controlReads(client));
      }
    }
    if (role === 'vcpool') {
      // The screens vcpool ran at boot before decision vcpool-proof-role.
      if (config.definitions) {
        checkPhase = 'CONNECTOR_DEFINITIONS';
        owned.push(await require('../../tenant-connector/postgres-sources').create({
          connectionString: config.definitions.connectionString, namespaces: config.definitions.namespaces }));
      }
      checkPhase = 'CONNECTOR_POOL';
      if (config.partition?.partitioned) {
        const { pool } = await require('../../pool-membership/postgres').connect({ kind: 'vcpool', connectionString: config.partition.connectionString,
          namespace: config.partition.namespace, capability: 'member', applicationName: 'nightscout-admin-vcpool-verification' });
        owned.push({ close: () => pool.end() });
      }
      checkPhase = 'ACTIVITY_READER';
      owned.push(await require('../../tenant-activity/postgres').create({ connectionString: config.activity.connectionString,
        namespace: config.activity.namespace, capability: 'reader', applicationName: 'nightscout-admin-vcpool-verification' }));
      checkPhase = 'SECRET_PERSISTENCE';
      owned.push(await require('../../secrets/postgres').createPostgresSecrets({ connectionString: config.secretsConnectionString, namespace: config.namespaces.secrets }));
    } else if (role === 'api') {
      const domains = require('./postgres-domains');
      checkPhase = 'API_CATALOGUES';
      await domains.readiness(config);
      const connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-admin-api-verification' });
      owned.push({ close: () => connection.end() });
      checkPhase = 'API_SERVING';
      await domains.screenServing(config, connection);
      // The platform invokes the same strict constructors and arguments used
      // by API boot, with an empty tenant roster and no application effects.
      checkPhase = 'LEGACY_AUTHORITY';
      const legacy = await require('../../secrets/legacy-postgres')({ connectionString: config.connectionString, connection,
        namespace: config.namespaces.legacy, localVerification: config.localDataAuthentication === true });
      owned.push(legacy);
      checkPhase = 'LOCAL_ACCESS';
      if (config.accessTokens) owned.push(await require('../../tenant-authorization/access-postgres')({ connectionString: config.connectionString, connection,
        namespace: config.namespaces.access, authorityNamespace: config.namespaces.authorization }));
      checkPhase = 'SECRET_PERSISTENCE';
      const persistence = await require('../../secrets/postgres').createPostgresSecrets({ connectionString: config.connectionString, namespace: config.namespaces.secrets });
      owned.push(persistence);
      checkPhase = 'AUTHORIZATION';
      owned.push(await require('../../tenant-authorization/postgres')({ connectionString: config.connectionString, connection, namespace: config.namespaces.authorization }));
      checkPhase = 'ROOT_SUBJECT_ADMIN';
      if (config.subjectAdmin) owned.push(await require('../../subject-admin/postgres')({ connectionString: config.subjectAdmin.connectionString,
        namespace: config.namespaces.authorization, credentialNamespace: config.namespaces.legacy, ownerPolicy: config.subjectAdmin.ownerPolicy, plane: 'root' }));
      checkPhase = 'ACTIVITY_READER';
      if (config.activity) owned.push(await require('../../tenant-activity/postgres').create({ connection, namespace: config.activity.namespace, capability: 'reader' }));
    } else {
      checkPhase = 'CLINICAL_READINESS';
      await require('./evaluator-readiness')(config, { lifecycle, intakeProfile: config.selectedIntake?.profile, ordinal: config.processAssignment?.ordinal });
      if (role === 'evaluator') {
        checkPhase = 'CONSUMER_READINESS';
        await require('./evaluator-consumer-readiness').verify(config, lifecycle);
      }
      checkPhase = 'TRUSTED_METADATA';
      if (config.trustedWorker) {
        const connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1,
          connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-admin-worker-verification' });
        owned.push({ close: () => connection.end() });
        await require('../../trusted-worker/postgres').screen({ connection, namespaces: config.trustedWorker, stream: role === 'evaluator' });
      }
    }
    checkPhase = 'ACTIVITY_CATALOGUE';
    if (config.activity) await require('../../migrations/postgres').run('check', { direct: true,
      connectionString: role === 'api' ? config.connectionString : (config.activity.connectionString || config.connectionString), namespace: config.activity.namespace,
      catalogue: (selected?.nativeSelection ?? selected?.intakeProfile) ? require('../../tenant-lifecycle/generation-domain').catalogue(selected.nativeSelection ?? selected.intakeProfile) : require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
  } catch (error) {
    throw diagnostics.annotate(error, role, checkPhase);
  } finally {
    await Promise.allSettled(owned.reverse().map(resource => resource.close()));
  }
}
function create (selected, source) {
  // Parse targets at each operation, not only admin boot: a changed configured
  // role file can never inherit the previous file's successful verification.
  const targets = selected.targets.map(target => {
    let current;
    return { role: target.role, get config () { if (!current) throw failure('PLATFORM_VERIFICATION_TARGET'); return current.config; },
      get operationProfileDigest () { if (!current) throw failure('PLATFORM_VERIFICATION_TARGET'); return (current.operationConfig?.nativeSelection ?? current.operationConfig?.intakeProfile)?.digest; },
      async prepare () { current = loadTarget(target, source); if (current.config.platformVerification.namespace !== selected.namespace) throw failure('PLATFORM_VERIFICATION_TARGET'); },
      async check () {
        try { await checkTarget(current); } finally { await current.config.consumers?.realtime?.slicePeers?.close?.(); await current.operationConfig?.ownership?.close?.(); } } };
  });
  return verifier.create({ ...selected, targets });
}
const send = (res, status, value) => { const bytes = Buffer.from(JSON.stringify(value)); res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' }); res.end(bytes); };
function api ({ service, admitted = () => true, fallback }) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://admin.invalid');
    if (url.pathname === '/v1/platform-verification/openapi.json' && req.method === 'GET' && !url.search) return send(res, 200, require('./platform-verification.openapi.json'));
    if (url.pathname !== '/v1/platform-verification') return fallback(req, res);
    try {
      if (!admitted()) return send(res, 503, { error: 'SERVICE_CLOSED' });
      if (url.search) return send(res, 404, { error: 'NOT_FOUND' });
      if (req.method === 'GET') return send(res, 200, await service.inspect());
      if (!['POST', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      let length = 0; const chunks = [];
      for await (const bytes of req) { length += bytes.length; if (length > 128) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' }); chunks.push(bytes); }
      let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { return send(res, 400, { error: 'BODY_INVALID' }); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) return send(res, 422, { error: 'BODY_INVALID' });
      return send(res, 200, req.method === 'DELETE' ? await service.invalidate() : await service.verify());
    } catch (error) {
      if (res.headersSent) return res.destroy();
      return send(res, error.code === 'PLATFORM_VERIFICATION_IN_PROGRESS' ? 409 : 503,
        { error: error.code === 'PLATFORM_VERIFICATION_IN_PROGRESS' ? error.code : 'PLATFORM_VERIFICATION_FAILED', ...(diagnostics.read(error) ? { diagnostic: diagnostics.read(error) } : {}) });
    }
  };
}
module.exports = { create, api, loadTarget, checkTarget };
