'use strict';

// Actual engine and Ed25519 access in both modes. Single uses the actual Mongo
// aggregate adapter over doubled I/O; multitenant uses the explicitly test-only
// authority store below. No PostgreSQL adapter, native DB or process is claimed.
const { createEngine } = require('../../lib/human-session/engine');
const { createMongoStore, authorityId, principalId } = require('../../lib/human-session/mongo');
const accessFixture = require('./human-access-issuer');
const clone = value => JSON.parse(JSON.stringify(value));

module.exports = function fixture ({ tenant, now = () => Math.floor(Date.now() / 1000) }) {
  const crypto = accessFixture({ tenant, now });
  const identity = { issuer: 'https://provider.synthetic.invalid', subject: 'synthetic-provider-subject',
    authenticatedAt: now(), providerSession: 'synthetic-provider-session' };
  const collection = {
    document: { _id: authorityId(tenant), tenant, revision: 1, keys: clone(crypto.acceptedKeys),
      principals: [{ id: principalId(tenant, identity.issuer, identity.subject), issuer: identity.issuer,
        providerSubject: identity.subject, subject: 'synthetic-human', consumer: 'oidc', enabled: true,
        generation: 1, credentialGeneration: 1, purposes: ['data', 'management'],
        permissionGroups: [['api:*:read', 'notifications:*:ack']] }], sessions: [], logoutEvents: [] },
    async findOne (query) {
      if (this.unavailable) throw new Error('Synthetic authority disconnected');
      return query._id === this.document._id && query.tenant === tenant ? clone(this.document) : null;
    },
    async findOneAndReplace (query, next) {
      if (this.unavailable) throw new Error('Synthetic authority disconnected');
      if (Object.keys(query).some(key => JSON.stringify(query[key]) !== JSON.stringify(this.document[key]))) return null;
      this.document = clone(next);
      return clone(next);
    }
  };
  let fence = Promise.resolve();
  const multitenantTestStore = {
    transaction (request, work) {
      const operation = fence.then(async () => {
        if (request.tenant !== tenant) throw new Error('Test authority tenant mismatch');
        if (collection.unavailable) throw Object.assign(new Error(), { code: 'HUMAN_SESSION_UNAVAILABLE' });
        const next = clone(collection.document);
        let selected = request.tokenHash && next.sessions.find(session => session.tokens.some(token => token.hash === request.tokenHash));
        const token = selected && selected.tokens.find(token => token.hash === request.tokenHash);
        const identity = request.identity || selected && { issuer: selected.issuer, subject: selected.providerSubject };
        const principal = identity && next.principals.find(value => value.issuer === identity.issuer && value.providerSubject === identity.subject);
        const session = selected && clone(selected);
        if (session) delete session.tokens;
        const result = await work({ session: session || null, token: token || null,
          authority: principal ? { active: principal.enabled, subject: principal.subject, consumer: principal.consumer,
            purposes: principal.purposes, permissionGroups: principal.permissionGroups, generation: principal.generation,
            credentialGeneration: principal.credentialGeneration,
            keyActive: request.keyIds.every(required => next.keys.some(key => key.kid === required.kid && key.purpose === required.purpose && key.active)) } : null,
          async save (value, token) {
            const index = next.sessions.findIndex(existing => existing.id === value.id);
            const tokens = index < 0 ? [] : next.sessions[index].tokens.slice();
            if (token && !tokens.some(existing => existing.hash === token.hash)) tokens.push(token);
            selected = { ...clone(value), tokens };
            if (index < 0) next.sessions.push(selected); else next.sessions[index] = selected;
          },
          async revoke () { if (selected) selected.active = false; }
        });
        next.revision++;
        collection.document = next;
        return result;
      });
      fence = operation.catch(() => {});
      return operation;
    }
  };
  const worker = () => createEngine({ store: tenant === 'single'
    ? createMongoStore({ collection, tenant, consumer: 'oidc' }) : multitenantTestStore, access: crypto.access, now });
  const engine = worker();
  return { crypto, collection, identity, engine, worker,
    login: purpose => engine.login({ tenant, identity, purpose: purpose || 'data' }) };
};
