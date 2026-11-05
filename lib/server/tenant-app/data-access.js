'use strict';

const shiro = require('shiro-trie');
const authentication = require('../../api3/tenant-authentication');
const extract = require('../../authorization/credential-extraction');

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
  collections = ['entries'], legacyCollections = [], safeRoutes = {}, strictSettingsRead = false }) {
  if (!secrets || typeof secrets.verifyLegacyCredential !== 'function' ||
      !authority || typeof authority.authorize !== 'function' || typeof verifierContext !== 'function') {
    throw new TypeError('Data access requires secrets, current authority and trusted verifier identity');
  }
  function admit ({ request, version = 3 }) {
    if (![1, 2, 3].includes(version)) throw failure('TENANT_DATA_UNSUPPORTED');
    const path = version === 3 ? request.path : request.path.replace(/\.(json|svg|csv|txt|png|html|tsv|js)$/i, '');
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        (safeRoutes[version] || []).includes(path.replace(/\/$/, ''))) {
      return { actions: [], reads: [], discovery: true };
    }
    return admission(request, version, collections, legacyCollections);
  }
  async function dataAccess ({ tenant, request, version = 3 }) {
    const selected = admit({ request, version });
    const credentials = extract(request, { version });
    if (credentials.invalid) return null;
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw failure('TENANT_DATA_VERIFIER_INVALID');
    let token = credentials.token;
    if (credentials.tokenCarrier === 'legacy') {
      const issued = await secrets.exchangeLegacyCredential(context, token,
        async principal => await authority.subjectSnapshot({ tenant, principal }) !== null);
      if (!issued && !credentials.apiSecret) return null;
      token = issued && issued.token;
    }
    const principal = await secrets.verifyLegacyCredential(context, {
      apiSecret: credentials.apiSecret, token
    });
    if (!principal || (credentials.presented && principal.kind === 'anonymous')) return null;
    const permissions = shiro.new();
    let subject = principal.kind === 'subject' ? { _id: principal.subjectId } : undefined;
    if (selected.actions.length) {
      if (principal.kind === 'anonymous') throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      let granted = false;
      for (const action of selected.actions) {
        const permission = 'api:' + selected.logical + ':' + action;
        if (await authority.authorize({ tenant, principal, permission }) === true) {
          permissions.add(permission);
          granted = true;
        }
      }
      if (!granted) throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      if (subject) {
        const snapshot = await authority.subjectSnapshot({ tenant, principal });
        if (!snapshot || typeof snapshot.sub !== 'string' || !snapshot.sub.length) return null;
        subject = { ...subject, name: snapshot.sub };
      }
    }
    for (const logical of selected.reads) {
      const settingsAdmin = logical === 'settings' && version === 3 &&
        (strictSettingsRead || /^\/settings\/?(?:history(?:\/|$)|$)/.test(request.path));
      const permission = 'api:' + logical + (settingsAdmin ? ':admin' : ':read');
      if (await authority.authorize({ tenant, principal, permission }) !== true) {
        throw failure(version === 3 ? 'TENANT_DATA_FORBIDDEN' : 'TENANT_LEGACY_FORBIDDEN');
      }
      permissions.add(permission);
    }
    if (selected.discovery) {
      for (const logical of new Set([...collections, ...legacyCollections])) {
        for (const action of ['read', 'create', 'update', 'delete', 'admin']) {
          const permission = 'api:' + logical + ':' + action;
          if (await authority.authorize({ tenant, principal, permission }) === true) permissions.add(permission);
        }
      }
      for (const permission of ['api:status:read', 'admin:api:permissions:read',
        '*:*:read', '*:*:write', '*:*:admin']) {
        if (await authority.authorize({ tenant, principal, permission }) === true) permissions.add(permission);
      }
    }
    authentication.bind(request, Object.freeze({ shiros: [permissions],
      defaults: principal.kind === 'anonymous', ...(subject ? { subject } : {}) }));
    return Object.freeze({ tenant, principal: principal.kind === 'subject' ? principal.subjectId : principal.kind,
      consumer: context.consumer });
  }
  return Object.assign(dataAccess, { admit });
};
