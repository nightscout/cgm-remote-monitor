'use strict';

const { createHash } = require('node:crypto');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const hash = (value, algorithm = 'sha256') => createHash(algorithm).update(value).digest('hex');
const fingerprint = (kind, value) => hash('nightscout-legacy-verifier-v1:' + kind + ':' + value);

// Preparation/management only. Returned values cannot be presented as credentials.
// Hash every supported prefix instead of storing a usable legacy bearer digest.
function prepare (root, subjects) {
  if (!Buffer.isBuffer(root) || root.toString('utf8').length < 12 || !root.equals(Buffer.from(root.toString('utf8'))) ||
      !Array.isArray(subjects) || subjects.some(s => !s || (typeof s.subjectId !== 'string' || !NAME.test(s.subjectId)) ||
        typeof s.tokenPrefix !== 'string' || !/^[a-z0-9_]{0,10}$/.test(s.tokenPrefix))) throw new TypeError('Trusted root and subject metadata required');
  const sha1 = hash(root, 'sha1');
  return Object.freeze({ rootVerifiers: Object.freeze([fingerprint('root', sha1), fingerprint('root', hash(root, 'sha512'))]),
    subjects: Object.freeze(subjects.map(subject => {
      const digest = hash(sha1 + subject.subjectId, 'sha1');
      const tokenDigest = hash(subject.tokenPrefix + '-' + digest.slice(0, 16), 'sha1');
      const verifiers = [];
      for (let length = 16; length <= 40; length++) {
        verifiers.push(fingerprint('digest', digest.slice(0, length)), fingerprint('token', tokenDigest.slice(0, length)));
      }
      return Object.freeze({ subjectId: subject.subjectId, verifiers: Object.freeze(verifiers) });
    })) });
}

// The shipping subject access token for a root secret and a subject, as
// secrets.rootLegacyTokens derives it. Provisioning returns it once; it is
// never stored. prepare() above stores only its verifiers.
function subjectToken (root, subject) {
  prepare(root, [subject]);
  return subject.tokenPrefix + '-' + hash(hash(root, 'sha1') + subject.subjectId, 'sha1').slice(0, 16);
}

// What one presented credential can match: the fingerprints its strings hash
// to and the subject a data token names. The name is read before the token is
// verified and only narrows the read; verification still decides.
function selectorFor ({ apiSecret, token, subjectId } = {}) {
  const fingerprints = new Set();
  for (const credential of [apiSecret, token]) {
    if (typeof credential !== 'string' || credential.split('-').at(-1).length < 16) continue;
    fingerprints.add(fingerprint('digest', credential.split('-').at(-1)));
    fingerprints.add(fingerprint('token', credential));
  }
  if (subjectId === undefined && typeof token === 'string' && token.includes('.')) {
    try {
      const named = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
      if (typeof named === 'string' && NAME.test(named)) subjectId = named;
    } catch { /* an undecodable token names no subject and fails verification */ }
  }
  return Object.freeze({ fingerprints: Object.freeze([...fingerprints].sort()), ...(subjectId === undefined ? {} : { subjectId }) });
}

function create ({ read, verifyToken, usesConnection }) {
  if (typeof read !== 'function' || typeof verifyToken !== 'function') throw new TypeError('Current verifier store and local JWT codec required');
  if (usesConnection !== undefined && typeof usesConnection !== 'function') throw new TypeError('Verifier store connection predicate must be a function');
  const invalid = () => Object.assign(new Error('SECRETS_LEGACY_AUTHORITY_INVALID'), { code: 'SECRETS_LEGACY_AUTHORITY_INVALID' });
  // memo: the request's reads (lib/server/tenant-app/request-reads.js). The
  // same credential presented twice in one request reads its row once.
  const states = new WeakMap();
  function current (tenant, selector, memo) {
    return require('../server/tenant-app/request-reads').once(memo,
      'verification:' + tenant + ':' + (selector.subjectId || '') + ':' + selector.fingerprints.join(','), () => validated(tenant, selector));
  }
  async function validated (tenant, selector) {
    const state = await read(tenant, selector);
    if (!state || !Array.isArray(state.rootVerifiers) || state.rootVerifiers.length !== 2 ||
        !Number.isSafeInteger(state.rootVersion) || state.rootVersion < 1 || state.previousProfileAllowed !== undefined && typeof state.previousProfileAllowed !== 'boolean' || !Array.isArray(state.subjects) ||
        !Array.isArray(state.keys) || state.subjects.some(s => (typeof s.subjectId !== 'string' || !NAME.test(s.subjectId)) || (s.verifiers !== null && (!Array.isArray(s.verifiers) ||
          s.verifiers.length !== 50)) || !Number.isSafeInteger(s.credentialVersion) || s.credentialVersion < 1) ||
        [...state.rootVerifiers, ...state.subjects.flatMap(s => s.verifiers || [])].some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) throw invalid();
    return state;
  }
  const identified = (state, subject) => {
    const principal = Object.freeze({ kind: 'subject', subjectId: subject.subjectId,
      credentialVersion: subject.credentialVersion, rootVersion: state.rootVersion });
    states.set(principal, state);
    return principal;
  };
  return Object.freeze({
    ...(usesConnection ? { usesConnection: candidate => usesConnection(candidate) === true } : {}),
    acceptsDataToken (token) {
      try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')).typ === require('../tenant-authorization/legacy-data-token').TYPE; } catch { return false; }
    },
    // Used only after the old Vault JWT was verified at the explicit exchange.
    // The stored signing row read with a verified subject's credential, or
    // undefined when that read carried no signing flags.
    signingKey (principal) {
      const keys = states.get(principal)?.keys;
      if (!keys || keys.some(key => typeof key.signing !== 'boolean')) return undefined;
      const signing = keys.filter(key => key.active === true && key.signing === true);
      if (signing.length !== 1) throw Object.assign(new Error('SECRETS_KEY_VERSION'), { code: 'SECRETS_KEY_VERSION' });
      return Object.freeze({ kid: signing[0].kid, publicKey: signing[0].publicKey });
    },
    async currentSubject (tenant, subjectId, { previous = false, rootVersion } = {}) {
      if (typeof subjectId !== 'string' || !NAME.test(subjectId)) return null;
      const state = await current(tenant, selectorFor({ subjectId })), subject = state.subjects.find(s => s.subjectId === subjectId && s.verifiers?.length === 50);
      if (typeof previous !== 'boolean') throw invalid();
      if (previous && (rootVersion !== undefined && rootVersion !== state.rootVersion || state.previousProfileAllowed === false && rootVersion === undefined)) return null;
      return subject ? identified(state, subject) : null;
    },
    async verifyLegacyCredential (context, { apiSecret, token } = {}, acceptLegacySubject, memo) {
      if (acceptLegacySubject !== undefined && typeof acceptLegacySubject !== 'function') throw new TypeError('Current subject callback required');
      if (memo !== undefined && !(memo instanceof Map)) throw new TypeError('Request reads required');
      if (apiSecret === undefined && token === undefined) return Object.freeze({ kind: 'anonymous' });
      if ([apiSecret, token].some(v => v !== undefined && (typeof v !== 'string' || !v || v.length > 8192))) return null;
      const state = await current(context.tenant, selectorFor({ apiSecret, token }), memo);
      const rootMatches = apiSecret && state.rootVerifiers.includes(fingerprint('root', apiSecret.length === 40 ? apiSecret.toLowerCase() : apiSecret));
      if (rootMatches && !acceptLegacySubject) return Object.freeze({ kind: 'root' });
      let jwtSubject;
      if (token && token.includes('.')) {
        let claims;
        try { claims = verifyToken(token, context.tenant, state.keys); }
        catch (error) { if (error.code !== 'SECRETS_TOKEN_INVALID') throw error; }
        if (claims) {
          jwtSubject = state.subjects.find(s => s.subjectId === claims.sub && s.verifiers?.length === 50 && s.credentialVersion === claims.cv && state.rootVersion === claims.rv);
          if (!jwtSubject) return null;
        }
      }
      const match = credential => {
        if (!credential) return [];
        const suffix = credential.split('-').at(-1);
        if (suffix.length < 16) return [];
        const digest = fingerprint('digest', suffix), tokenHash = fingerprint('token', credential);
        return state.subjects.filter(s => (s.verifiers || []).includes(digest) || (s.verifiers || []).includes(tokenHash));
      };
      const tokenSubjects = jwtSubject ? [jwtSubject] : acceptLegacySubject && token && !token.includes('.') ? match(token) : [];
      if (tokenSubjects.length === 1) {
        const principal = identified(state, tokenSubjects[0]);
        if (acceptLegacySubject && await acceptLegacySubject(principal) !== true) return null;
        return rootMatches ? Object.freeze({ kind: 'root' }) : principal;
      }
      if (acceptLegacySubject) return null;
      const subjects = match(apiSecret);
      return subjects.length === 1 ? identified(state, subjects[0]) : null;
    }
  });
}

module.exports = { prepare, subjectToken, create, selectorFor };
