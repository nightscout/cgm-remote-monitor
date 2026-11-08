'use strict';

const { randomBytes, createHash } = require('node:crypto');
const shiro = require('shiro-trie');
const PURPOSES = ['data', 'management'];
const fail = code => Object.assign(new Error(code), { code });
const digest = token => createHash('sha256').update(token).digest('hex');
const named = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function identityValid (identity, time) {
  return identity && typeof identity.issuer === 'string' && identity.issuer.length > 0 && identity.issuer.length <= 2048 &&
    typeof identity.subject === 'string' && identity.subject.length > 0 && identity.subject.length <= 512 &&
    Number.isSafeInteger(identity.authenticatedAt) && identity.authenticatedAt >= 0 && identity.authenticatedAt <= time &&
    (identity.providerSession === undefined || identity.providerSession === null ||
      typeof identity.providerSession === 'string' && identity.providerSession.length > 0 && identity.providerSession.length <= 512);
}

function tokenHash (token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 8192) throw fail('HUMAN_SESSION_REFUSED');
  return digest(token);
}

function publicSession (session) {
  const { id, tenant, subject, purpose, authenticatedAt, absoluteExpiresAt, idleExpiresAt,
    providerSession, issuer, providerSubject } = session;
  return Object.freeze({ id, tenant, subject, purpose, authenticatedAt, absoluteExpiresAt,
    idleExpiresAt, providerSession, issuer, providerSubject });
}

function createEngine ({ store, access, now = () => Math.floor(Date.now() / 1000) }) {
  if (!store || typeof store.transaction !== 'function' || !access ||
      ['keyId', 'issue', 'verify'].some(method => typeof access[method] !== 'function') || typeof now !== 'function') {
    throw new TypeError('Human sessions require asymmetric access issuance/verification, durable fenced persistence and a clock');
  }
  function time () {
    const result = now();
    if (!Number.isSafeInteger(result) || result < 0) throw fail('HUMAN_SESSION_UNAVAILABLE');
    return result;
  }
  function authority (tx, purpose, session) {
    const actor = tx.authority;
    if (!actor || actor.active !== true || actor.keyActive !== true || !named(actor.subject) || !named(actor.consumer) ||
        !Array.isArray(actor.purposes) || !actor.purposes.includes(purpose) ||
        !Number.isSafeInteger(actor.generation) || actor.generation < 1 ||
        !Number.isSafeInteger(actor.credentialGeneration) || actor.credentialGeneration < 1 ||
        !Array.isArray(actor.permissionGroups) || actor.permissionGroups.length > 256 ||
        actor.permissionGroups.some(group => !Array.isArray(group) || group.length > 256 ||
          group.some(permission => typeof permission !== 'string' || !permission || permission.length > 512 ||
            permission.split('').some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)))) {
      throw fail('HUMAN_AUTHORITY_REFUSED');
    }
    if (session && (session.subject !== actor.subject || session.authorityGeneration !== actor.generation ||
        session.credentialGeneration !== actor.credentialGeneration)) throw fail('HUMAN_AUTHORITY_REFUSED');
    const tries = actor.permissionGroups.map(group => { const trie = shiro.new(); trie.add(group); return trie; });
    return Object.freeze({ principal: actor.subject, subject: actor.subject, consumer: actor.consumer,
      permissionGroups: Object.freeze(actor.permissionGroups.map(group => Object.freeze(group.slice()))),
      allows: permission => tries.some(trie => trie.check(permission)) });
  }
  function bound (tx, claims, tenant) {
    const session = tx.session;
    if (!session || !tx.token || claims.tid !== tenant || session.tenant !== tenant ||
        claims.sid !== session.id || claims.sub !== session.subject || claims.purpose !== session.purpose ||
        claims.cv !== session.credentialGeneration || claims.kid !== tx.token.kid ||
        claims.exp !== tx.token.expiresAt || claims.iat !== tx.token.issuedAt) throw fail('HUMAN_SESSION_REFUSED');
    return session;
  }
  function live (tx, claims, tenant, at, { purpose, access: strictAccess = true, sensitive = false } = {}) {
    bound(tx, claims, tenant);
    const session = tx.session;
    if (!session || session.tenant !== tenant || session.active !== true || !tx.token ||
        !named(session.id) || !named(session.subject) || !PURPOSES.includes(session.purpose) ||
        !identityValid({ issuer: session.issuer, subject: session.providerSubject,
          authenticatedAt: session.authenticatedAt, providerSession: session.providerSession }, at) ||
        !Number.isSafeInteger(session.createdAt) || session.createdAt < session.authenticatedAt || session.createdAt > at ||
        !Number.isSafeInteger(tx.token.expiresAt) ||
        session.purpose === 'data' && (session.idleExpiresAt !== null || session.absoluteExpiresAt !== null) ||
        session.purpose === 'management' && (!Number.isSafeInteger(session.idleExpiresAt) ||
          !Number.isSafeInteger(session.absoluteExpiresAt) || session.absoluteExpiresAt > session.createdAt + 43200 ||
          session.absoluteExpiresAt <= session.createdAt || session.idleExpiresAt > session.absoluteExpiresAt) ||
        purpose && session.purpose !== purpose ||
        strictAccess && (claims.lookupOnly === true || tx.token.expiresAt <= at) ||
        session.purpose === 'management' && (session.idleExpiresAt <= at || session.absoluteExpiresAt <= at)) {
      throw fail('HUMAN_SESSION_REFUSED');
    }
    const actor = authority(tx, session.purpose, session);
    if (sensitive && session.authenticatedAt + 300 <= at) throw fail('HUMAN_REAUTH_REQUIRED');
    return { session, actor };
  }
  async function issue (tx, session, at, kid) {
    const expiresAt = Math.min(at + (session.purpose === 'management' ? 600 : 28800),
      session.absoluteExpiresAt === null ? Infinity : session.absoluteExpiresAt);
    const token = await access.issue({ tenant: session.tenant, subject: session.subject, session: session.id,
      purpose: session.purpose, credentialVersion: session.credentialGeneration, issuedAt: at, expiresAt });
    const claims = await access.verify({ tenant: session.tenant, token });
    if (claims.lookupOnly || claims.tid !== session.tenant || claims.sub !== session.subject || claims.sid !== session.id ||
        claims.purpose !== session.purpose || claims.cv !== session.credentialGeneration || claims.kid !== kid ||
        claims.iat !== at || claims.exp !== expiresAt) throw fail('HUMAN_SESSION_UNAVAILABLE');
    await tx.save(session, { hash: digest(token), kid, expiresAt, issuedAt: at });
    return Object.freeze({ token, session: publicSession(session), expiresAt });
  }
  return Object.freeze({
    accepts (token) { return typeof access.accepts === 'function' && access.accepts(token); },
    async login ({ tenant, identity, purpose }) {
      if (!PURPOSES.includes(purpose) || !identityValid(identity, time())) throw fail('HUMAN_SESSION_REFUSED');
      const kid = await access.keyId({ tenant, purpose });
      return store.transaction({ tenant, identity, purpose, keyIds: [{ kid, purpose }] }, async tx => {
        const at = time(), actor = authority(tx, purpose);
        if (!identityValid(identity, at)) throw fail('HUMAN_SESSION_REFUSED');
        const session = { id: randomBytes(24).toString('base64url'), tenant, subject: actor.subject, purpose,
          issuer: identity.issuer, providerSubject: identity.subject, providerSession: identity.providerSession || null,
          authenticatedAt: identity.authenticatedAt, createdAt: at,
          absoluteExpiresAt: purpose === 'management' ? at + 43200 : null,
          idleExpiresAt: purpose === 'management' ? at + 1800 : null,
          active: true, authorityGeneration: tx.authority.generation,
          credentialGeneration: tx.authority.credentialGeneration };
        return issue(tx, session, at, kid);
      });
    },
    async renew ({ tenant, token, identity }) {
      if (!identityValid(identity, time())) throw fail('HUMAN_SESSION_REFUSED');
      const claims = await access.verify({ tenant, token, allowExpiredLookup: true });
      const kid = await access.keyId({ tenant, purpose: claims.purpose });
      return store.transaction({ tenant, tokenHash: tokenHash(token), claims,
        keyIds: [{ kid: claims.kid, purpose: claims.purpose }, { kid, purpose: claims.purpose }] }, async tx => {
        const at = time(), { session } = live(tx, claims, tenant, at, { access: false });
        if (identity.issuer !== session.issuer || identity.subject !== session.providerSubject ||
            session.providerSession !== null && identity.providerSession !== session.providerSession) throw fail('HUMAN_SESSION_REFUSED');
        // A fresh provider proof is required by the caller; it identifies this
        // existing session and never rewrites its authentication/absolute clock.
        return issue(tx, session, at, kid);
      });
    },
    async authenticate ({ tenant, token, purpose, activity = false, sensitive = false }) {
      if (!PURPOSES.includes(purpose) || typeof activity !== 'boolean' || typeof sensitive !== 'boolean') {
        throw fail('HUMAN_SESSION_REFUSED');
      }
      const claims = await access.verify({ tenant, token });
      return store.transaction({ tenant, tokenHash: tokenHash(token), claims,
        keyIds: [{ kid: claims.kid, purpose: claims.purpose }] }, async tx => {
        const at = time(), { session, actor } = live(tx, claims, tenant, at, { purpose, sensitive });
        if (activity && purpose === 'management') {
          session.idleExpiresAt = Math.min(at + 1800, session.absoluteExpiresAt);
          await tx.save(session);
        }
        return Object.freeze({ session: publicSession(session), actor: Object.freeze({ ...actor, tenant }),
          expiresAt: tx.token.expiresAt });
      });
    },
    async logout ({ tenant, token }) {
      const claims = await access.verify({ tenant, token, allowExpiredLookup: true });
      return store.transaction({ tenant, tokenHash: tokenHash(token), claims, keyIds: [] }, async tx => {
        // Expiry or a removed grant never prevents local invalidation. The hash
        // still has to identify the session; unrelated sessions are untouched.
        if (tx.session && tx.session.tenant === tenant && tx.token) { bound(tx, claims, tenant); await tx.revoke(); }
        return Object.freeze({ revoked: true });
      });
    },
    async logoutProvider ({ tenant, event }) {
      if (!event || typeof event.issuer !== 'string' || !event.issuer || event.issuer.length > 2048 ||
          typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 512 ||
          !Number.isSafeInteger(event.issuedAt) || event.issuedAt < 0 || event.issuedAt > time() ||
          !event.subject && !event.providerSession ||
          [event.subject, event.providerSession].some(value => value !== undefined && value !== null &&
            (typeof value !== 'string' || !value || value.length > 512))) throw fail('HUMAN_SESSION_REFUSED');
      if (typeof store.revokeProvider !== 'function') throw fail('HUMAN_PROVIDER_LOGOUT_UNSUPPORTED');
      // Only the configured provider adapter supplies verified logout events.
      return store.revokeProvider({ tenant, ...event });
    }
  });
}

module.exports = { createEngine, tokenHash };
