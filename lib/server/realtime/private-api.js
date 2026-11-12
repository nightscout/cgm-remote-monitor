'use strict';

const c = require('./contract');
const admissionFactory = require('./admission');
const createAuthority = require('./authority').create;
const createExecutor = require('../tenant-socket-write-executor').createExecutor;
const createAlarmReceiver = require('../../tenant-alarms/composition').createReceiver;
const shiro = require('shiro-trie');
const scope = require('../../storage/tenant-scope');

// The grant snapshot is read inside the alarm transaction. Credential verification
// is fresh at this admission; later revocation does not retroactively undo it.
async function ackPermission (connection, namespace, actor) {
  const prefix = '"' + namespace + '".tenant_authorization_';
  const result = await connection.query('SELECT c.anonymous_roles,s.subject_id,l.role_name,r.name AS found_role,r.permissions FROM ' + prefix + 'config c' +
    ' LEFT JOIN ' + prefix + 'subjects s ON s.tenant_id=c.tenant_id AND s.subject_id=$2' +
    ' LEFT JOIN ' + prefix + 'subject_roles l ON l.tenant_id=s.tenant_id AND l.subject_id=s.subject_id' +
    ' LEFT JOIN ' + prefix + 'roles r ON r.tenant_id=l.tenant_id AND r.name=l.role_name WHERE c.tenant_id=$1 ORDER BY l.role_name',
  [actor.tenant, actor.principal.kind === 'subject' ? actor.principal.subjectId : null]);
  if (!result.rows.length) return false;
  if (actor.principal.kind === 'root') return true;
  if (actor.principal.kind !== 'subject' || !result.rows[0].subject_id) return false;
  const defaults = { denied: [], readable: ['*:*:read'], 'status-only': ['api:status:read'] };
  const configured = result.rows[0].anonymous_roles;
  if (!Array.isArray(configured) || configured.some(name => !Object.hasOwn(defaults, name))) c.fail('SOCKET_AUTHORITY_REFUSED');
  const groups = configured.map(name => defaults[name]);
  for (const row of result.rows) if (row.role_name !== null) {
    if (row.found_role !== row.role_name || !Array.isArray(row.permissions) || row.permissions.length > 256 ||
        row.permissions.some(p => typeof p !== 'string' || !p || p.length > 512 || p.split('').some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))) c.fail('SOCKET_AUTHORITY_REFUSED');
    groups.push(row.permissions);
  }
  return groups.some(group => { const trie = shiro.new(); trie.add(group); return trie.check('notifications:*:ack'); });
}
function operations ({ token, config, admission, authority, executeWrite, alarmConnection, presentationFor, prepareTenant }) {
  if (typeof token !== 'symbol') throw new TypeError('Private API requires an owned transport capability');
  // Static mode: the admission file and the api's own alias list must agree.
  // Registry mode: admission is the api's registry view (same resolver), so
  // the host resolves once and the tenant's entry is materialized by it.
  const configured = admission.registry ? null : require('../../tenant-resolution')({ aliases: config.aliases });
  async function tenantFor (host) {
    const tenant = await admission.resolveHost(host);
    if (!config.bindings.has(tenant) || (configured && configured.resolve({ rawHeaders: ['Host', host], socket: {} }) !== tenant)) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
    return tenant;
  }
  const selectedState = config.socketForwarding.consumerState;
  const admit = selectedState ? require('../../tenant-notifications/ack-admission')({...selectedState,
    alarmNamespace: config.socketForwarding.alarm.namespace}) : null;
  const receiver = createAlarmReceiver({ connection: alarmConnection, namespace: config.socketForwarding.alarm.namespace,
    ...(admit ? {async admitAckInTransaction (operation) {
      // Current linked evaluator admission/config, in addition to the original
      // credential/authority checks below; no stale consumer-key fallback.
      const current = await selectedState.readCurrent(operation.operation.tenant);
      if (!current) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
      const decision = await admit({...operation, configIdentity: current.identity});
      const fresh = await selectedState.readCurrent(operation.operation.tenant);
      if (!fresh || fresh.identity !== current.identity) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
      return decision;
    }} : {}),
    authenticateTransport: async request => request.transport === token,
    resolveTenant: request => tenantFor(request.host),
    async authorizeSocket (operation) {
      const actor = await authority.authorizeWrite(operation);
      return actor ? { ...actor, redactions: Object.values(operation.credential).filter(v => typeof v === 'string') } : null;
    },
    async authorizeAckInTransaction (operation) {
      if (!await admission.allows(operation.tenant)) return false;
      const actor = await authority.authorizeWrite(operation);
      return !!actor && ackPermission(operation.connection, config.namespaces.authorization, actor);
    }, executeWrite });
  const selected = {
    async authorizeSocket (request, body) {
      if (request.transport !== token) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      // Registry-mode warm: realtime names the tenant only (no reverse lookup
      // exists), with namespace '/' and an empty credential. The api prepares
      // the tenant if the registry admits it and always answers denied.
      if (admission.registry && c.exact(body, ['tenant', 'namespace', 'credential'])) {
        if (body.namespace !== '/' || !c.object(body.credential) || Object.keys(body.credential).length ||
            !await admission.allows(body.tenant)) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
        if (prepareTenant) await prepareTenant(body.tenant);
        return { denied: true };
      }
      if (!c.exact(body, ['host', 'tenant', 'namespace', 'credential'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host);
      if (prepareTenant) await prepareTenant(tenant);
      if (tenant !== body.tenant) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
      let actor;
      try { actor = await authority.verify({ tenant, namespace: body.namespace, credential: body.credential }); } catch (error) {
        if (['HUMAN_SESSION_REFUSED', 'HUMAN_AUTHORITY_REFUSED', 'SOCKET_AUTHORITY_REFUSED', 'SOCKET_CREDENTIAL_REFUSED', 'AUTHORITY_FORBIDDEN', 'TOKEN_FORMAT', 'TOKEN_HEADER', 'TOKEN_KEY', 'TOKEN_SIGNATURE', 'TOKEN_CLAIMS'].includes(error.code)) return { denied: true };
        throw error;
      }
      return { permissions: actor.permissions, collections: actor.collections,
        ...(body.namespace === '/' && actor.permissions.read && presentationFor ? { display: await presentationFor(tenant) } : {}) };
    },
    async executeSocketMutation (request, body) {
      if (request.transport !== token || !c.exact(body, ['host', 'envelope'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host);
      if (prepareTenant) await prepareTenant(tenant);
      return scope.withTenant(tenant, () => receiver({ transport: request.transport, host: body.host }, body.envelope));
    }
  };
  selected.authorizeSocket = require('../../diagnostics/m7').wrapAsync(selected.authorizeSocket, 'api.authorize_socket');
  return Object.freeze(selected);
}
async function boot ({ config, secrets, authority, accessTokens, humanSessions, verifierContext, contextForOperation, displaySettings, operationWindow, prepareTenant }) {
  const settings = config.socketForwarding;
  // Registry mode (decision tenant-registry): admission is the api's registry
  // view; a tenant is admitted while its registry entry is active.
  const admission = config.registry
    ? require('./registry-admission').create({ resolver: config.resolver,
      active: async tenant => { await config.prepareRegistryTenant(tenant); return config.bindings.has(tenant); } })
    : admissionFactory.load({ file: settings.admissionFile, maxTenants: settings.maxTenants });
  if (admission.ids.some(id => !config.bindings.has(id))) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
  let alarmConnection;
  try {
    for (const connectionString of [config.readinessConnectionString, settings.alarm.connectionString]) {
      await require('../../migrations/postgres').run('check', { direct: true, connectionString,
        namespace: settings.alarm.namespace, catalogue: require('../../../migrations/candidates/postgres-alarm-suppression-v1.json') });
    }
    alarmConnection = await require('../../storage/postgres-connection')({ connectionString: settings.alarm.connectionString, max: 4,
      connectionTimeoutMillis: settings.operationTimeoutMs, statement_timeout: settings.operationTimeoutMs, application_name: 'nightscout-socket-alarm' });
    const socketAuthority = createAuthority({ secrets, authority, accessTokens, humanSessions: humanSessions?.engine, verifierContext, admission, domains: config.domains.filter(domain => require('./authority').DOMAINS.includes(domain)) });
    const executeWrite = createExecutor({ contextForOperation });
    const presentationFor = displaySettings ? async tenant => {
      const state = await displaySettings.read(tenant);
      return { units: state.effective.DISPLAY_UNITS.value, showSeconds: state.effective.SHOW_SECONDS.value };
    } : undefined;
    // serve/internal-listener binds this on the process's serve.internal.
    const internal = Object.freeze({ 'socket-authority': Object.freeze({
      create: token => operations({ token, config, admission, authority: socketAuthority, executeWrite, alarmConnection, presentationFor, prepareTenant }),
      ...(operationWindow ? { resolveTenant: async body => {
        // The registry-mode warm names its tenant only (authorizeSocket above).
        if (admission.registry && body.host === undefined) {
          if (!await admission.allows(body.tenant)) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
          return body.tenant;
        }
        return admission.resolveHost(body.host);
      } } : {}) }) });
    return Object.freeze({ internal, async close () { await alarmConnection.end(); } });
  } catch (error) { if (alarmConnection) await alarmConnection.end(); throw error; }
}
module.exports = { boot, operations, ackPermission };
