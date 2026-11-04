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
    // Keep list and addressed reads explicit; history is a reserved API3 route,
    // not an identifier. No mutation permission is inferred from an HTTP verb.
    const list = typeof request.path === 'string' && /^\/entries\/?$/.test(request.path);
    if (request.method !== 'GET' || (!list && !addressedEntriesPath(request.path))) {
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
    const permission = 'api:entries:read';
    if (await authority.authorize({ tenant, principal, permission }) !== true) {
      throw failure('TENANT_DATA_FORBIDDEN');
    }
    const permissions = shiro.new();
    permissions.add(permission);
    const subject = principal.kind === 'subject' ? { _id: principal.subjectId } : undefined;
    authentication.bind(request, Object.freeze({ shiros: [permissions], ...(subject ? { subject } : {}) }));
    return Object.freeze({ tenant, principal: principal.kind === 'subject' ? principal.subjectId : principal.kind,
      consumer: context.consumer });
  };
};
