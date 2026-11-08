'use strict';

const { createHash } = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 32;
const MAX_TOKENS = 128;

function principalId (tenant, issuer, subject) {
  return createHash('sha256').update(JSON.stringify([tenant, issuer, subject])).digest('hex');
}

// One document owns the opted-in human's mapping, grants and sessions. These
// are explicit human grants, never a cached copy of legacy Mongo subject roles.
// A primary atomic compare-and-swap fences all three without requiring Mongo
// multi-document transactions or changing the supported standalone deployment.
function createMongoStore ({ collection, tenant, consumer }) {
  if (!collection || ['findOne', 'findOneAndReplace'].some(method => typeof collection[method] !== 'function') ||
      typeof tenant !== 'string' || !tenant || typeof consumer !== 'string' || !NAME.test(consumer)) {
    throw new TypeError('Single human sessions require a collection, fixed tenant and consumer');
  }
  function validate (document) {
    if (!document || !HASH.test(document._id) || document.tenant !== tenant ||
        document._id !== principalId(tenant, document.issuer, document.providerSubject) ||
        !NAME.test(document.subject) || !Number.isSafeInteger(document.revision) || document.revision < 1 ||
        !Number.isSafeInteger(document.generation) || document.generation < 1 || typeof document.enabled !== 'boolean' ||
        document.consumer !== consumer || !Array.isArray(document.purposes) ||
        document.purposes.some(purpose => !['data', 'management'].includes(purpose)) ||
        !Array.isArray(document.permissionGroups) || !Array.isArray(document.sessions) || document.sessions.length > MAX_SESSIONS ||
        document.logoutEvents !== undefined && (!Array.isArray(document.logoutEvents) || document.logoutEvents.length > 256) ||
        document.sessions.some(session => !session || !Array.isArray(session.tokens) || session.tokens.length > MAX_TOKENS ||
          session.tokens.some(token => !HASH.test(token.hash) || !Number.isSafeInteger(token.expiresAt)))) {
      throw fail('HUMAN_SESSION_UNAVAILABLE');
    }
  }
  return Object.freeze({
    async transaction (request, work) {
      if (!request || request.tenant !== tenant || typeof work !== 'function') throw fail('HUMAN_SESSION_REFUSED');
      const query = request.identity
        ? { _id: principalId(tenant, request.identity.issuer, request.identity.subject), tenant }
        : { tenant, 'sessions.tokens.hash': request.tokenHash };
      if (!request.identity && !HASH.test(request.tokenHash)) throw fail('HUMAN_SESSION_REFUSED');
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const document = await collection.findOne(query, { readPreference: 'primary', readConcern: { level: 'majority' } });
          if (!document) return work({ session: null, token: null, authority: null });
          validate(document);
          const next = clone(document);
          let selected = request.tokenHash && next.sessions.find(session => session.tokens.some(token => token.hash === request.tokenHash));
          const savedToken = selected && selected.tokens.find(token => token.hash === request.tokenHash);
          const session = selected ? clone(selected) : null;
          if (session) delete session.tokens;
          let dirty = false;
          const tx = {
            session, token: savedToken ? { ...savedToken } : null,
            authority: { active: next.enabled, subject: next.subject, consumer: next.consumer,
              purposes: next.purposes, permissionGroups: next.permissionGroups, generation: next.generation },
            async save (value, token) {
              if (value.tenant !== tenant || value.subject !== next.subject) throw fail('HUMAN_SESSION_REFUSED');
              if (token) {
                // Discard only definitively dead sessions. Live concurrent
                // renewals keep every issued token valid through its expiry.
                next.sessions = next.sessions.filter(existing => existing.active &&
                  (existing.purpose !== 'management' || existing.idleExpiresAt > token.issuedAt && existing.absoluteExpiresAt > token.issuedAt));
              }
              const index = next.sessions.findIndex(existing => existing.id === value.id);
              const tokens = index === -1 ? [] : next.sessions[index].tokens.slice();
              if (token) {
                if (tokens.length >= MAX_TOKENS) throw fail('HUMAN_SESSION_CAPACITY');
                tokens.push(token);
              }
              const stored = { ...clone(value), tokens };
              if (index === -1) {
                if (next.sessions.length >= MAX_SESSIONS) throw fail('HUMAN_SESSION_CAPACITY');
                next.sessions.push(stored);
              } else next.sessions[index] = stored;
              selected = stored;
              dirty = true;
            },
            async revoke () {
              if (!selected) return;
              selected.active = false;
              dirty = true;
            }
          };
          const outcome = await work(tx);
          // Even read-only authorization commits a revision CAS. Therefore the
          // exact grants/session read must still be current at its linearization
          // point; a concurrent logout or grant edit causes a fresh evaluation.
          next.revision++;
          const filter = { _id: document._id, revision: document.revision,
            generation: document.generation, enabled: document.enabled, subject: document.subject,
            consumer: document.consumer, purposes: document.purposes, permissionGroups: document.permissionGroups,
            sessions: document.sessions };
          const changed = await collection.findOneAndReplace(filter, dirty ? next : { ...document, revision: next.revision },
            { returnDocument: 'after', includeResultMetadata: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 1000 } });
          if (changed) return outcome;
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
          let document;
          if (subject) document = await collection.findOne({ _id: principalId(tenant, issuer, subject), tenant },
            { readPreference: 'primary', readConcern: { level: 'majority' } });
          else {
            if (typeof collection.find !== 'function') throw fail('HUMAN_PROVIDER_LOGOUT_UNSUPPORTED');
            const matches = await collection.find({ tenant, issuer, 'sessions.providerSession': providerSession },
              { readPreference: 'primary', readConcern: { level: 'majority' } }).limit(2).toArray();
            if (matches.length > 1) throw fail('HUMAN_PROVIDER_LOGOUT_UNSUPPORTED');
            document = matches[0];
          }
          if (!document) return Object.freeze({ revoked: 0, replayed: false });
          validate(document);
          const events = document.logoutEvents || [];
          if (events.some(event => event.eventId === eventId)) return Object.freeze({ revoked: 0, replayed: true });
          if (events.length >= 256) throw fail('HUMAN_SESSION_CAPACITY');
          const next = clone(document);
          let revoked = 0;
          for (const session of next.sessions) {
            if (session.issuer === issuer && (!subject || session.providerSubject === subject) &&
                (!providerSession || session.providerSession === providerSession) && session.createdAt <= issuedAt && session.active) {
              session.active = false;
              revoked++;
            }
          }
          next.logoutEvents = events.concat({ eventId, issuedAt });
          next.revision++;
          const changed = await collection.findOneAndReplace({ _id: document._id, revision: document.revision,
            generation: document.generation, enabled: document.enabled, subject: document.subject,
            consumer: document.consumer, purposes: document.purposes, permissionGroups: document.permissionGroups,
            sessions: document.sessions, ...(document.logoutEvents === undefined ? { logoutEvents: { $exists: false } } : { logoutEvents: document.logoutEvents }) },
          next, { returnDocument: 'after', includeResultMetadata: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 1000 } });
          if (changed) return Object.freeze({ revoked, replayed: false });
        }
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      } catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('HUMAN_')) throw error;
        throw fail('HUMAN_SESSION_UNAVAILABLE');
      }
    }
  });
}

module.exports = { createMongoStore, principalId, MAX_SESSIONS, MAX_TOKENS };
