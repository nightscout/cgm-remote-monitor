'use strict';

const assert = require('node:assert/strict');
const { createSubjectAdmin } = require('../lib/subject-admin/component');
const { createSubjectManagementApp } = require('../lib/server/subject-management-app');
const dispatch = require('./fixtures/listener-free-http');
const { createSecrets } = require('../lib/secrets/component');
const { createHash } = require('node:crypto');
const ROOT = 'synthetic-owner-issuer-root-2026';
const sha1 = value => createHash('sha1').update(value).digest('hex');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const actor = { tenant: A, principal: 'owner', consumer: 'owner' };
const PATH = '/api/v2/authorization/subjects';

// Source double; independent persisted oracle. Native PostgreSQL and HTTP are
// deliberately left to coherent-candidate acceptance rather than inferred here.
function fixture () {
  const state = { subjects: new Map(), roles: new Map(), events: [], active: true, activity: 0, sensitive: [] };
  const foreign = { name: 'Foreign', roles: ['admin'] }; state.subjects.set(B + '/foreign', foreign);
  const store = {
    async update () {}, async remove (who, id) { return state.subjects.delete(who.tenant + '/' + id); },
    async create (who, value) {
      const id = 'created'; state.subjects.set(who.tenant + '/' + id, structuredClone(value));
      state.events.push('create'); return { subjectId: id, ...value };
    },
    async createRole (who, value) {
      state.roles.set(who.tenant + '/' + value.name, structuredClone(value.permissions)); return value;
    },
    async withCredential (who, id, issue) {
      if (!state.active) throw Object.assign(new Error('revoked'), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
      if (!state.subjects.has(who.tenant + '/' + id)) throw Object.assign(new Error('missing'), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
      state.events.push('locked'); const value = await issue(); state.events.push('committed'); return value;
    }
  };
  const secrets = createSecrets({ maxTokenLifetimeSeconds: 28800,
    providerFor: async tenant => ({ async decrypt () {
      state.events.push('derive');
      return Buffer.from(JSON.stringify({ tenant, id: 'synthetic-root', data: Buffer.from(ROOT).toString('base64') }));
    } }),
    store: { async get (tenant, id) { return { tenant, id, format: 1, ciphertext: 'synthetic-ciphertext' }; }, async insert () {} },
    audit: async event => { assert.equal(event.operation, 'issue-legacy'); },
    authorize: async (who, action) => who.principal === 'owner' && who.consumer === 'owner' && action.operation === 'issue-legacy',
    legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'synthetic-root' },
      subjects: [...state.subjects.entries()].filter(([key]) => key.startsWith(tenant + '/')).map(([key, value]) => ({
        subjectId: key.slice(tenant.length + 1), tokenPrefix: value.name.toLowerCase().replace(/[\W]/g, '').substring(0, 10)
      })) })
  });
  const service = createSubjectAdmin({ store, authorizeManagement: async who => state.active && who.principal === 'owner',
    issueCredential: secrets.issueLegacyCredential });
  const authenticateManagement = async ({ tenant, credential, sensitive }) => {
    state.sensitive.push(sensitive === true);
    return credential === 'synthetic-management' ? { ...actor, tenant } : null;
  };
  authenticateManagement.activity = async () => { assert.notEqual(state.events.at(-1), 'derive'); state.activity++; };
  const app = createSubjectManagementApp({ resolver: { resolve: async req => req.headers.host === 'two.example.test' ? B : A },
    authenticateManagement, subjectAdmin: service });
  return { app, state, service, foreign };
}

describe('owner credential management source boundaries', function () {
  it('dispatches create, wildcard role, issue and revoke with postcommit activity and an untouched foreign tenant', async function () {
    const f = fixture();
    const call = (method, path, body) => dispatch(f.app, { method, path, body });
    assert.equal((await call('POST', '/api/v2/authorization/roles', { name: 'reader', permissions: ['*:*:read'] })).status, 200);
    assert.deepEqual(f.state.roles.get(A + '/reader'), ['*:*:read']);
    const made = await call('POST', PATH, { name: 'Synthetic reader', roles: ['reader'] });
    assert.equal(made.status, 200); assert.deepEqual(f.state.subjects.get(A + '/created'), { name: 'Synthetic reader', roles: ['reader'] });
    const issued = await call('POST', PATH + '/created/credential', {});
    assert.equal(issued.status, 200); assert.deepEqual(issued.body, { token: 'syntheticr-' + sha1(sha1(ROOT) + 'created').slice(0, 16) });
    assert.deepEqual(f.state.events.slice(-3), ['locked', 'derive', 'committed']);
    assert.equal((await call('DELETE', PATH + '/created')).status, 200);
    assert.equal(f.state.subjects.has(A + '/created'), false);
    assert.equal((await call('POST', PATH + '/created/credential', {})).status, 404);
    assert.equal(f.state.activity, 4);
    assert.deepEqual(f.state.sensitive, [true, true, true, false, true]);
    assert.deepEqual(f.state.subjects.get(B + '/foreign'), f.foreign);
    assert.equal(issued.headers['cache-control'], 'no-store');
  });
  it('refuses data credentials, current revoked actors and invalid fields with no stored effect or activity', async function () {
    const f = fixture();
    for (const body of [{ name: 'Valid', accessToken: 'client-derived' }, { name: 'Valid', roles: ['same', 'same'] }]) {
      assert.equal((await dispatch(f.app, { method: 'POST', path: PATH, body })).status, 400);
    }
    assert.equal((await dispatch(f.app, { method: 'POST', path: PATH, body: { name: 'Valid' }, credential: 'data-root' })).status, 401);
    f.state.active = false;
    assert.equal((await dispatch(f.app, { method: 'POST', path: PATH, body: { name: 'Valid' } })).status, 403);
    assert.equal(f.state.subjects.size, 1); assert.equal(f.state.activity, 0); assert.equal(f.state.events.length, 0);
  });
  it('requires the issuance tenant identity to match before entering the store fence', async function () {
    let called = false;
    const service = createSubjectAdmin({ store: { update () {}, remove () {}, withCredential () { called = true; } },
      authorizeManagement: async () => true,
      issueCredential: (who, id, fence) => fence({ tenant: B, subjectId: id }, async () => ({ token: 'must-not-release' })) });
    await assert.rejects(service.credential(actor, 'subject'), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    assert.equal(called, false);
  });
});
