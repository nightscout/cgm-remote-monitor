'use strict';

const c = require('./contract');
const ipc = require('./ipc');
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
function operations ({ token, config, admission, authority, executeWrite, alarmConnection, presentationFor }) {
  if (typeof token !== 'symbol') throw new TypeError('Private API requires an owned transport capability');
  const configured = require('../../tenant-resolution')({ aliases: config.aliases });
  async function tenantFor (host) {
    const tenant = await admission.resolveHost(host);
    if (!config.bindings.has(tenant) || configured.resolve({ rawHeaders: ['Host', host], socket: {} }) !== tenant) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
    return tenant;
  }
  const receiver = createAlarmReceiver({ connection: alarmConnection, namespace: config.socketForwarding.alarm.namespace,
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
  return Object.freeze({
    async '/authorize' (request, body) {
      if (request.transport !== token || !c.exact(body, ['host', 'tenant', 'namespace', 'credential'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host); if (tenant !== body.tenant) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
      const actor = await authority.verify({ tenant, namespace: body.namespace, credential: body.credential });
      return { permissions: actor.permissions, collections: actor.collections,
        ...(body.namespace === '/' && actor.permissions.read && presentationFor ? { display: await presentationFor(tenant) } : {}) };
    },
    async '/mutate' (request, body) {
      if (request.transport !== token || !c.exact(body, ['host', 'envelope'])) c.fail('SOCKET_PRIVATE_REQUEST_REFUSED');
      const tenant = await tenantFor(body.host);
      return scope.withTenant(tenant, () => receiver({ transport: request.transport, host: body.host }, body.envelope));
    }
  });
}
async function boot ({ config, secrets, authority, accessTokens, verifierContext, contextForOperation, displaySettings }) {
  const settings = config.socketForwarding;
  const admission = admissionFactory.load({ file: settings.admissionFile, maxTenants: settings.maxTenants });
  if (admission.ids.some(id => !config.bindings.has(id))) c.fail('SOCKET_PRIVATE_TENANT_REFUSED');
  let alarmConnection, channel;
  try {
    await require('../../migrations/postgres').run('check', { direct: true, connectionString: config.readinessConnectionString,
      namespace: settings.alarm.namespace, catalogue: require('../../../migrations/candidates/postgres-alarm-suppression-v1.json') });
    alarmConnection = await require('../../storage/postgres-connection')({ connectionString: settings.alarm.connectionString, max: 4,
      connectionTimeoutMillis: settings.ipc.timeoutMs, statement_timeout: settings.ipc.timeoutMs, application_name: 'nightscout-socket-alarm' });
    const socketAuthority = createAuthority({ secrets, authority, accessTokens, verifierContext, admission, domains: config.domains.filter(domain => require('./authority').DOMAINS.includes(domain)) });
    const executeWrite = createExecutor({ contextForOperation });
    const presentationFor = displaySettings ? async tenant => {
      const state = await displaySettings.read(tenant);
      return { units: state.effective.DISPLAY_UNITS.value, showSeconds: state.effective.SHOW_SECONDS.value };
    } : undefined;
    channel = await ipc.open(settings.ipc, token => operations({ token, config, admission, authority: socketAuthority, executeWrite, alarmConnection, presentationFor }));
    return Object.freeze({ async close () { try { await channel.close(); } finally { await alarmConnection.end(); } } });
  } catch (error) { if (channel) await channel.close(); if (alarmConnection) await alarmConnection.end(); throw error; }
}
module.exports = { boot, operations, ackPermission };
