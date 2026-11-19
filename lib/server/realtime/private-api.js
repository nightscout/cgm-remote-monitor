'use strict';

const c = require('./contract');
const admissionFactory = require('./admission');
const createAuthority = require('./authority').create;
const createExecutor = require('../tenant-socket-write-executor').createExecutor;
const createAlarmReceiver = require('../../tenant-alarms/composition').createReceiver;
const scope = require('../../storage/tenant-scope');

function operations ({ token, config, admission, authority, executeWrite, alarmConnection, presentationFor, prepareTenant, displaySettings, admitRequest }) {
  if (typeof token !== 'symbol') throw new TypeError('Private API requires an owned transport capability');
  // Static mode: the admission file and the api's own alias list must agree.
  // Registry mode: admission is the api's registry view (same resolver), so
  // the host resolves once and the tenant's entry is materialized by it.
  const configured = admission.registry ? null : require('../../tenant-resolution')({ aliases: config.aliases });
  async function tenantFor (host) {
    const tenant = await admission.resolveHost(host);
    if (configured && (!config.bindings.has(tenant) || configured.resolve({ rawHeaders: ['Host', host], socket: {} }) !== tenant)) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
    return tenant;
  }
  const admitted = (tenant, fn) => admitRequest ? admitRequest(tenant, undefined, fn) : fn();
  const selectedTenant = (tenant, fn) => config.runRegistryTenant ? config.runRegistryTenant(tenant, fn) : fn();
  const selectedState = config.socketForwarding.consumerState;
  // The API already owns host/tenant registry admission. Linked evaluator
  // metadata borrows that exact namespace and capability inside the ACK write
  // transaction; no registry enumerator, static roster or new identity is opened.
  const metadataAdmission = selectedState && admission.registry
    ? Object.freeze({ namespace: config.registry?.namespace, allows: admission.allows }) : undefined;
  const admit = selectedState ? require('../../tenant-notifications/ack-admission')({...selectedState,
    alarmNamespace: config.socketForwarding.alarm.namespace}) : null;
  const receiver = createAlarmReceiver({ connection: alarmConnection, namespace: config.socketForwarding.alarm.namespace,
    ...(admit ? {async admitAckInTransaction (operation) {
      // Current linked evaluator admission/config, in addition to the original
      // credential/authority checks below; no stale consumer-key fallback.
      const current = await selectedState.readCurrent(operation.operation.tenant, metadataAdmission, displaySettings);
      if (!current) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
      const decision = await admit({...operation, configIdentity: current.identity});
      const fresh = await selectedState.readCurrent(operation.operation.tenant, metadataAdmission, displaySettings);
      if (!fresh || fresh.identity !== current.identity) c.fail('SOCKET_NOTIFICATION_STATE_CONFIG_REFUSED');
      return decision;
    }} : {}),
    authenticateTransport: async request => request.transport === token,
    resolveTenant: request => tenantFor(request.host),
    // Each forwarded write or ack is its own admitted api request, authorized
    // once here (decision credential-rotation-next-request, all revocation
    // applies from the next request).
    async authorizeSocket (operation) {
      const actor = await admitted(operation.tenant, () => authority.authorizeWrite(operation));
      return actor ? { ...actor, redactions: Object.values(operation.credential).filter(v => typeof v === 'string') } : null;
    },
    // The ack was authorized at its admission above. Inside the alarm
    // transaction only tenant admission (registry active) is checked again.
    authorizeAckInTransaction: async operation => await admission.allows(operation.tenant) === true, executeWrite });
  const selected = {
    async authorizeSocket (request, body) {
      if (request.transport !== token) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      // Registry-mode warm: realtime names the tenant only (no reverse lookup
      // exists), with namespace '/' and an empty credential. The api prepares
      // the tenant if the registry admits it and always answers denied.
      if (admission.registry && c.exact(body, ['tenant', 'namespace', 'credential'])) {
        if (body.namespace !== '/' || !c.object(body.credential) || Object.keys(body.credential).length ||
            !await admission.allows(body.tenant)) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
        return selectedTenant(body.tenant, async () => {
          if (prepareTenant) await prepareTenant(body.tenant);
          return { denied: true };
        });
      }
      if (!c.exact(body, ['host', 'tenant', 'namespace', 'credential'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host);
      if (tenant !== body.tenant) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
      return selectedTenant(tenant, async () => {
      if (prepareTenant) await prepareTenant(tenant);
      let actor;
      try { actor = await admitted(tenant, () => authority.verify({ tenant, namespace: body.namespace, credential: body.credential })); } catch (error) {
        if (['HUMAN_SESSION_REFUSED', 'HUMAN_AUTHORITY_REFUSED', 'SOCKET_AUTHORITY_REFUSED', 'SOCKET_CREDENTIAL_REFUSED', 'AUTHORITY_FORBIDDEN', 'TOKEN_FORMAT', 'TOKEN_HEADER', 'TOKEN_KEY', 'TOKEN_SIGNATURE', 'TOKEN_CLAIMS'].includes(error.code)) return { denied: true };
        throw error;
      }
      return { permissions: actor.permissions, collections: actor.collections,
        ...(body.namespace === '/' && actor.permissions.read && presentationFor ? { display: await presentationFor(tenant) } : {}) };
      });
    },
    async executeSocketMutation (request, body) {
      if (request.transport !== token || !c.exact(body, ['host', 'envelope'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host);
      return selectedTenant(tenant, async () => {
      if (prepareTenant) await prepareTenant(tenant);
      return scope.withTenant(tenant, () => receiver({ transport: request.transport, host: body.host }, body.envelope));
      });
    }
  };
  selected.authorizeSocket = require('../../diagnostics/m7').wrapAsync(selected.authorizeSocket, 'api.authorize_socket');
  return Object.freeze(selected);
}
async function boot ({ config, secrets, authority, accessTokens, humanSessions, verifierContext, contextForOperation, displaySettings, operationWindow, prepareTenant, admitRequest }) {
  const settings = config.socketForwarding;
  // Registry mode (decision tenant-registry): admission is the api's registry
  // view; a tenant is admitted while its registry entry is active.
  if (settings.consumerState && !displaySettings) throw new TypeError('Notification ACK requires the API-owned settings reader');
  const admission = config.registry
    ? require('./registry-admission').create({ resolver: config.resolver,
      active: async tenant => !!await config.prepareRegistryTenant(tenant) })
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
      create: token => operations({ token, config, admission, authority: socketAuthority, executeWrite, alarmConnection, presentationFor, prepareTenant, displaySettings, admitRequest }),
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
module.exports = { boot, operations };
