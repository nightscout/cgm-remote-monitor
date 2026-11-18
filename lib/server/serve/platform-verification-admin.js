'use strict';

const configFile = require('./config-file');
const verifier = require('./platform-verification');
const diagnostics = require('./platform-verification-diagnostic');
const failure = code => Object.assign(new Error(code), { code });
const KEYS = { api: 'MULTITENANT_PREVIEW_CONFIG', evaluator: 'MULTITENANT_EVALUATOR_CONFIG', realtime: 'MULTITENANT_REALTIME_CONFIG' };
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
  else config = require('../realtime/config').load(own);
  if (config.platformVerification?.role !== target.role) throw failure('PLATFORM_VERIFICATION_TARGET');
  return { role: target.role, config, source: own, target };
}
async function checkTarget (item) {
  const { config, role, source, target } = item;
  const owned = [];
  let operationWindow, checkPhase = 'OPERATION_READINESS';
  try {
    if (target.operationConfigFile) {
      const selected = require('./operation-cohort-config').load(source);
      const pool = new (require('pg').Pool)(selected.poolOptions);
      owned.push({ close: () => pool.end() });
      operationWindow = require('../../tenant-lifecycle/operation-window').create({ namespace: selected.namespace, pool,
        ...(selected.lockRule ? { lockRule: selected.lockRule } : { locks: selected.locks }),
        ...(selected.intakeProfile ? { intakeProfile: selected.intakeProfile } : {}),
        ...(config.trustedWorker ? { trustedWorker: true } : {}),
        ...(selected.leaseSessions === undefined ? {} : { leaseSessionCount: selected.leaseSessions }) });
      owned.push(operationWindow);
      if (selected.placement) owned.push(selected.placement);
      await operationWindow.ready();
    }
    if (role === 'api') {
      const domains = require('./postgres-domains');
      checkPhase = 'API_CATALOGUES';
      await domains.readiness(config, { platformCheck: true });
      const connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-admin-api-verification' });
      owned.push({ close: () => connection.end() });
      checkPhase = 'API_SERVING';
      const startup = await domains.assertServing({ ...config, bindings: new Map() }, connection, { operationWindow, warm: false, platformCheck: true });
      owned.push(startup);
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
      await require('./evaluator-readiness')(config, { operationWindow, platformCheck: true });
      checkPhase = 'TRUSTED_METADATA';
      if (config.trustedWorker) {
        const connection = await require('../../storage/postgres-connection')({ connectionString: config.connectionString, max: 1,
          connectionTimeoutMillis: 5000, statement_timeout: 5000, application_name: 'nightscout-admin-worker-verification' });
        owned.push({ close: () => connection.end() });
        const trusted = require('../../trusted-worker/postgres').create({ connection, namespaces: config.trustedWorker, ...(role === 'evaluator' ? { stream: true } : {}) });
        owned.push(trusted); await trusted.verify();
      }
    }
    checkPhase = 'ACTIVITY_CATALOGUE';
    if (config.activity) await require('../../migrations/postgres').run('check', { direct: true,
      connectionString: role === 'api' ? config.connectionString : (config.activity.connectionString || config.connectionString), namespace: config.activity.namespace,
      catalogue: operationWindow ? require('../../tenant-lifecycle/operation-window').catalogue(operationWindow) : require('../../tenant-lifecycle/postgres-candidate.json'), statementTimeoutMs: 5000 });
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
      async prepare () { current = loadTarget(target, source); if (current.config.platformVerification.namespace !== selected.namespace) throw failure('PLATFORM_VERIFICATION_TARGET'); },
      async check () {
        try { await checkTarget(current); } finally { current.config.consumers?.realtime?.placement?.close(); current.config.placement?.close(); } } };
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
