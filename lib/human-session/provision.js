'use strict';

// Boot provisioning for single-site OIDC, the way default roles are seeded:
// the database is the home of the bindings, and the operator's identity list
// is applied to it at each start.
//
// The list is authoritative for the bindings it manages (marked source 'list'):
// a listed identity gets a local authorization subject holding the listed
// roles, and a binding to it; a binding whose entry left the list is removed
// with its subject. Between starts the database governs, so a role edit on the
// subject in the admin UI, or a binding edit, applies at the next request.
// Bindings the list did not create are left alone.
const { createHash } = require('node:crypto');
const { authorityId, principalId, emailPrincipalId, validateDocument, MAX_PRINCIPALS } = require('./mongo');
const { refuse } = require('./private-setting');
const NOTES = 'Managed by the OIDC identity list: role edits here apply at once, and the list replaces them at the next restart.';
const WRITE = { writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } };
const READ = { readPreference: 'primary', readConcern: { level: 'majority' } };
const clone = value => JSON.parse(JSON.stringify(value));
const pair = key => key.kid + ':' + key.purpose;
// One deterministic subject per binding, so concurrent starts write the same row.
const subjectFor = id => createHash('sha256').update(JSON.stringify(['single-site-oidc-list-subject-v1', id])).digest('hex').slice(0, 24);

function bindingId (tenant, item) {
  return item.subject !== undefined ? principalId(tenant, item.issuer, item.subject) : emailPrincipalId(tenant, item.issuer, item.email);
}

async function provision ({ collection, authorization, tenant = 'single', consumer = 'oidc', entries = [], fallbackRoles = [], localKeys = null }) {
  if ((entries.length || fallbackRoles.length) && (!authorization || !Array.isArray(authorization.roles) ||
      typeof authorization.saveSubject !== 'function' || typeof authorization.removeSubject !== 'function')) {
    throw new TypeError('The OIDC identity list requires local authorization storage');
  }
  const known = new Set((authorization?.roles || []).map(role => role && role.name));
  for (const role of [...entries.flatMap(item => item.roles), ...fallbackRoles]) {
    if (!known.has(role)) refuse('The OIDC identity list names an unknown role: ' + role);
  }
  const listed = entries.map(item => {
    const id = bindingId(tenant, item);
    return { item, id, subject: subjectFor(id) };
  });
  // Subjects first: a binding never names a subject that does not exist.
  for (const { item, id, subject } of listed) {
    await authorization.saveSubject({ _id: subject, name: item.name || 'oidc-' + id.slice(0, 12), roles: item.roles, notes: NOTES });
  }
  const _id = authorityId(tenant);
  try {
    await collection.updateOne({ _id }, { $setOnInsert: { tenant, revision: 1, keys: [], principals: [], sessions: [], logoutEvents: [] } },
      { upsert: true, ...WRITE });
  } catch (error) { if (error?.code !== 11000) throw error; }
  let removed = null, changed = false;
  for (let attempt = 0; attempt < 8 && removed === null; attempt++) {
    const document = await collection.findOne({ _id, tenant }, READ);
    validateDocument(document, tenant);
    const next = clone(document);
    const wanted = new Set(listed.map(value => value.id));
    if (next.principals.some(principal => wanted.has(principal.id) && principal.source !== 'list')) {
      refuse('The OIDC identity list names an identity that already has a binding it does not manage');
    }
    const gone = next.principals.filter(principal => principal.source === 'list' && !wanted.has(principal.id)).map(principal => principal.subject);
    const managed = listed.map(({ item, id, subject }) => {
      const prior = next.principals.find(principal => principal.id === id);
      return { id, issuer: item.issuer, ...(item.subject !== undefined ? { providerSubject: item.subject } : { email: item.email }),
        subject, consumer, enabled: true, generation: prior?.generation || 1,
        credentialGeneration: prior?.credentialGeneration || 1,
        purposes: item.management ? ['data', 'management'] : ['data'], source: 'list' };
    });
    next.principals = [...next.principals.filter(principal => principal.source !== 'list'), ...managed];
    if (next.principals.length > MAX_PRINCIPALS) refuse('OIDC bindings exceed ' + MAX_PRINCIPALS);
    if (localKeys) {
      // The local signing key's acceptance follows the configured key: a key
      // no longer configured is retired, so its tokens stop at the next request.
      const current = new Set(localKeys.map(pair));
      for (const key of next.keys) if (key.source === 'local' && !current.has(pair(key))) key.active = false;
      for (const key of localKeys) {
        const found = next.keys.find(value => pair(value) === pair(key));
        if (found && found.source !== 'local') refuse('A local OIDC key ID collides with a provisioned key');
        if (found) found.active = true;
        else next.keys.push({ kid: key.kid, purpose: key.purpose, active: true, source: 'local' });
      }
      while (next.keys.length > 128) {
        const index = next.keys.findIndex(key => key.source === 'local' && !key.active);
        if (index === -1) refuse('OIDC accepted keys exceed 128');
        next.keys.splice(index, 1);
      }
    }
    if (JSON.stringify(next) === JSON.stringify(document)) { removed = gone; break; }
    // A removed person's subject goes first: its binding then grants nothing,
    // and a start interrupted here finishes the removal on the next start, so
    // no local subject (with its derived access token) is left behind.
    if (gone.length && typeof authorization?.removeSubject !== 'function') throw new TypeError('Removing OIDC bindings requires local authorization storage');
    for (const subject of gone) await authorization.removeSubject(subject);
    next.revision++;
    validateDocument(next, tenant);
    if (await collection.findOneAndReplace({ _id, tenant, revision: document.revision }, next,
      { returnDocument: 'after', includeResultMetadata: false, ...WRITE })) { removed = gone; changed = true; }
  }
  if (removed === null) throw Object.assign(new Error('HUMAN_SESSION_UNAVAILABLE'), { code: 'HUMAN_SESSION_UNAVAILABLE' });
  return Object.freeze({ bindings: listed.length, removed: removed.length, changed });
}

module.exports = { provision, subjectFor, bindingId, NOTES };
