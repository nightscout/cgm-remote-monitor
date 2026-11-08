'use strict';

const shiro = require('shiro-trie');
const authentication = require('../../api3/tenant-authentication');
const extract = require('../../authorization/credential-extraction');
const accessToken = require('../../tenant-authorization/access-token');

function failure (code) {
  return Object.assign(new Error(code), { code });
}

function admission (request, version, collections, legacyCollections) {
  let path;
  try { path = decodeURIComponent(request.path); } catch { throw failure('TENANT_DATA_UNSUPPORTED'); }
  if (path.includes('\0')) throw failure('TENANT_DATA_UNSUPPORTED');
  if (version !== 3) path = path.replace(/\.(json|svg|csv|txt|png|html|tsv)$/i, '');
  const parts = path.replace(/\/$/, '').split('/').slice(1);
  let logical = parts[0];
  if (version !== 3 && logical === 'profiles') logical = 'profile';
  const method = ['HEAD', 'OPTIONS'].includes(request.method) ? 'GET' : request.method;
  let actions;
  let reads = [];
  if (version === 3) {
    if (!collections.includes(logical)) throw failure('TENANT_DATA_UNSUPPORTED');
    const list = parts.length === 1;
    const history = parts[1] === 'history' && parts.length <= 3;
    const addressed = parts.length === 2 && !history;
    if (method === 'GET' && (list || history || addressed)) actions = [];
    else if (method === 'POST' && list) actions = ['create', 'update'];
    else if (method === 'PUT' && addressed) actions = ['create', 'update'];
    else if (method === 'PATCH' && addressed) actions = ['update'];
    else if (method === 'DELETE' && addressed) actions = ['delete'];
    else throw failure('TENANT_DATA_UNSUPPORTED');
    if (!actions.length) reads = [logical];
  } else {
    if (['echo', 'times', 'slice', 'count'].includes(logical)) {
      if (!legacyCollections.includes('entries') || method !== 'GET') throw failure('TENANT_DATA_UNSUPPORTED');
      reads = ['entries'];
      const selected = parts[1];
      if (logical === 'echo') {
        if (!legacyCollections.includes(selected)) throw failure('TENANT_DATA_UNSUPPORTED');
        reads.push(selected);
      } else if (['slice', 'count'].includes(logical) && ['treatments', 'devicestatus'].includes(selected)) {
        if (!legacyCollections.includes(selected)) throw failure('TENANT_DATA_UNSUPPORTED');
        reads.push(selected);
      }
      return { logical: 'entries', actions: [], reads };
    }
    if (!legacyCollections.includes(logical) || parts.length > 2) throw failure('TENANT_DATA_UNSUPPORTED');
    const spec = parts[1];
    if (method === 'GET') actions = [];
    else if (method === 'POST' && (!spec || (logical === 'entries' && spec === 'preview'))) actions = ['create'];
    else if (method === 'PUT' && !spec && ['treatments', 'activity', 'profile', 'food'].includes(logical)) actions = ['update'];
    else if (method === 'DELETE' && (!spec || spec !== 'preview') &&
        (!['food', 'activity'].includes(logical) || spec)) actions = ['delete'];
    else throw failure('TENANT_DATA_UNSUPPORTED');
    reads = [logical];
    if (logical === 'profile' && method === 'POST') actions.push('update');
  }
  return { logical, actions, reads };
}

module.exports = function createDataAccess ({ secrets, authority, verifierContext,
  collections = ['entries'], legacyCollections = [], safeRoutes = {}, strictSettingsRead = false, derivedReads = false, accessTokens, humanSessions }) {
  if (!secrets || typeof secrets.verifyLegacyCredential !== 'function' ||
      !authority || typeof authority.authorize !== 'function' || typeof verifierContext !== 'function') {
    throw new TypeError('Data access requires secrets, current authority and trusted verifier identity');
  }
  if (accessTokens !== undefined && typeof accessTokens.authenticate !== 'function') throw new TypeError('Local token authentication required');
  function admit ({ request, version = 3 }) {
    if (![1, 2, 3].includes(version)) throw failure('TENANT_DATA_UNSUPPORTED');
    const path = version === 3 ? request.path : request.path.replace(/\.(json|svg|csv|txt|png|html|tsv|js)$/i, '');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        (safeRoutes[version] || []).includes(path.replace(/\/$/, ''))) {
      return { actions: [], reads: [], discovery: true };
    }
    if (derivedReads && version === 2 && ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let derived;
      try { derived = decodeURIComponent(path).replace(/\/$/, ''); } catch { throw failure('TENANT_DATA_UNSUPPORTED'); }
      if (/^\/properties(?:\/.*)?$/i.test(derived) || /^\/ddata\/at(?:\/[^/]+)?$/i.test(derived)) {
        return { actions: [], reads: ['entries', 'treatments'] };
      }
      // Keep the shipping summary permission: concrete per-collection grants
      // must not be promoted into the wildcard permission.
      if (derived.toLowerCase() === '/summary') return { actions: [], reads: ['*'] };
    }
    return admission(request, version, collections, legacyCollections);
  }
  async function dataAccess ({ tenant, request, version = 3 }) {
    const selected = admit({ request, version });
    const credentials = extract(request, { version });
    if (credentials.invalid) return null;
    const human = humanSessions && humanSessions.credential(request);
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw failure('TENANT_DATA_VERIFIER_INVALID');
    let token = credentials.token;
    let principal;
    let currentAuthority = authority;
    if (human && (human.cookie || humanSessions.accepts(human.token))) {
      if (credentials.apiSecret || credentials.tokenCarrier === 'legacy') return null;
      const { actor } = await humanSessions.authenticate({ tenant, credential: human.token, request, purpose: 'data' });
      principal = { kind: 'subject', subjectId: actor.subject };
      currentAuthority = {
        authorize: async ({ permission }) => actor.allows(permission),
        subjectSnapshot: async () => ({ sub: actor.subject, permissionGroups: actor.permissionGroups })
      };
    } else if (accessTokens && accessToken.accepts(token)) {
      const { claims, state } = await accessTokens.authenticate({ token, tenant });
      principal = { kind: 'subject', subjectId: claims.sub };
      // This operation's current snapshot supplies permissions and attribution.
      // Never retain this authority across requests.
      currentAuthority = {
        authorize: async ({ permission }) => state.allows(permission),
        subjectSnapshot: async () => state.name ? { sub: state.name, permissionGroups: state.permissionGroups } : null
      };
    } else {
      if (credentials.tokenCarrier === 'legacy') {
        const issued = await secrets.exchangeLegacyCredential(context, token,
          async principal => await authority.subjectSnapshot({ tenant, principal }) !== null);
        if (!issued && !credentials.apiSecret) return null;
        token = issued && issued.token;
      }
      principal = await secrets.verifyLegacyCredential(context, {
        apiSecret: credentials.apiSecret, token
      });
    }
    if (!principal || (credentials.presented && principal.kind === 'anonymous')) return null;
    const permissions = shiro.new();
    let subject = principal.kind === 'subject' ? { _id: principal.subjectId } : undefined;
    if (selected.actions.length) {
      if (principal.kind === 'anonymous') throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      let granted = false;
      for (const action of selected.actions) {
        const permission = 'api:' + selected.logical + ':' + action;
        if (await currentAuthority.authorize({ tenant, principal, permission }) === true) {
          permissions.add(permission);
          granted = true;
        }
      }
      if (!granted) throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      if (subject) {
        const snapshot = await currentAuthority.subjectSnapshot({ tenant, principal });
        if (!snapshot || typeof snapshot.sub !== 'string' || !snapshot.sub.length) return null;
        subject = { ...subject, name: snapshot.sub };
      }
    }
    for (const logical of selected.reads) {
      const settingsAdmin = logical === 'settings' && version === 3 &&
        (strictSettingsRead || /^\/settings\/?(?:history(?:\/|$)|$)/.test(request.path));
      const permission = 'api:' + logical + (settingsAdmin ? ':admin' : ':read');
      if (await currentAuthority.authorize({ tenant, principal, permission }) !== true) {
        throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      }
      permissions.add(permission);
    }
    if (selected.discovery) {
      for (const logical of new Set([...collections, ...legacyCollections])) {
        for (const action of ['read', 'create', 'update', 'delete', 'admin']) {
          const permission = 'api:' + logical + ':' + action;
          if (await currentAuthority.authorize({ tenant, principal, permission }) === true) permissions.add(permission);
        }
      }
      for (const permission of ['api:status:read', 'admin:api:permissions:read',
        '*:*:read', '*:*:write', '*:*:admin']) {
        if (await currentAuthority.authorize({ tenant, principal, permission }) === true) permissions.add(permission);
      }
    }
    authentication.bind(request, Object.freeze({ shiros: [permissions],
      defaults: principal.kind === 'anonymous', ...(subject ? { subject } : {}) }));
    return Object.freeze({ tenant, principal: principal.kind === 'subject' ? principal.subjectId : principal.kind,
      consumer: context.consumer });
  }
  return Object.assign(dataAccess, { admit });
};
