'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const material = require('../lib/secrets/legacy-verifiers');
const tokens = require('../lib/tenant-authorization/legacy-data-token');
const createDataAccess = require('../lib/server/tenant-app/data-access');
const createSocket = require('../lib/server/realtime/authority').create;
const createExchange = require('../lib/server/tenant-app/local-exchange');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hash = (v, algorithm = 'sha1') => crypto.createHash(algorithm).update(v).digest('hex');
const ROOT = 'synthetic-local-root-secret';
const SUBJECTS = [{ subjectId: 'subject', tokenPrefix: 'named' }, { subjectId: 'second', tokenPrefix: '' }];
const digest = id => hash(hash(ROOT) + id);
const credential = id => SUBJECTS.find(s => s.subjectId === id).tokenPrefix + '-' + digest(id).slice(0, 16);

async function fixture () {
  let providerUnavailable = false;
  let time = 1700000000, allowed = true, active = true, unavailable = false, failAudit = false;
  const key = tokens.generateKey(), other = tokens.generateKey(), prepared = material.prepare(Buffer.from(ROOT), SUBJECTS);
  const states = new Map([A, B].map(tenant => [tenant, { rootVerifiers: prepared.rootVerifiers, rootVersion: 1,
    subjects: prepared.subjects.map(s => ({ ...s, credentialVersion: 1 })),
    keys: [{ kid: (tenant === A ? key : other).kid, publicKey: (tenant === A ? key : other).publicKey, active: true }] }]));
  const effects = { metadata: 0, authority: 0, decrypt: 0, sign: 0, verify: 0, keyReads: 0, audit: 0 };
  const codec = tokens.create({ issuer: 'synthetic-data', audience: 'synthetic-api', now: () => time });
  const read = async tenant => { effects.metadata++; if (unavailable) throw Error('synthetic metadata unavailable'); return states.get(tenant); };
  const credentials = material.create({ read, verifyToken: codec.verify });
  const verifierContext = async tenant => ({ tenant, principal: 'api', consumer: 'data' });
  const authority = {
    authorize: async () => { throw Error('one current snapshot required'); },
    async subjectSnapshot ({ tenant, principal }) {
      effects.authority++;
      return active && states.get(tenant).subjects.some(s => s.subjectId === principal.subjectId)
        ? { sub: 'Current name', permissionGroups: allowed ? [['*']] : [[]] } : null;
    },
    async subjectAuthorizationSnapshot (operation) {
      const subject = await this.subjectSnapshot(operation);
      const grant = allowed;
      return subject ? { subject, allows: () => grant } : null;
    },
    async permissionSnapshot () { effects.authority++; const grant = allowed; return { allows: () => grant }; }
  };
  const provider = require('./fixtures/tenant-credential-provider')();
  for (const operation of ['decrypt', 'sign', 'verify']) {
    const original = provider[operation].bind(provider);
    provider[operation] = async (...args) => { effects[operation]++; if (providerUnavailable) throw Object.assign(new Error('synthetic Vault unavailable'), { code: 'SECRETS_PROVIDER_UNAVAILABLE' }); return original(...args); };
  }
  const records = new Map();
  const audit = async () => { effects.audit++; if (failAudit) throw Error('synthetic audit commit failed'); };
  const secrets = require('../lib/secrets/component').createSecrets({ providerFor: async () => provider,
    store: { get: async (tenant, id) => records.get(tenant + '/' + id), insert: async row => records.set(row.tenant + '/' + row.id, row) },
    authorize: async () => true, audit, maxTokenLifetimeSeconds: 28800, now: () => time * 1000,
    legacyAuthorityFor: async tenant => ({ reference: { tenant, id: 'root' }, subjects: SUBJECTS }) });
  await secrets.encrypt(await verifierContext(A), 'root', Buffer.from(ROOT));
  const store = { async signingKey (tenant) { effects.keyReads++; return tenant === A ? key : other; } };
  const exchange = createExchange({ credentials, secrets, authority, verifierContext, store, codec, audit, now: () => time * 1000 });
  const data = createDataAccess({ secrets: credentials, authority, verifierContext, legacyCollections: ['entries'] });
  const socket = createSocket({ secrets: credentials, authority, verifierContext, admission: { allows: async () => active } });
  const dataRead = (token, tenant = A) => data({ tenant, version: 3,
    request: { method: 'GET', path: '/entries', query: {}, rawHeaders: ['Authorization', 'Bearer ' + token] } });
  const reset = () => { for (const key of Object.keys(effects)) effects[key] = 0; };
  reset();
  return { states, effects, credentials, codec, key, other, exchange, dataRead, data, socket, secrets, verifierContext, authority, store, audit, read, reset,
    vaultUnavailable: value => { providerUnavailable = value; }, permission: value => { allowed = value; }, active: value => { active = value; }, unavailable: value => { unavailable = value; },
    failAudit: value => { failAudit = value; }, advance: delta => { time += delta; } };
}

function modified (file, transform) {
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file comes from require.resolve in the controls below.
  const original = fs.readFileSync(file, 'utf8'), changed = transform(original);
  assert.notEqual(changed, original, 'mutation must change actual source'); loaded._compile(changed, file); return loaded.exports;
}

describe('local Node/PostgreSQL multitenant data credentials', function () {
  it('preserves supported legacy root and subject carriers without storing usable bearer digests', async function () {
    const f = await fixture(), context = await f.verifierContext(A);
    for (const root of [hash(ROOT), hash(ROOT).toUpperCase(), hash(ROOT, 'sha512')]) {
      assert.equal((await f.credentials.verifyLegacyCredential(context, { apiSecret: root })).kind, 'root');
    }
    for (const subject of SUBJECTS) {
      const raw = credential(subject.subjectId), d = digest(subject.subjectId), td = hash(raw);
      for (const value of [raw, d, d.slice(0, 16), td, td.slice(0, 16), 'any-prefix-' + d.slice(0, 16)]) {
        assert.equal((await f.credentials.verifyLegacyCredential(context, { apiSecret: value })).subjectId, subject.subjectId);
      }
      const stored = JSON.stringify(f.states.get(A).subjects.find(s => s.subjectId === subject.subjectId).verifiers);
      for (const value of [raw, d, d.slice(0, 16), td, td.slice(0, 16), hash(ROOT)]) assert.equal(stored.includes(value), false);
    }
    assert.equal(await f.credentials.verifyLegacyCredential(context, { apiSecret: ROOT }), null);
    assert.deepEqual([f.effects.decrypt, f.effects.sign, f.effects.verify], [0, 0, 0], 'LEGACY_AUTH_HAS_NO_VAULT_EFFECT');
  });

  it('uses Node-only exchange, DATA and every socket carrier with fresh authority', async function () {
    const f = await fixture();
    const issued = await f.exchange({ tenant: A, credential: credential('subject') });
    assert.deepEqual(Object.keys(issued).sort(), ['exp', 'iat', 'permissionGroups', 'sub', 'token']);
    assert.equal(issued.exp - issued.iat, 28800); assert.equal(issued.sub, 'Current name');
    assert.equal(JSON.parse(Buffer.from(issued.token.split('.')[0], 'base64url')).typ, tokens.TYPE);
    assert.equal((await f.dataRead(issued.token)).principal, 'subject');
    for (const [namespace, field] of [['/', 'token'], ['/alarm', 'jwtToken'], ['/alarm', 'accessToken'], ['/storage', 'accessToken']]) {
      assert.equal((await f.socket.verify({ tenant: A, namespace, credential: { [field]: issued.token } })).principal.subjectId, 'subject');
    }
    f.permission(false);
    await assert.rejects(f.dataRead(issued.token), { code: 'TENANT_DATA_FORBIDDEN' });
    assert.equal((await f.socket.verify({ tenant: A, namespace: '/', credential: { token: issued.token } })).permissions.read, false);
    assert.deepEqual([f.effects.decrypt, f.effects.sign, f.effects.verify], [0, 0, 0], 'DATA_SOCKET_EXCHANGE_HAVE_NO_VAULT_EFFECT');
    f.active(false);
    await assert.rejects(f.socket.verify({ tenant: A, namespace: '/', credential: { token: issued.token } }), { code: 'SOCKET_AUTHORITY_REFUSED' });
  });

  it('keeps plain API-secret and legacy query-token reads local, including mixed root precedence/refusal', async function () {
    const f = await fixture(), context = await f.verifierContext(A), token = credential('subject');
    for (const request of [
      { method: 'GET', path: '/entries', query: {}, rawHeaders: ['api-secret', hash(ROOT)] },
      { method: 'GET', path: '/entries', query: { token }, rawHeaders: [] },
      { method: 'GET', path: '/entries', query: { token }, rawHeaders: ['api-secret', hash(ROOT)] }
    ]) assert(await f.data({ tenant: A, version: 1, request }));
    assert.equal(await f.credentials.verifyLegacyCredential(context, { token: 'unknown-credential', apiSecret: hash(ROOT) }, async () => true), null);
    assert.equal(await f.credentials.verifyLegacyCredential(context, { token, apiSecret: hash(ROOT) }, async () => false), null);
    assert.equal((await f.credentials.verifyLegacyCredential(context, { token, apiSecret: hash(ROOT) }, async () => true)).kind, 'root');
    assert.deepEqual([f.effects.decrypt, f.effects.sign, f.effects.verify], [0, 0, 0]);
  });

  it('refuses tampering, wrong realm/tenant, expiry, removed credentials and unavailable metadata without Vault fallback', async function () {
    const f = await fixture(), issued = await f.exchange({ tenant: A, credential: credential('subject') });
    const parts = issued.token.split('.');
    const bad = parts.slice(0, 2).join('.') + '.' + Buffer.alloc(64).toString('base64url');
    for (const token of [bad, issued.token + '!', 'invalid.jwt.shape']) assert.equal(await f.dataRead(token), null);
    assert.equal(await f.dataRead(issued.token, B), null);
    const wrongRealm = tokens.create({ issuer: 'other', audience: 'synthetic-api', now: () => 1700000000 });
    assert.throws(() => wrongRealm.verify(issued.token, A, f.states.get(A).keys), { code: 'SECRETS_TOKEN_INVALID' });
    f.states.get(A).subjects[0].credentialVersion++;
    assert.equal(await f.dataRead(issued.token), null);
    f.states.get(A).subjects[0].credentialVersion--;
    f.states.get(A).rootVersion++;
    assert.equal(await f.dataRead(issued.token), null);
    f.states.get(A).rootVersion--;
    f.advance(28800); assert.equal(await f.dataRead(issued.token), null);
    f.unavailable(true); await assert.rejects(f.dataRead(issued.token), /synthetic metadata unavailable/);
    assert.deepEqual([f.effects.decrypt, f.effects.sign, f.effects.verify], [0, 0, 0]);
  });

  it('supports key overlap and fresh key revocation across a recreated verifier', async function () {
    const f = await fixture(), issued = await f.exchange({ tenant: A, credential: credential('subject') });
    const next = tokens.generateKey(); f.states.get(A).keys.push({ ...next, active: true });
    assert(await f.dataRead(issued.token));
    const restarted = material.create({ read: f.read, verifyToken: f.codec.verify });
    assert(await restarted.verifyLegacyCredential(await f.verifierContext(A), { token: issued.token }));
    f.states.get(A).keys[0].active = false;
    assert.equal(await restarted.verifyLegacyCredential(await f.verifierContext(A), { token: issued.token }), null);
    assert.equal(await f.dataRead(issued.token), null, 'KEY_REVOCATION_NEXT_REQUEST');
  });

  it('refuses unprepared subjects individually while retaining prepared root administration', async function () {
    const f = await fixture(), context = await f.verifierContext(A);
    f.states.get(A).subjects[0] = { ...f.states.get(A).subjects[0], verifiers: null };
    assert.equal(await f.credentials.verifyLegacyCredential(context, { apiSecret: credential('subject') }), null);
    assert.equal(await f.credentials.currentSubject(A, 'subject'), null);
    assert.equal((await f.credentials.verifyLegacyCredential(context, { apiSecret: hash(ROOT) })).kind, 'root');
    f.states.get(A).rootVerifiers = null;
    await assert.rejects(f.credentials.verifyLegacyCredential(context, { apiSecret: hash(ROOT) }), { code: 'SECRETS_LEGACY_AUTHORITY_INVALID' });
  });

  it('renews old Vault HS256 only at exchange and uses no Vault work afterwards', async function () {
    const f = await fixture(), context = await f.verifierContext(A);
    const old = await f.secrets.signJWT(context, credential('subject'), 28800); f.reset();
    assert.equal(await f.dataRead(old), null);
    assert.deepEqual([f.effects.decrypt, f.effects.verify], [0, 0], 'OLD_JWT_NEVER_TRIGGERS_DATA_VAULT_FALLBACK');
    const renewed = await f.exchange({ tenant: A, credential: old });
    assert(renewed); assert.deepEqual([f.effects.decrypt, f.effects.verify, f.effects.sign], [1, 1, 0]);
    f.reset(); assert(await f.dataRead(renewed.token));
    await f.socket.verify({ tenant: A, namespace: '/', credential: { token: renewed.token } });
    assert.deepEqual([f.effects.decrypt, f.effects.verify, f.effects.sign], [0, 0, 0]);
  });

  it('keeps status issuance and admin query-token authentication out of previous-profile renewal', async function () {
    const f = await fixture(), context = await f.verifierContext(A);
    const old = await f.secrets.signJWT(context, credential('subject'), 28800); f.reset(); f.vaultUnavailable(true);
    const status = require('../lib/server/tenant-app/status-authorization')({ tenant: A,
      exchange: operation => f.exchange({ ...operation, renewPrevious: false }) });
    const request = { method: 'GET', path: '/status', query: { token: old }, rawHeaders: [], header: () => undefined };
    assert.equal(await status(request), null, 'ORDINARY_STATUS_DOES_NOT_RENEW_VAULT_JWT');
    assert.equal(f.effects.keyReads, 0);
    const admin = require('../lib/server/tenant-app/root-admin').createRootAuthentication({
      secrets: { ...f.secrets, verifyLegacyCredential: f.credentials.verifyLegacyCredential },
      authority: { ...f.authority, authorize: async () => true }, verifierContext: f.verifierContext, tenants: [A] });
    const adminRequest = token => ({ ...request, query: { token } });
    const actor = await admin({ tenant: A, request: adminRequest(credential('subject')), permission: 'admin:api:subjects:read' });
    assert.equal(actor.actor.principal, 'subject'); assert.equal(f.effects.keyReads, 0, 'ADMIN_AUTH_DOES_NOT_ISSUE');
    assert.equal(await admin({ tenant: A, request: adminRequest(old), permission: 'admin:api:subjects:read' }), null);
    assert.deepEqual([f.effects.decrypt, f.effects.sign, f.effects.verify], [0, 0, 0]);
  });

  it('withholds local issuance on audit failure, without exposing keys or credentials in receipts', async function () {
    const f = await fixture(); f.failAudit(true);
    await assert.rejects(f.exchange({ tenant: A, credential: credential('subject') }), /synthetic audit commit failed/);
    assert.equal(f.effects.keyReads, 0, 'NO_KEY_READ_BEFORE_DURABLE_SIGN_AUDIT');
    assert.deepEqual([f.effects.decrypt, f.effects.verify, f.effects.sign], [0, 0, 0]);
  });

  it('keeps local DATA/socket/exchange working when the real old provider refuses every cryptographic call', async function () {
    const f = await fixture(); f.vaultUnavailable(true);
    const context = await f.verifierContext(A);
    await assert.rejects(f.secrets.verifyLegacyCredential(context, { apiSecret: hash(ROOT) }), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    assert.equal(f.effects.decrypt, 1, 'CONTROL_VAULT_OUTAGE_WAS_EXERCISED'); f.reset();
    const issued = await f.exchange({ tenant: A, credential: credential('subject') });
    assert(await f.dataRead(issued.token));
    assert(await f.socket.verify({ tenant: A, namespace: '/', credential: { token: issued.token } }));
    const oldComposition = createDataAccess({ secrets: f.secrets, authority: f.authority, verifierContext: f.verifierContext });
    await assert.rejects(oldComposition({ tenant: A, request: { method: 'GET', path: '/entries', query: {},
      rawHeaders: ['api-secret', hash(ROOT)] } }), { code: 'SECRETS_PROVIDER_UNAVAILABLE' });
    assert.equal(f.effects.decrypt, 1, 'CONTROL_OLD_COMPOSITION_STILL_DEPENDS_ON_VAULT');
  });

  it('control: bypassing the local signature check permits a forged token and makes refusal red', async function () {
    const f = await fixture(), issued = await f.exchange({ tenant: A, credential: credential('subject') });
    const changed = modified(require.resolve('../lib/tenant-authorization/legacy-data-token'), source => source.replace(
      "!signatureProof(Buffer.from(parts[0] + '.' + parts[1]), publicKey, signature)", 'false'));
    const verify = changed.create({ issuer: 'synthetic-data', audience: 'synthetic-api', now: () => 1700000000 }).verify;
    const parts = issued.token.split('.'), forged = parts.slice(0, 2).join('.') + '.' + Buffer.alloc(64).toString('base64url');
    const claims = verify(forged, A, f.states.get(A).keys); assert.equal(claims.sub, 'subject', 'CONTROL_FORGERY_EXERCISED');
    assert.throws(() => assert.throws(() => verify(forged, A, f.states.get(A).keys), /SECRETS_TOKEN_INVALID/), /Missing expected exception/);
  });

  it('control: retaining key metadata across operations permits a revoked key and fails the current-state oracle', async function () {
    const f = await fixture(), issued = await f.exchange({ tenant: A, credential: credential('subject') });
    const saved = structuredClone(f.states.get(A));
    const stale = material.create({ read: async () => saved, verifyToken: f.codec.verify });
    f.states.get(A).keys[0].active = false;
    const result = await stale.verifyLegacyCredential(await f.verifierContext(A), { token: issued.token });
    assert(result, 'CONTROL_STALE_KEY_WAS_ACCEPTED');
    assert.throws(() => assert.equal(result, null, 'KEY_REVOCATION_NEXT_REQUEST'), /KEY_REVOCATION_NEXT_REQUEST/);
    assert.equal(await f.dataRead(issued.token), null);
  });
});


describe('local data credential persistence and preparation protocols', function () {
  it('reads current public metadata per operation and reads private material only at issuance', async function () {
    const file = require.resolve('../lib/secrets/legacy-postgres'), loaded = new Module(file, module);
    loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
    const realRequire = loaded.require.bind(loaded), calls = [];
    const key = tokens.generateKey(), prepared = material.prepare(Buffer.from(ROOT), SUBJECTS);
    let revoked = false, unavailable = false, rootChanged = false, prefixChanged = false;
    const connection = { async withTenant (tenant, fn) { return fn(); }, async end () {},
      async query (sql, values) {
        if (sql.includes('FROM pg_class')) return { rows: Array.from({ length: 3 }, () => ({ secured: true, owns: false, reads: true, writes: false })) };
        calls.push({ sql, values }); if (unavailable) throw Error('sensitive synthetic database detail');
        if (sql.includes('SELECT kid, private_key')) return { rows: [{ kid: key.kid, private_key: key.privateKey }] };
        return { rows: prepared.subjects.map(subject => ({ root_verifiers: prepared.rootVerifiers, root_version: 1,
          root_reference_id: rootChanged ? 'root-new' : 'root', verifier_root_reference_id: 'root',
          token_prefix: prefixChanged ? 'changed' : 'named', verifier_token_prefix: 'named',
          subject_id: subject.subjectId, verifiers: subject.verifiers, credential_version: 1,
          keys: [{ kid: key.kid, publicKey: key.publicKey, active: !revoked }] })) };
      } };
    loaded.require = name => name === '../storage/postgres-connection' ? async () => connection
      : name === '../storage/tenant-scope' ? { getTenancyMode: () => 'multi' } : realRequire(name);
    loaded._compile(fs.readFileSync(file, 'utf8'), file);
    const store = await loaded.exports({ connectionString: 'synthetic', namespace: 'local_auth', localVerification: true });
    assert.equal((await store.readVerification(A)).keys[0].active, true);
    revoked = true; assert.equal((await store.readVerification(A)).keys[0].active, false);
    assert.equal(calls.length, 2, 'ONE_FRESH_PUBLIC_METADATA_QUERY_PER_OPERATION');
    for (const call of calls) {
      assert.deepEqual(call.values, [A]); assert.doesNotMatch(call.sql, /private_key/);
      assert.match(call.sql, /WHERE c.tenant_id=\$1/);
    }
    prefixChanged = true; assert.equal((await store.readVerification(A)).subjects[0].verifiers, null);
    rootChanged = true; await assert.rejects(store.readVerification(A), { code: 'SECRETS_LEGACY_AUTHORITY_INVALID' });
    assert.equal((await store.signingKey(A)).privateKey, key.privateKey);
    unavailable = true;
    await assert.rejects(store.readVerification(A), error => error.code === 'SECRETS_LEGACY_AUTHORITY_UNAVAILABLE' && !error.message.includes('sensitive'));
  });

  function preparationFixture () {
    const state = { rootVerifiers: null, rootVersion: 1, subjects: new Map(), keys: [], commits: 0 };
    let draft, failCommit = false, failRead = false, rootBytes;
    const calls = [];
    const connection = {
      async withTenant (tenant, fn) {
        draft = structuredClone(state);
        try {
          const result = await fn(); if (failCommit) throw Error('synthetic commit failed');
          Object.assign(state, draft); state.commits++; return result;
        } finally { draft = null; }
      },
      async query (sql, values) {
        calls.push(sql);
        if (sql.startsWith('SET LOCAL')) return { rows: [] };
        if (sql.startsWith('SELECT root_reference_id')) return { rows: [{ root_reference_id: 'root' }] };
        if (sql.startsWith('SELECT subject_id')) return { rows: SUBJECTS.map(s => ({ subject_id: s.subjectId, token_prefix: s.tokenPrefix })) };
        if (sql.startsWith('UPDATE') && sql.includes('root_version=')) {
          if (JSON.stringify(draft.rootVerifiers) !== JSON.stringify(values[1])) draft.rootVersion++;
          draft.rootVerifiers = values[1]; return { rows: [] };
        }
        if (sql.startsWith('UPDATE') && sql.includes('SET verifiers=')) { draft.subjects.set(values[1], values[2]); return { rows: [] }; }
        if (sql.startsWith('SELECT kid')) return { rows: draft.keys.filter(k => k.active && k.signing) };
        if (sql.startsWith('UPDATE') && sql.includes('SET signing=false')) {
          for (const key of draft.keys) if (key.signing) { key.signing = false; key.privateKey = null; } return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO')) {
          draft.keys.push({ kid: values[1], publicKey: values[2], privateKey: values[3], active: true, signing: true }); return { rows: [] };
        }
        throw Error('Unexpected preparation SQL');
      }
    };
    const prepare = require('../lib/secrets/prepare-local-auth')({ connection, namespace: 'local_auth',
      withCurrentTenant: async (tenant, fn) => { assert.equal(tenant, A); calls.push('exclusive-window'); return fn(); },
      readRoot: async reference => {
        assert.deepEqual(reference, { tenant: A, id: 'root' }); if (failRead) throw Error('synthetic audited root failure');
        rootBytes = Buffer.from(ROOT); return rootBytes;
      } });
    return { state, calls, prepare, rootBytes: () => rootBytes, failCommit: () => { failCommit = true; }, failRead: () => { failRead = true; } };
  }

  it('prepares current verifiers and a separate local signing key atomically, with idempotent restart and overlap rotation', async function () {
    const f = preparationFixture();
    assert.deepEqual(await f.prepare(A), { prepared: true });
    assert.equal(f.state.keys.length, 1); assert.equal(f.state.subjects.size, 2);
    assert(f.rootBytes().every(v => v === 0));
    const first = structuredClone(f.state.keys[0]), version = f.state.rootVersion;
    await f.prepare(A); assert.equal(f.state.keys.length, 1); assert.equal(f.state.rootVersion, version);
    await f.prepare(A, { rotateSigningKey: true });
    assert.equal(f.state.keys.length, 2); assert.equal(f.state.keys[0].active, true);
    assert.equal(f.state.keys[0].signing, false); assert.equal(f.state.keys[0].privateKey, null);
    const codec = tokens.create({ issuer: 'synthetic', audience: 'synthetic', now: () => 1700000000 });
    const issued = codec.issue(A, { kind: 'subject', subjectId: 'subject', credentialVersion: 1, rootVersion: version }, first);
    assert.equal(codec.verify(issued.token, A, f.state.keys).sub, 'subject', 'EARLIER_PUBLIC_KEY_REMAINS_VERIFIABLE');
    assert.equal(f.calls[0], 'exclusive-window');
    assert.match(f.calls.find(sql => sql.startsWith('SELECT root_reference_id')), /FOR UPDATE/);
  });

  it('publishes no prepared material on root-audit or COMMIT failure', async function () {
    for (const stage of ['failRead', 'failCommit']) {
      const f = preparationFixture(); f[stage]();
      await assert.rejects(f.prepare(A), /synthetic/);
      assert.equal(f.state.keys.length, 0); assert.equal(f.state.rootVerifiers, null); assert.equal(f.state.subjects.size, 0);
      if (f.rootBytes()) assert(f.rootBytes().every(v => v === 0));
    }
  });
});
