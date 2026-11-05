'use strict';

const shiro = require('shiro-trie');
const authentication = require('../../api3/tenant-authentication');

function failure (code) {
  return Object.assign(new Error(code), { code });
}

function addressedEntriesPath (path) {
  const match = typeof path === 'string' && /^\/entries\/([^/]+)\/?$/.exec(path);
  if (!match) return false;
  try {
    const identifier = decodeURIComponent(match[1]);
    return !identifier.includes('/') && identifier.toLowerCase() !== 'history';
  } catch {
    return false;
  }
}

module.exports = function createDataAccess ({ secrets, authority, verifierContext }) {
  if (!secrets || typeof secrets.verifyLegacyCredential !== 'function' ||
      !authority || typeof authority.authorize !== 'function' || typeof verifierContext !== 'function') {
    throw new TypeError('Data access requires secrets, current authority and trusted verifier identity');
  }
  return async function dataAccess ({ tenant, request }) {
    // POST and PUT select their exact permission at the stored-identity branch.
    const list = typeof request.path === 'string' && /^\/entries\/?$/.test(request.path);
    const addressed = addressedEntriesPath(request.path);
    const historyPath = typeof request.path === 'string' ? request.path.replace(/\/$/, '') : '';
    const history = historyPath === '/entries/history' || /^\/entries\/history\/[^/]+$/.test(historyPath);
    const posting = request.method === 'POST' && list;
    const replacing = request.method === 'PUT' && addressed;
    const patching = request.method === 'PATCH' && addressed;
    const deleting = request.method === 'DELETE' && addressed;
    const mutating = posting || replacing || patching || deleting;
    if (!mutating && (request.method !== 'GET' || (!list && !addressed && !history))) {
      throw failure('TENANT_DATA_UNSUPPORTED');
    }
    // API3's shipping authenticator consumes Bearer headers, not legacy
    // v1/v2 query/body credentials. Unsupported credential carriers must
    // refuse explicitly rather than accidentally become anonymous.
    if ([request.query, request.body].some(value => value &&
        ['secret', 'token'].some(key => Object.hasOwn(value, key)))) return null;
    const credentials = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const key = request.rawHeaders[i].toLowerCase();
      if (!['authorization', 'api-secret'].includes(key)) continue;
      if (Object.hasOwn(credentials, key)) return null;
      credentials[key] = request.rawHeaders[i + 1];
    }
    const authorization = credentials.authorization;
    if (authorization !== undefined && !/^Bearer [^\s,]{1,8192}$/i.test(authorization)) return null;
    const context = await verifierContext(tenant);
    if (!context || context.tenant !== tenant) throw failure('TENANT_DATA_VERIFIER_INVALID');
    const principal = await secrets.verifyLegacyCredential(context, {
      apiSecret: credentials['api-secret'],
      token: authorization === undefined ? undefined : authorization.slice(7)
    });
    if (!principal) return null;
    const permissions = shiro.new();
    let subject = principal.kind === 'subject' ? { _id: principal.subjectId } : undefined;
    if (mutating) {
      if (principal.kind === 'anonymous') throw failure('TENANT_DATA_FORBIDDEN');
      const actions = posting || replacing ? ['create', 'update'] : [deleting ? 'delete' : 'update'];
      let granted = false;
      for (const action of actions) {
        const permission = 'api:entries:' + action;
        if (await authority.authorize({ tenant, principal, permission }) === true) {
          permissions.add(permission);
          granted = true;
        }
      }
      if (!granted) throw failure('TENANT_DATA_FORBIDDEN');
      if (subject) {
        const snapshot = await authority.subjectSnapshot({ tenant, principal });
        if (!snapshot) return null;
        subject = { ...subject, name: snapshot.sub };
      }
    } else {
      const permission = 'api:entries:read';
      if (await authority.authorize({ tenant, principal, permission }) !== true) {
        throw failure('TENANT_DATA_FORBIDDEN');
      }
      permissions.add(permission);
    }
    authentication.bind(request, Object.freeze({ shiros: [permissions], ...(subject ? { subject } : {}) }));
    return Object.freeze({ tenant, principal: principal.kind === 'subject' ? principal.subjectId : principal.kind,
      consumer: context.consumer });
  };
};
