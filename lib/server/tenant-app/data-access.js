'use strict';

const shiro = require('shiro-trie');
const authorityPrincipal = require('../../tenant-authorization/authority-principal');
const authentication = require('../../api3/tenant-authentication');
const extract = require('../../authorization/credential-extraction');

// Only the private preview composition registers a raw-domain materializer.
// Neither transport fields nor credentials select a transaction capability.
const rawReads = new WeakMap();

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
  collections = ['entries'], legacyCollections = [], safeRoutes = {}, strictSettingsRead = false, derivedReads = false, humanSessions, readConnection }) {
  if (!secrets || typeof secrets.verifyLegacyCredential !== 'function' ||
      !authority || typeof authority.authorize !== 'function' || typeof verifierContext !== 'function') {
    throw new TypeError('Data access requires secrets, current authority and trusted verifier identity');
  }
  if (readConnection !== undefined && (typeof readConnection?.withTenant !== 'function' ||
      typeof authority.subjectAuthorizationSnapshot !== 'function' ||
      typeof authority.usesConnection !== 'function' || !authority.usesConnection(readConnection))) {
    throw new TypeError('Raw read and current authority must own the same connection');
  }
  // Local verifier material and current authority read through one physical
  // tenant transaction when both stores declare the request connection. Each
  // statement still reads current committed state; nothing is retained.
  const fusedVerification = readConnection !== undefined && typeof secrets.usesConnection === 'function' &&
    secrets.usesConnection(readConnection) === true;
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
    let legacySubject = false;
    const registered = rawReads.get(request);
    const joinedRead = readConnection && registered && registered.tenant === tenant &&
      registered.connection.query === readConnection.query &&
      registered.connection.withTenant === readConnection.withTenant &&
      [1, 2].includes(version) && ['GET', 'HEAD'].includes(request.method) &&
      selected.logical === registered.logical && !selected.actions.length &&
      selected.reads.length === 1 && selected.reads[0] === registered.logical;
    // Fused requests report a transaction failure outside the body with the
    // code its last reader reported when each reader owned its transaction.
    let reader = 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE';
    const authorityRead = () => { reader = 'TENANT_AUTHORITY_UNAVAILABLE'; };
    const humanPath = !!(human && (human.cookie || humanSessions.accepts(human.token)));
    const fused = fusedVerification && credentials.presented && !humanPath;
    async function authenticate () {
      if (humanPath) {
        if (credentials.apiSecret || credentials.tokenCarrier === 'legacy') return null;
        const { actor } = await humanSessions.authenticate({ tenant, credential: human.token, request, purpose: 'data' });
        principal = { kind: 'subject', subjectId: actor.subject };
        currentAuthority = {
          authorize: async ({ permission }) => actor.allows(permission),
          subjectSnapshot: async () => ({ sub: actor.subject, permissionGroups: actor.permissionGroups })
        };
      } else if (credentials.tokenCarrier === 'legacy' && !credentials.apiSecret) {
        // Authenticate this request directly; token issuance belongs to exchange.
        // Keep current subject membership and the fresh permission snapshot below.
        principal = authorityPrincipal(await secrets.verifyLegacyCredential(context, { token, apiSecret: token }));
        if (!principal || principal.kind !== 'subject') return false;
        legacySubject = true;
        if (!joinedRead) {
          authorityRead();
          if (typeof authority.subjectAuthorizationSnapshot === 'function') {
            const snapshot = await authority.subjectAuthorizationSnapshot({ tenant, principal });
            if (!snapshot) return false;
            currentAuthority = { authorize: async ({ permission }) => snapshot.allows(permission),
              subjectSnapshot: async () => snapshot.subject };
          } else if (await authority.subjectSnapshot({ tenant, principal }) === null) return false;
        }
      } else {
        // DATA authenticates credentials; only the explicit exchange endpoint
        // issues a JWT. Mixed legacy carriers still require a current named token
        // subject before api-secret root precedence, as the exchange path did.
        // The current snapshot is retained only for this operation.
        const acceptLegacySubject = credentials.tokenCarrier === 'legacy' ? async verified => {
          const candidate = authorityPrincipal(verified);
          authorityRead();
          if (typeof authority.subjectAuthorizationSnapshot === 'function') {
            const snapshot = await authority.subjectAuthorizationSnapshot({ tenant, principal: candidate });
            if (!snapshot) return false;
            currentAuthority = { authorize: async ({ permission }) => snapshot.allows(permission),
              subjectSnapshot: async () => snapshot.subject };
            return true;
          }
          const snapshot = await authority.subjectSnapshot({ tenant, principal: candidate });
          if (snapshot === null) return false;
          currentAuthority = { authorize: operation => authority.authorize(operation),
            subjectSnapshot: async () => snapshot };
          return true;
        } : undefined;
        principal = authorityPrincipal(await secrets.verifyLegacyCredential(context, {
          apiSecret: credentials.apiSecret, token
        }, acceptLegacySubject));
        // A valid mixed token does not restrict a separately verified root.
        if (principal?.kind === 'root') currentAuthority = authority;
      }
      return !(!principal || (credentials.presented && principal.kind === 'anonymous'));
    }
    async function authorize () {
      if (currentAuthority === authority) authorityRead();
      if (joinedRead && legacySubject && currentAuthority === authority) {
        const snapshot = await authority.subjectAuthorizationSnapshot({ tenant, principal });
        if (!snapshot) return null;
        currentAuthority = { authorize: async ({ permission }) => snapshot.allows(permission),
          subjectSnapshot: async () => snapshot.subject };
      }
      // Named subject writes need permissions and attribution from one coherent
      // current read. Invalid/unnamed legacy states retain the existing fallback
      // ordering of permission refusal and missing attribution.
      if (currentAuthority === authority && principal.kind === 'subject' && selected.actions.length &&
          typeof authority.subjectAuthorizationSnapshot === 'function') {
        const snapshot = await authority.subjectAuthorizationSnapshot({ tenant, principal });
        if (snapshot) currentAuthority = { authorize: async ({ permission }) => snapshot.allows(permission),
          subjectSnapshot: async () => snapshot.subject };
      }
      if (currentAuthority === authority && typeof authority.permissionSnapshot === 'function') {
        const snapshot = await authority.permissionSnapshot({ tenant, principal });
        currentAuthority = {
          authorize: async ({ permission }) => snapshot.allows(permission),
          subjectSnapshot: operation => authority.subjectSnapshot(operation)
        };
      }
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
      return { shiros: [permissions], defaults: principal.kind === 'anonymous', ...(subject ? { subject } : {}) };
    }
    // `transaction` is true inside the fused tenant transaction; nested
    // withTenant calls on the same connection join it rather than opening one.
    async function decide (transaction) {
      if (!await authenticate()) return null;
      if (joinedRead && currentAuthority === authority) {
        return (transaction ? fn => fn() : fn => readConnection.withTenant(tenant, fn))(async () => {
          const allowed = await authorize();
          if (!allowed) return null;
          // The current actor is admitted before clinical SQL. Both use the same
          // physical transaction; no HTTP handler or write boundary runs here.
          reader = null;
          const frame = await registered.load();
          return { binding: allowed, frame, joined: true };
        });
      }
      const binding = await authorize();
      return binding ? { binding } : null;
    }
    let result;
    if (fused) {
      let entered = false, bodyFailure;
      try {
        result = await readConnection.withTenant(tenant, async () => {
          entered = true;
          try { return await decide(true); } catch (error) { bodyFailure = error; throw error; }
        });
      } catch (error) {
        if (bodyFailure !== undefined || reader === null) throw bodyFailure !== undefined ? bodyFailure : error;
        // Window/lock refusal before the body, or a COMMIT/release failure after
        // it, keeps the code of the reader whose own transaction it was.
        const reported = failure(entered ? reader : 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE');
        reported.cause = error;
        throw reported;
      }
    } else result = await decide(false);
    if (!result) return null;
    // Nothing is bound/published until the physical transaction commits.
    if (result.joined) registered.publish(result.frame);
    const binding = result.binding;
    authentication.bind(request, Object.freeze(binding));
    return Object.freeze({ tenant, principal: principal.kind === 'subject' ? principal.subjectId : principal.kind,
      consumer: context.consumer });
  }
  return Object.assign(require('../../diagnostics/m7').wrapAsync(dataAccess, 'api.authorize'), { admit });
};

// Internal registration is separate from the request's parser-visible fields.
module.exports.registerRawRead = function registerRawRead (request, operation) {
  if (!request || !operation || typeof operation.tenant !== 'string' ||
      !['entries', 'treatments', 'devicestatus'].includes(operation.logical) || !operation.connection ||
      ['query', 'withTenant'].some(key => typeof operation.connection[key] !== 'function') ||
      ['load', 'publish'].some(key => typeof operation[key] !== 'function') || rawReads.has(request)) {
    throw new TypeError('One private raw read registration required');
  }
  rawReads.set(request, Object.freeze({ ...operation }));
};
