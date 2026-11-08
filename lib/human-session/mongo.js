'use strict';

const { createHash } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 128, MAX_TOKENS = 128, MAX_PRINCIPALS = 64, MAX_EVENTS = 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const authorityId = tenant => hash(['single-site-human-authority-v1', tenant]);
const principalId = (tenant, issuer, subject) => hash([tenant, issuer, subject]);
const pair = key => key.kid + ':' + key.purpose;

// One private single-site authority document owns global accepted-key state,
// explicit human principals/grants and sessions. This is separate from clinical
// storage's SINGLE_TENANT scope. No multi-document transaction is required.
function createMongoStore ({ collection, tenant, consumer }) {
  if (!collection || ['findOne', 'findOneAndReplace'].some(method => typeof collection[method] !== 'function') ||
      tenant !== 'single' ||
      typeof consumer !== 'string' || !NAME.test(consumer)) {
    throw new TypeError('Human authority requires the fixed private single binding and a trusted consumer');
  }
  function validate (document) {
    if (!document || document._id !== authorityId(tenant) || document.tenant !== tenant ||
        !Number.isSafeInteger(document.revision) || document.revision < 1 ||
        !Array.isArray(document.keys) || document.keys.length > 128 ||
        document.keys.some(key => !key || !NAME.test(key.kid) || !['data', 'management'].includes(key.purpose) || typeof key.active !== 'boolean') ||
        new Set(document.keys.map(pair)).size !== document.keys.length ||
        !Array.isArray(document.principals) || document.principals.length > MAX_PRINCIPALS ||
        document.principals.some(principal => !principal || principal.id !== principalId(tenant, principal.issuer, principal.providerSubject) ||
          !NAME.test(principal.subject) || !NAME.test(principal.consumer) || typeof principal.enabled !== 'boolean' ||
          !Number.isSafeInteger(principal.generation) || principal.generation < 1 ||
          !Number.isSafeInteger(principal.credentialGeneration) || principal.credentialGeneration < 1 ||
          !Array.isArray(principal.purposes) || principal.purposes.some(purpose => !['data', 'management'].includes(purpose)) ||
          !Array.isArray(principal.permissionGroups)) ||
        new Set(document.principals.map(principal => principal.id)).size !== document.principals.length ||
        !Array.isArray(document.sessions) || document.sessions.length > MAX_SESSIONS ||
        document.sessions.some(session => !session || !Array.isArray(session.tokens) || session.tokens.length > MAX_TOKENS ||
          session.tokens.some(token => !HASH.test(token.hash) || !NAME.test(token.kid) ||
            !Number.isSafeInteger(token.expiresAt) || !Number.isSafeInteger(token.issuedAt))) ||
        !Array.isArray(document.logoutEvents) || document.logoutEvents.length > MAX_EVENTS ||
        Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES) throw fail('HUMAN_SESSION_UNAVAILABLE');
  }
  const filter = document => ({ _id: document._id, tenant: document.tenant, revision: document.revision,
    keys: document.keys, principals: document.principals, sessions: document.sessions, logoutEvents: document.logoutEvents });
  const replacement = (document, next) => collection.findOneAndReplace(filter(document), next,
    { returnDocument: 'after', includeResultMetadata: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 1000 } });
  const read = () => collection.findOne({ _id: authorityId(tenant), tenant },
    { readPreference: 'primary', readConcern: { level: 'majority' } });
  return Object.freeze({
    async transaction (request, work) {
      if (!request || request.tenant !== tenant || typeof work !== 'function' ||
          !Array.isArray(request.keyIds) || request.keyIds.length > 2 || request.keyIds.some(key => !key ||
            !NAME.test(key.kid) || !['data', 'management'].includes(key.purpose))) throw fail('HUMAN_SESSION_REFUSED');
      if (!request.identity && !HASH.test(request.tokenHash)) throw fail('HUMAN_SESSION_REFUSED');
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const document = await read();
          if (!document) return work({ session: null, token: null, authority: null });
          validate(document);
          const next = clone(document);
          let selected = request.tokenHash && next.sessions.find(session => session.tokens.some(token => token.hash === request.tokenHash));
          const savedToken = selected && selected.tokens.find(token => token.hash === request.tokenHash);
          const identity = request.identity || selected && { issuer: selected.issuer, subject: selected.providerSubject };
          const principal = identity && next.principals.find(value => value.id === principalId(tenant, identity.issuer, identity.subject));
          const session = selected ? clone(selected) : null;
          if (session) delete session.tokens;
          const tx = {
            session, token: savedToken ? { ...savedToken } : null,
            authority: principal ? { active: principal.enabled && principal.consumer === consumer,
              subject: principal.subject, consumer: principal.consumer, purposes: principal.purposes,
              permissionGroups: principal.permissionGroups, generation: principal.generation,
              credentialGeneration: principal.credentialGeneration,
              keyActive: request.keyIds.every(required => next.keys.some(key => key.kid === required.kid && key.purpose === required.purpose && key.active)) } : null,
            async save (value, token) {
              if (!principal || value.tenant !== tenant || value.subject !== principal.subject) throw fail('HUMAN_SESSION_REFUSED');
              if (token) next.sessions = next.sessions.filter(existing => existing.active &&
                (existing.purpose !== 'management' || existing.idleExpiresAt > token.issuedAt && existing.absoluteExpiresAt > token.issuedAt));
              const index = next.sessions.findIndex(existing => existing.id === value.id);
              const tokens = index === -1 ? [] : next.sessions[index].tokens.slice();
              if (token) {
                const known = tokens.find(existing => existing.hash === token.hash);
                if (known && (known.kid !== token.kid || known.expiresAt !== token.expiresAt || known.issuedAt !== token.issuedAt)) throw fail('HUMAN_SESSION_REFUSED');
                if (!known) {
                  if (tokens.length >= MAX_TOKENS) throw fail('HUMAN_SESSION_CAPACITY');
                  tokens.push(token);
                }
              }
              const stored = { ...clone(value), principalId: principal.id, tokens };
              if (index === -1) {
                if (next.sessions.length >= MAX_SESSIONS || next.sessions.filter(existing => existing.principalId === principal.id).length >= 32) throw fail('HUMAN_SESSION_CAPACITY');
                next.sessions.push(stored);
              } else next.sessions[index] = stored;
              selected = stored;
            },
            async revoke () { if (selected) selected.active = false; }
          };
          const outcome = await work(tx);
          next.revision++;
          if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('HUMAN_SESSION_CAPACITY');
          // Read-only access also commits this CAS: every accepted result must
          // still match the global key/grant/session authority it consumed.
          if (await replacement(document, next)) return outcome;
        }
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('HUMAN_')) throw error;
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      }
    },
    async revokeProvider ({ tenant: requestedTenant, issuer, eventId, issuedAt, providerSession, subject }) {
      if (requestedTenant !== tenant) throw fail('HUMAN_SESSION_REFUSED');
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const document = await read();
          if (!document) return Object.freeze({ revoked: 0, replayed: false });
          validate(document);
          if (document.logoutEvents.some(event => event.issuer === issuer && event.eventId === eventId)) return Object.freeze({ revoked: 0, replayed: true });
          if (document.logoutEvents.length >= MAX_EVENTS) throw fail('HUMAN_SESSION_CAPACITY');
          const next = clone(document);
          let revoked = 0;
          for (const session of next.sessions) {
            if (session.issuer === issuer && (!subject || session.providerSubject === subject) &&
                (!providerSession || session.providerSession === providerSession) && session.createdAt <= issuedAt && session.active) {
              session.active = false; revoked++;
            }
          }
          next.logoutEvents.push({ issuer, eventId, issuedAt });
          next.revision++;
          if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw fail('HUMAN_SESSION_CAPACITY');
          if (await replacement(document, next)) return Object.freeze({ revoked, replayed: false });
        }
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('HUMAN_')) throw error;
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      }
    }
  });
}

module.exports = { createMongoStore, authorityId, principalId, MAX_SESSIONS, MAX_TOKENS, MAX_PRINCIPALS, MAX_EVENTS, MAX_BYTES };
