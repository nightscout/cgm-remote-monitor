'use strict';

const authorityPrincipal = require('../../tenant-authorization/authority-principal');
const accessToken = require('../../tenant-authorization/access-token');
const c = require('./contract');
const DOMAINS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
function credentialFor (namespace, message = {}) {
  if (!c.object(message)) c.fail('SOCKET_CREDENTIAL_REFUSED');
  const names = namespace === '/' ? ['secret', 'token', 'humanToken'] : namespace === '/storage' ? ['accessToken', 'humanToken']
    : namespace === '/alarm' ? ['secret', 'jwtToken', 'accessToken', 'humanToken'] : [];
  if (!names.length) c.fail('SOCKET_NAMESPACE_REFUSED');
  const value = {};
  for (const name of names) {
    if (name === 'humanToken' && Object.hasOwn(message, name) && (typeof message[name] !== 'string' || !message[name])) c.fail('SOCKET_CREDENTIAL_REFUSED');
    if (message[name] !== undefined && message[name] !== null && message[name] !== '') {
      if (typeof message[name] !== 'string' || message[name].length > 8192) c.fail('SOCKET_CREDENTIAL_REFUSED');
      value[name] = message[name];
    }
  }
  return Object.freeze(value);
}
function create ({ secrets, authority, accessTokens, humanSessions, verifierContext, admission, domains = DOMAINS } = {}) {
  if (typeof secrets?.verifyLegacyCredential !== 'function' || typeof authority?.subjectAuthorizationSnapshot !== 'function' ||
      typeof authority?.permissionSnapshot !== 'function' || typeof verifierContext !== 'function' || typeof admission?.allows !== 'function') throw new TypeError('Socket authority requires trusted current tenant credential adapters');
  if (humanSessions !== undefined && (typeof humanSessions.accepts !== 'function' || typeof humanSessions.authenticate !== 'function')) throw new TypeError('Configured human socket access engine required');
  async function verify ({ tenant, namespace, credential }) {
    if (!c.uuid(tenant) || !await admission.allows(tenant) || !c.object(credential)) c.fail('SOCKET_AUTHORITY_REFUSED');
    const normalized = credentialFor(namespace, credential);
    if (Object.keys(credential).some(k => !Object.hasOwn(normalized, k))) c.fail('SOCKET_CREDENTIAL_REFUSED');
    if (namespace === '/storage' && !normalized.accessToken && !normalized.humanToken) c.fail('SOCKET_CREDENTIAL_REFUSED');
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) c.fail('SOCKET_AUTHORITY_REFUSED');
    let principal, current;
    const token = normalized.accessToken || normalized.token || normalized.jwtToken;
    const recognizedHuman = humanSessions && Object.values(normalized).find(value => humanSessions.accepts(value));
    if (normalized.humanToken !== undefined || recognizedHuman) {
      if (Object.keys(normalized).length !== 1) c.fail('SOCKET_CREDENTIAL_REFUSED');
      if (!humanSessions) c.fail('SOCKET_CREDENTIAL_REFUSED');
      const accepted = await humanSessions.authenticate({ tenant, token: normalized.humanToken || recognizedHuman, purpose: 'data', activity: false });
      principal = { kind: 'subject', subjectId: accepted.actor.subject }; current = accepted.actor.allows;
    } else if (accessTokens && accessToken.accepts(token)) {
      const accepted = await accessTokens.authenticate({ token, tenant });
      principal = { kind: 'subject', subjectId: accepted.claims.sub }; current = accepted.state.allows;
    } else {
      principal = authorityPrincipal(await secrets.verifyLegacyCredential(context, normalized.accessToken
        ? (secrets.acceptsDataToken?.(normalized.accessToken) ? { token: normalized.accessToken } : { apiSecret: normalized.accessToken }) : { apiSecret: normalized.secret, token: normalized.token || normalized.jwtToken }));
      // /storage and native /alarm accessToken is a subject credential, not a
      // new root carrier. Legacy main secret retains its own root behavior.
      if (!principal || normalized.accessToken && principal.kind !== 'subject') c.fail('SOCKET_AUTHORITY_REFUSED');
      // One current authority snapshot answers every permission below.
      const snapshot = principal.kind === 'subject' ? await authority.subjectAuthorizationSnapshot({ tenant, principal })
        : await authority.permissionSnapshot({ tenant, principal });
      if (!snapshot) c.fail('SOCKET_AUTHORITY_REFUSED');
      current = snapshot.allows;
    }
    const permissions = { read: current('api:*:read'), write: current('api:*:create,update,delete'),
      write_treatment: current('api:treatments:create,update,delete'), ack: principal.kind !== 'anonymous' && current('notifications:*:ack') };
    const collections = domains.filter(logical => current('api:' + logical + (logical === 'settings' ? ':admin' : ':read')));
    return Object.freeze({ tenant, principal, permissions: Object.freeze(permissions), collections: Object.freeze(collections) });
  }
  return Object.freeze({ verify,
    async authorizeWrite (operation) {
      const actor = await verify(operation);
      if (operation.event === 'ack') return actor.permissions.ack ? actor : null;
      if (operation.namespace !== '/' || !['dbAdd', 'dbUpdate', 'dbUpdateUnset', 'dbRemove'].includes(operation.event) ||
          !Array.isArray(operation.args) || operation.args.length !== 1 || !domains.includes(operation.args[0]?.collection)) return null;
      return (operation.args[0].collection === 'treatments' ? actor.permissions.write_treatment : actor.permissions.write) ? actor : null;
    }
  });
}
module.exports = { create, credentialFor, DOMAINS };
