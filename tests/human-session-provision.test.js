'use strict';

// Single-site OIDC provisioning against the actual MongoDB test database and
// the actual authorization storage: the operator identity list, the fallback
// role for signed-in strangers, bindings to local subjects whose current roles
// apply, verified-email matching keyed on the issuer, and local Ed25519
// signing. Identities, emails and keys are synthetic and generated per run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const request = require('supertest');
const providerFixture = require('./fixtures/human-oidc-provider');
const language = require('../lib/language')();
const { createEngine } = require('../lib/human-session/engine');
const { createMongoStore, authorityId, principalId, emailPrincipalId, MAX_FALLBACK_SESSIONS } = require('../lib/human-session/mongo');
const { provision, subjectFor } = require('../lib/human-session/provision');
const { createSubjectRoles } = require('../lib/human-session/subject-roles');
const { loadIdentityList } = require('../lib/human-session/identity-list');
const { loadHumanAccess, humanRouting } = require('../lib/human-session/access-config');
const DEFAULTS = require('../lib/authorization/default-roles');

const PREFIX = 'oidcprov_';
const ISSUER = 'https://idp-a.example.test';
const OTHER_ISSUER = 'https://idp-b.example.test';
const ORIGIN = 'https://site.example.test';
const permissions = name => DEFAULTS.find(role => role.name === name).permissions.slice();
const ed25519 = () => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });

describe('single-site OIDC identity list, fallback role and current subject roles (actual MongoDB)', function () {
  this.timeout(30000);
  const self = this;
  let clock = Math.floor(Date.now() / 1000), pem;

  before(function (done) {
    process.env.MONGO_AUTHENTICATION_COLLECTIONS_PREFIX = PREFIX;
    self.env = require('../lib/server/env')();
    delete process.env.MONGO_AUTHENTICATION_COLLECTIONS_PREFIX;
    require('../lib/server/bootevent')(self.env, language).boot(ctx => { self.ctx = ctx; done(); });
  });

  const collection = name => self.ctx.store.collection(PREFIX + name);
  beforeEach(async function () {
    for (const name of ['human_authority', 'subjects', 'roles']) await collection(name).deleteMany({});
    await new Promise((resolve, reject) => self.ctx.authorization.storage.reload(error => error ? reject(error) : resolve()));
    clock = Math.floor(Date.now() / 1000);
    pem = ed25519();
  });
  after(async function () {
    for (const name of ['human_authority', 'subjects', 'roles']) await collection(name).deleteMany({});
  });

  // Everything runtime.single composes for a site, minus provider discovery
  // and HTTP: list -> provision -> current roles -> store -> engine.
  async function site ({ identities, fallback, key = pem } = {}) {
    const source = { OIDC_ACCESS_SIGNING_KEY: key, OIDC_ORIGIN: ORIGIN,
      ...(identities === undefined ? {} : { OIDC_IDENTITIES: identities }), ...(fallback === undefined ? {} : { OIDC_FALLBACK_ROLES: fallback }) };
    const access = loadHumanAccess({ source, mode: 'single', tenants: ['single'] });
    const list = loadIdentityList({ source, issuer: ISSUER });
    const result = await provision({ collection: collection('human_authority'), authorization: self.ctx.authorization.storage,
      entries: list.entries, fallbackRoles: list.fallbackRoles, localKeys: access.keyBindings.map(({ kid, purpose }) => ({ kid, purpose })) });
    const roles = createSubjectRoles({ subjects: collection('subjects'), roles: collection('roles'), fallbackRoles: [...list.fallbackRoles] });
    const store = createMongoStore({ collection: collection('human_authority'), tenant: 'single', consumer: 'oidc', roles });
    const engine = createEngine({ store, access, now: () => clock });
    return { engine, access, list, result,
      login: (identity, purpose = 'data') => engine.login({ tenant: 'single', identity: { authenticatedAt: clock, ...identity }, purpose }),
      auth: (token, purpose = 'data') => engine.authenticate({ tenant: 'single', token, purpose }) };
  }
  const authority = () => collection('human_authority').findOne({ _id: authorityId('single') });

  describe('a listed identity gets exactly its roles', function () {
    it('binds issuer + provider subject to a local subject holding the listed roles', async function () {
      const s = await site({ identities: 'sub:alice-1=careportal+readable' });
      const issued = await s.login({ issuer: ISSUER, subject: 'alice-1' });
      const { actor } = await s.auth(issued.token);
      assert.deepEqual(actor.permissionGroups.map(group => [...group]), [permissions('careportal'), permissions('readable')]);
      assert.equal(actor.allows('api:treatments:create'), true);
      assert.equal(actor.allows('api:entries:read'), true);
      assert.equal(actor.allows('api:entries:create'), false);
      assert.equal(actor.allows('admin:api:subjects:read'), false);
      const stored = await authority();
      assert.equal(stored.principals.length, 1);
      assert.equal(stored.principals[0].subject, subjectFor(principalId('single', ISSUER, 'alice-1')));
      assert.equal(Object.hasOwn(stored.principals[0], 'permissionGroups'), false);
      const subject = await collection('subjects').findOne({ name: 'oidc-' + principalId('single', ISSUER, 'alice-1').slice(0, 12) });
      assert.deepEqual(subject.roles, ['careportal', 'readable']);
    });

    it('a listed entry for management purpose is explicit; data-only entries cannot open management', async function () {
      const s = await site({ identities: JSON.stringify([{ subject: 'alice-1', roles: ['admin'], management: true }, { subject: 'carol-1', roles: 'readable' }]) });
      assert.equal((await s.login({ issuer: ISSUER, subject: 'alice-1' }, 'management')).session.purpose, 'management');
      await assert.rejects(s.login({ issuer: ISSUER, subject: 'carol-1' }, 'management'), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });

    it('a provider subject from a second issuer does not select the listed binding', async function () {
      const s = await site({ identities: 'sub:alice-1=careportal+readable' });
      await assert.rejects(s.login({ issuer: OTHER_ISSUER, subject: 'alice-1' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });
  });

  describe('an unlisted signed-in identity gets only the fallback role', function () {
    it('fallback readable: reads, never writes, never management', async function () {
      const s = await site({ identities: 'sub:alice-1=careportal+readable', fallback: 'readable' });
      const issued = await s.login({ issuer: ISSUER, subject: 'stranger-1' });
      const { actor, session } = await s.auth(issued.token);
      assert.deepEqual(actor.permissionGroups.map(group => [...group]), [permissions('readable')]);
      assert.equal(actor.allows('api:entries:read'), true);
      assert.equal(actor.allows('api:treatments:create'), false);
      assert.match(session.subject, /^oidc-[0-9a-f]{40}$/);
      await assert.rejects(s.login({ issuer: ISSUER, subject: 'stranger-1' }, 'management'), { code: 'HUMAN_AUTHORITY_REFUSED' });
      assert.equal((await authority()).principals.length, 1, 'a fallback sign-in provisions no binding');
    });

    it('with no fallback configured an unlisted identity is refused, as before', async function () {
      const s = await site({ identities: 'sub:alice-1=readable' });
      await assert.rejects(s.login({ issuer: ISSUER, subject: 'stranger-1' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });

    it('strangers hold a bounded share of sessions and cannot exhaust capacity for listed people', async function () {
      const s = await site({ identities: 'sub:alice-1=readable', fallback: 'readable' });
      for (let i = 0; i < MAX_FALLBACK_SESSIONS + 8; i++) await s.login({ issuer: ISSUER, subject: 'stranger-' + i });
      const stored = await authority();
      assert.equal(stored.sessions.filter(session => session.fallback === true).length, MAX_FALLBACK_SESSIONS);
      assert.equal((await s.login({ issuer: ISSUER, subject: 'alice-1' })).session.purpose, 'data');
    });
  });

  describe('a role or binding edit takes effect on the next request', function () {
    it('an admin-UI role edit on the bound subject governs the next request', async function () {
      const s = await site({ identities: 'sub:alice-1=careportal+readable' });
      const issued = await s.login({ issuer: ISSUER, subject: 'alice-1' });
      assert.equal((await s.auth(issued.token)).actor.allows('api:treatments:create'), true);
      const id = subjectFor(principalId('single', ISSUER, 'alice-1'));
      await self.ctx.authorization.storage.saveSubject({ _id: id, name: 'alice', roles: ['readable'] });
      const after = (await s.auth(issued.token)).actor;
      assert.equal(after.allows('api:treatments:create'), false);
      assert.equal(after.allows('api:entries:read'), true);
    });

    it('a stored role overriding a default role governs the next request', async function () {
      const s = await site({ identities: 'sub:alice-1=careportal' });
      const issued = await s.login({ issuer: ISSUER, subject: 'alice-1' });
      await self.ctx.authorization.storage.createRole({ name: 'careportal', permissions: ['api:treatments:read'] });
      const { actor } = await s.auth(issued.token);
      assert.equal(actor.allows('api:treatments:create'), false);
      assert.equal(actor.allows('api:treatments:read'), true);
    });

    it('a disabled binding refuses the next request; a removed subject grants nothing', async function () {
      const s = await site({ identities: 'sub:alice-1=readable,sub:bob-1=readable' });
      const alice = await s.login({ issuer: ISSUER, subject: 'alice-1' }), bob = await s.login({ issuer: ISSUER, subject: 'bob-1' });
      await collection('human_authority').updateOne({ _id: authorityId('single') }, { $set: { 'principals.0.enabled': false }, $inc: { revision: 1 } });
      await assert.rejects(s.auth(alice.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      await self.ctx.authorization.storage.removeSubject(subjectFor(principalId('single', ISSUER, 'bob-1')));
      await assert.rejects(s.auth(bob.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });

    it('a restart with the entry removed unbinds the person and deletes the subject the list made', async function () {
      const first = await site({ identities: 'sub:alice-1=careportal+readable,sub:bob-1=readable', fallback: 'readable' });
      const alice = await first.login({ issuer: ISSUER, subject: 'alice-1' });
      const second = await site({ identities: 'sub:bob-1=readable', fallback: 'readable' });
      assert.equal(second.result.removed, 1);
      await assert.rejects(second.auth(alice.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
      assert.equal(await collection('subjects').countDocuments({ name: 'oidc-' + principalId('single', ISSUER, 'alice-1').slice(0, 12) }), 0);
      // Signing in again now gives only the fallback.
      const again = await second.auth((await second.login({ issuer: ISSUER, subject: 'alice-1' })).token);
      assert.equal(again.actor.allows('api:treatments:create'), false);
    });

    it('a restart re-applies listed roles, and a restart with no change writes nothing', async function () {
      await site({ identities: 'sub:alice-1=careportal+readable' });
      const id = subjectFor(principalId('single', ISSUER, 'alice-1'));
      await self.ctx.authorization.storage.saveSubject({ _id: id, name: 'alice', roles: ['readable'] });
      const restarted = await site({ identities: 'sub:alice-1=careportal+readable' });
      assert.deepEqual((await collection('subjects').findOne({ name: 'oidc-' + principalId('single', ISSUER, 'alice-1').slice(0, 12) })).roles, ['careportal', 'readable']);
      assert.equal(restarted.result.changed, false);
    });

    it('leaves bindings the list did not create, and refuses a list entry that collides with one', async function () {
      await site({ identities: '' });
      const subject = await self.ctx.authorization.storage.createSubject({ name: 'operator-made', roles: ['readable'] });
      await collection('human_authority').updateOne({ _id: authorityId('single') }, { $push: { principals: {
        id: principalId('single', ISSUER, 'dana-1'), issuer: ISSUER, providerSubject: 'dana-1', subject: String(subject._id),
        consumer: 'oidc', enabled: true, generation: 1, credentialGeneration: 1, purposes: ['data'] } }, $inc: { revision: 1 } });
      const s = await site({ identities: 'sub:alice-1=readable' });
      assert.equal((await authority()).principals.length, 2);
      assert.equal((await s.auth((await s.login({ issuer: ISSUER, subject: 'dana-1' })).token)).actor.allows('api:entries:read'), true);
      await assert.rejects(site({ identities: 'sub:dana-1=admin' }), /does not manage/);
    });

    it('a principal stored with a permissionGroups copy takes nothing from it (migration)', async function () {
      await site({ identities: '' });
      await collection('human_authority').updateOne({ _id: authorityId('single') }, { $push: { principals: {
        id: principalId('single', ISSUER, 'legacy-1'), issuer: ISSUER, providerSubject: 'legacy-1', subject: 'local_legacy',
        consumer: 'oidc', enabled: true, generation: 1, credentialGeneration: 1, purposes: ['data'],
        permissionGroups: [['*']] } }, $inc: { revision: 1 } });
      const s = await site({ identities: '' });
      await assert.rejects(s.login({ issuer: ISSUER, subject: 'legacy-1' }), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });
  });

  describe('email entries match only a verified address from the same issuer', function () {
    const identities = 'email:Carer@Example.test=careportal+readable';
    it('verified at the listed issuer: the listed roles, case-insensitively', async function () {
      const s = await site({ identities });
      const issued = await s.login({ issuer: ISSUER, subject: 'carer-sub', email: 'carer@example.TEST', emailVerified: true });
      assert.equal((await s.auth(issued.token)).actor.allows('api:treatments:create'), true);
      assert.equal(s.list.requestEmail, true);
      assert.equal((await authority()).principals[0].id, emailPrincipalId('single', ISSUER, 'carer@example.test'));
    });

    it('CONTROL: the same verified email from a second issuer gets no listed role', async function () {
      const s = await site({ identities, fallback: 'readable' });
      const issued = await s.login({ issuer: OTHER_ISSUER, subject: 'carer-sub', email: 'carer@example.test', emailVerified: true });
      const { actor } = await s.auth(issued.token);
      assert.equal(actor.allows('api:treatments:create'), false);
      assert.deepEqual(actor.permissionGroups.map(group => [...group]), [permissions('readable')]);
      const strict = await site({ identities });
      await assert.rejects(strict.login({ issuer: OTHER_ISSUER, subject: 'carer-sub', email: 'carer@example.test', emailVerified: true }),
        { code: 'HUMAN_AUTHORITY_REFUSED' });
    });

    it('CONTROL: an unverified email at the listed issuer gets no listed role', async function () {
      const s = await site({ identities, fallback: 'readable' });
      for (const emailVerified of [false, undefined]) {
        const issued = await s.login({ issuer: ISSUER, subject: 'carer-sub', email: 'carer@example.test', ...(emailVerified === undefined ? {} : { emailVerified }) });
        assert.equal((await s.auth(issued.token)).actor.allows('api:treatments:create'), false);
      }
      const strict = await site({ identities });
      await assert.rejects(strict.login({ issuer: ISSUER, subject: 'carer-sub', email: 'carer@example.test', emailVerified: false }),
        { code: 'HUMAN_AUTHORITY_REFUSED' });
    });

    it('renewal adopts the issuer\'s current verification: an address no longer verified loses the listed role', async function () {
      const s = await site({ identities });
      const issued = await s.login({ issuer: ISSUER, subject: 'carer-sub', email: 'carer@example.test', emailVerified: true });
      // Same second: the local verifier reads the real clock.
      const renewed = await s.engine.renew({ tenant: 'single', token: issued.token,
        identity: { issuer: ISSUER, subject: 'carer-sub', authenticatedAt: clock, email: 'carer@example.test', emailVerified: false } });
      await assert.rejects(s.auth(renewed.token), { code: 'HUMAN_AUTHORITY_REFUSED' });
    });
  });

  describe('runtime.single end to end with the synthetic provider over the HTTP routes', function () {
    it('boots from settings alone and signs in listed, email-listed and unlisted people with their roles', async function () {
      const provider = await providerFixture({ redirectUri: ORIGIN + '/api/v2/oidc/callback' });
      const source = { ENABLE: 'oidc', OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret, OIDC_ORIGIN: ORIGIN, OIDC_COOKIE_KEY: randomBytes(32).toString('base64'),
        OIDC_ACCESS_SIGNING_KEY: pem, OIDC_IDENTITIES: 'sub:alice-1=careportal+readable,email:carer@example.test=careportal',
        OIDC_FALLBACK_ROLES: 'readable' };
      const env = Object.assign(Object.create(Object.getPrototypeOf(self.env)), self.env, { settings: { ...self.env.settings, enable: ['oidc'] } });
      const fetch = globalThis.fetch;
      globalThis.fetch = provider.fetch;
      try {
        const human = await require('../lib/human-session/runtime').single({ env, storage: self.ctx.store, authorization: self.ctx.authorization, source });
        const app = require('express')();
        app.use(human.prefix, human.router);
        const cookie = (response, name) => response.headers['set-cookie'].map(value => value.split(';')[0])
          .find(value => value.startsWith(name) && !value.endsWith('='));
        async function signIn (subject, claims = {}) {
          provider.state.tokenOverrides = claims;
          const start = await request(app).post('/api/v2/oidc/login').set('Origin', ORIGIN).send({}).expect(200);
          assert.equal(new URL(start.body.location).searchParams.get('scope'), 'openid email');
          const callback = new URL(provider.authorize(start.body.location, { subject }));
          const done = await request(app).get(callback.pathname + callback.search).set('Cookie', cookie(start, '__Host-ns-oidc-flow-')).expect(303);
          const probe = await request(app).get('/api/v2/oidc/session').set('Cookie', cookie(done, '__Host-ns-human-data='));
          assert.equal(probe.status, 200, JSON.stringify(probe.body));
          return probe.body.permissionGroups;
        }
        assert.deepEqual(await signIn('alice-1'), [permissions('careportal'), permissions('readable')]);
        assert.deepEqual(await signIn('carer-sub', { email: 'Carer@example.test', email_verified: true }), [permissions('careportal')]);
        assert.deepEqual(await signIn('carer-sub', { email: 'carer@example.test', email_verified: 'true' }), [permissions('readable')]);
        assert.deepEqual(await signIn('stranger-1'), [permissions('readable')]);
        const stored = await authority();
        assert.deepEqual(stored.principals.map(principal => principal.source), ['list', 'list']);
        assert.equal(stored.keys.length, 2);
        assert.equal(stored.keys.every(key => key.active && key.source === 'local'), true);
      } finally { globalThis.fetch = fetch; }
    });
  });

  describe('local Ed25519 signing for single-site', function () {
    it('accepts the configured key at start and retires a replaced key at the next request', async function () {
      const s = await site({ identities: 'sub:alice-1=readable' });
      const keys = (await authority()).keys;
      assert.deepEqual(keys.map(key => [key.purpose, key.active, key.source]), [['data', true, 'local'], ['management', true, 'local']]);
      assert.deepEqual(keys.map(key => key.kid), s.access.keyBindings.map(binding => binding.kid));
      const issued = await s.login({ issuer: ISSUER, subject: 'alice-1' });
      assert.equal(JSON.parse(Buffer.from(issued.token.split('.')[0], 'base64url')).alg, 'EdDSA');
      const rotated = await site({ identities: 'sub:alice-1=readable', key: ed25519() });
      await assert.rejects(rotated.auth(issued.token), { code: 'HUMAN_SESSION_REFUSED' });
      assert.equal((await authority()).keys.filter(key => key.active).length, 2);
      assert.equal((await rotated.auth((await rotated.login({ issuer: ISSUER, subject: 'alice-1' })).token)).actor.allows('api:entries:read'), true);
    });
  });
});

describe('single-site OIDC configuration sources', function () {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-provision-')); });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(directory, name);
    // A per-test temporary directory and a literal test file name.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(file, text);
    return file;
  };

  it('derives issuer, audiences and distinct per-purpose key IDs from the local key and origin', function () {
    const pem = ed25519();
    const access = loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: pem, OIDC_ORIGIN: ORIGIN }, mode: 'single', tenants: ['single'] });
    assert.equal(access.issuer, 'nightscout-human-access:' + ORIGIN);
    assert.deepEqual({ ...access.audiences }, { data: 'nightscout-human-data:' + ORIGIN, management: 'nightscout-human-management:' + ORIGIN });
    const kids = access.keyBindings.map(binding => binding.kid);
    assert.equal(new Set(kids).size, 2);
    const again = loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY_FILE: write('key.pem', pem), OIDC_ORIGIN: ORIGIN }, mode: 'single', tenants: ['single'] });
    assert.deepEqual(again.keyBindings.map(binding => binding.kid), kids, 'inline and file forms derive the same key IDs');
    const escaped = loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: pem.trim().replace(/\n/g, '\\n'), OIDC_ORIGIN: ORIGIN }, mode: 'single', tenants: ['single'] });
    assert.deepEqual(escaped.keyBindings.map(binding => binding.kid), kids, 'an env value may carry literal \\n line breaks');
    assert.equal(humanRouting({ ENABLE: 'oidc', OIDC_ACCESS_SIGNING_KEY: pem, OIDC_ORIGIN: ORIGIN })('not-a-token'), false);
  });

  it('refuses a non-Ed25519 key without echoing it, a local key in multitenant mode, and a local key beside an access file', function () {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
    assert.throws(() => loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: rsa, OIDC_ORIGIN: ORIGIN }, mode: 'single', tenants: ['single'] }),
      error => error.code === 'OIDC_CONFIGURATION_INVALID' && !error.message.includes('PRIVATE KEY') && !error.message.includes(rsa.slice(40, 80)));
    const pem = ed25519();
    assert.throws(() => loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: pem, OIDC_ORIGIN: ORIGIN }, mode: 'multi',
      tenants: ['00000000-0000-4000-8000-000000000001'] }), /single-site only/);
    assert.throws(() => loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: pem, OIDC_ORIGIN: ORIGIN, OIDC_ACCESS_CONFIG: '{}' }, mode: 'single', tenants: ['single'] }), /not both/);
    assert.throws(() => loadHumanAccess({ source: { OIDC_ACCESS_SIGNING_KEY: pem, OIDC_ACCESS_SIGNING_KEY_FILE: write('k.pem', pem), OIDC_ORIGIN: ORIGIN },
      mode: 'single', tenants: ['single'] }), /not both/);
  });

  it('CONTROL: OIDC_ACCESS_CONFIG and OIDC_ACCESS_CONFIG_FILE together refuse at load', function () {
    const file = write('access.json', '{}');
    assert.throws(() => loadHumanAccess({ source: { OIDC_ACCESS_CONFIG: '{}', OIDC_ACCESS_CONFIG_FILE: file }, mode: 'single', tenants: ['single'] }),
      error => error.code === 'OIDC_CONFIGURATION_INVALID' && /not both/.test(error.message));
    assert.throws(() => humanRouting({ ENABLE: 'oidc', OIDC_ACCESS_CONFIG: file, OIDC_ACCESS_CONFIG_FILE: file }), /not both/);
  });

  it('reads the identity list inline, as CSV, TSV or JSON, and refuses ambiguity', function () {
    const expected = [{ issuer: ISSUER, roles: ['careportal', 'readable'], management: false, name: null, subject: 'alice-1' },
      { issuer: OTHER_ISSUER, roles: ['readable'], management: true, name: 'Carer', email: 'carer@example.test' }];
    const csv = 'subject,email,roles,issuer,management,name\nalice-1,,careportal+readable,,,\n# a comment\n,Carer@example.test,readable,' + OTHER_ISSUER + ',true,Carer\n';
    const forms = [
      { OIDC_IDENTITIES_FILE: write('ids.csv', csv) },
      { OIDC_IDENTITIES_FILE: write('ids.tsv', csv.replace(/,/g, '\t')) },
      { OIDC_IDENTITIES_FILE: write('ids.json', JSON.stringify([{ subject: 'alice-1', roles: ['careportal', 'readable'] },
        { email: 'Carer@example.test', roles: 'readable', issuer: OTHER_ISSUER, management: true, name: 'Carer' }])) },
      { OIDC_IDENTITIES: JSON.stringify([{ subject: 'alice-1', roles: 'careportal+readable' },
        { email: 'carer@example.test', roles: ['readable'], issuer: OTHER_ISSUER, management: true, name: 'Carer' }]) }
    ];
    for (const source of forms) assert.deepEqual(JSON.parse(JSON.stringify(loadIdentityList({ source, issuer: ISSUER }).entries)), expected);
    const inline = loadIdentityList({ source: { OIDC_IDENTITIES: 'sub:alice-1=careportal+readable, email:carer@example.test=readable', OIDC_FALLBACK_ROLES: 'readable' }, issuer: ISSUER });
    assert.deepEqual(inline.entries.map(entry => entry.subject || entry.email), ['alice-1', 'carer@example.test']);
    assert.deepEqual([...inline.fallbackRoles], ['readable']);
    for (const source of [
      { OIDC_IDENTITIES: 'sub:a=readable', OIDC_IDENTITIES_FILE: write('x.csv', 'subject,roles\n') },
      { OIDC_IDENTITIES: 'alice-1=readable' },
      { OIDC_IDENTITIES: 'sub:a=readable,sub:a=careportal' },
      { OIDC_IDENTITIES: JSON.stringify([{ subject: 'a', email: 'a@example.test', roles: ['readable'] }]) },
      { OIDC_IDENTITIES: JSON.stringify([{ subject: 'a', roles: [] }]) },
      { OIDC_IDENTITIES: JSON.stringify([{ subject: 'a', roles: ['readable'], permissions: ['*'] }]) },
      { OIDC_IDENTITIES_FILE: write('ids.txt', 'subject,roles\na,readable\n') },
      { OIDC_IDENTITIES_FILE: write('q.csv', 'subject,roles\n"a,b",readable\n') }
    ]) assert.throws(() => loadIdentityList({ source, issuer: ISSUER }), { code: 'OIDC_CONFIGURATION_INVALID' });
  });

  it('refuses unknown role names in the list or fallback before writing anything', async function () {
    const authorization = { roles: DEFAULTS.map(role => ({ ...role })), saveSubject: async () => assert.fail('wrote'), removeSubject: async () => assert.fail('wrote') };
    const collection = { updateOne: async () => assert.fail('wrote') };
    await assert.rejects(provision({ collection, authorization, entries: [{ issuer: ISSUER, subject: 'a', roles: ['readble'] }] }), /unknown role: readble/);
    await assert.rejects(provision({ collection, authorization, fallbackRoles: ['reader'] }), /unknown role: reader/);
  });
});
