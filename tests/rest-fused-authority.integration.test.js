'use strict';

// Native PostgreSQL, real operation window, real lower connection, real legacy
// verifier store, real authorization store, real data access and legacy entries
// router. An authorized DATA request reads credential verifiers and current
// authorization in one tenant transaction; every read is still a current read.
// Synthetic tenants and credentials only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express'), request = require('supertest');
const pg = require('pg');
const { optInSuite } = require('./support/opt-in');
const fixture = require('./fixtures/operation-window-minimum-native');

const DOMAINS = ['entries', 'treatments', 'devicestatus', 'profile', 'food', 'activity'];
const GRANTS = DOMAINS.flatMap(d => ['read', 'create', 'update', 'delete'].map(a => 'api:' + d + ':' + a));
const VERIFIER = /c\.root_verifiers, c\.root_version/;
const AUTHORITY = /SELECT c\.anonymous_roles, s\.subject_id/;
const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');

optInSuite(process.env.NS_REST_FUSED_AUTHORITY_NATIVE === '1', 'NS_REST_FUSED_AUTHORITY_NATIVE=1')('fused credential and authority transaction (native)', function () {
  this.timeout(180000);
  const f = fixture.create();
  const tokens = {}, secrets = {};
  let legacy, authority, verifiers, graph, original, sent = null;
  // Driver-level statement tap for this process: every pool and client, counted
  // only while a request runs. Restored in after().
  function tap (fn) {
    sent = [];
    return Promise.resolve().then(fn).then(result => { const seen = sent; sent = null; return { result, seen }; },
      error => { sent = null; throw error; });
  }
  async function seed () {
    const { prepare } = require('../lib/secrets/legacy-verifiers');
    await f.admin(async admin => {
      for (const tenant of [f.A, f.B]) {
        const root = Buffer.from('synthetic-root-' + tenant), prepared = prepare(root, [{ subjectId: 'writer', tokenPrefix: 'writer' }]);
        await admin.query(`INSERT INTO "${f.ns.legacy}".legacy_credential_config (tenant_id,root_reference_id,root_verifiers,verifier_root_reference_id,root_version) VALUES ($1,'root',$2,'root',1)`, [tenant, prepared.rootVerifiers]);
        await admin.query(`INSERT INTO "${f.ns.legacy}".legacy_credential_subjects (tenant_id,subject_id,token_prefix,verifiers,verifier_token_prefix,credential_version) VALUES ($1,'writer','writer',$2,'writer',1)`, [tenant, prepared.subjects[0].verifiers]);
        await admin.query(`INSERT INTO "${f.ns.authorization}".tenant_authorization_config (tenant_id,anonymous_roles) VALUES ($1, ARRAY['denied'])`, [tenant]);
        await admin.query(`INSERT INTO "${f.ns.authorization}".tenant_authorization_subjects (tenant_id,subject_id,display_name) VALUES ($1,'writer','synthetic writer')`, [tenant]);
        await admin.query(`INSERT INTO "${f.ns.authorization}".tenant_authorization_roles (tenant_id,name,permissions) VALUES ($1,'writer',$2)`, [tenant, GRANTS]);
        await admin.query(`INSERT INTO "${f.ns.authorization}".tenant_authorization_subject_roles (tenant_id,subject_id,role_name) VALUES ($1,'writer','writer')`, [tenant]);
        const rootSha1 = sha1(root);
        tokens[tenant] = 'writer-' + sha1(rootSha1 + 'writer').slice(0, 16);
        secrets[tenant] = rootSha1;
      }
    });
  }
  function application ({ authorityStore = authority, credentials = verifiers } = {}) {
    const access = require('../lib/server/tenant-app/data-access')({ authority: authorityStore, readConnection: f.lower, secrets: credentials,
      verifierContext: async tenant => ({ tenant, consumer: 'api' }), collections: DOMAINS, legacyCollections: DOMAINS });
    const unavailable = async () => { throw new Error('outside fixture'); };
    return require('../lib/server/tenant-app').createTenantApp({ resolver: { resolve: async req => req.hostname === 'a.example.test' ? f.A : f.B },
      verifyCredential: unavailable, authorizeRequest: unavailable, tenantSettings: { read: unavailable, replace: unavailable, rollback: unavailable },
      subjectPolicy: { read: unavailable, replace: unavailable }, dataRouter: express.Router(), legacyRouter: graph.legacyRouter, dataAccess: access,
      operationWindow: f.window });
  }
  const host = tenant => tenant === f.A ? 'a.example.test' : 'b.example.test';
  let seq = 0;
  const at = Date.now() - 60000;
  const get = (app, tenant = f.A, carrier = 'token') => {
    const call = request(app).get('/api/v1/entries/sgv.json?count=1' + (carrier === 'token' ? '&token=' + tokens[tenant] : '')).set('Host', host(tenant));
    return carrier === 'token' ? call : call.set('api-secret', secrets[tenant]);
  };
  const post = (app, tenant = f.A, carrier = 'token') => {
    seq++;
    const call = request(app).post('/api/v1/entries' + (carrier === 'token' ? '?token=' + tokens[tenant] : '')).set('Host', host(tenant))
      .send([{ type: 'sgv', sgv: 100 + seq % 50, date: at + seq, dateString: new Date(at + seq).toISOString(), device: 'synthetic' }]);
    return carrier === 'token' ? call : call.set('api-secret', secrets[tenant]);
  };
  const count = (seen, pattern) => seen.filter(text => pattern.test(text)).length;
  function oneAuthorityTransaction (seen, expectedTransactions) {
    assert.equal(count(seen, /^BEGIN/), expectedTransactions, 'ONE_TRANSACTION_FOR_VERIFIER_AND_AUTHORITY');
    assert.equal(count(seen, VERIFIER), 1, 'CURRENT_VERIFIER_READ_EVERY_REQUEST');
    assert.equal(count(seen, AUTHORITY), 1, 'CURRENT_AUTHORITY_READ_EVERY_REQUEST');
    const begin = seen.findIndex(text => /^BEGIN/.test(text)), commit = seen.indexOf('COMMIT');
    assert(begin < seen.findIndex(text => VERIFIER.test(text)) && seen.findIndex(text => AUTHORITY.test(text)) < commit,
      'VERIFIER_AND_AUTHORITY_INSIDE_FIRST_TRANSACTION');
  }
  const refusedWithoutReads = async (app, tenant, carrier) => {
    const { result, seen } = await tap(() => get(app, tenant, carrier));
    assert.notEqual(result.status, 200, 'REFUSED');
    assert.equal(count(seen, VERIFIER) + count(seen, AUTHORITY) + count(seen, /FROM "[a-z_]+"\."entries"/), 0, 'NO_TENANT_READ_AFTER_REFUSAL');
    return result;
  };

  before(async () => {
    await f.start();
    original = pg.Client.prototype.query;
    pg.Client.prototype.query = function (...args) {
      if (sent) sent.push(typeof args[0] === 'string' ? args[0] : args[0]?.text);
      return original.apply(this, args);
    };
    await seed();
    legacy = await require('../lib/secrets/legacy-postgres')({ connectionString: f.urls.api, namespace: f.ns.legacy,
      localVerification: true, verificationConnection: f.lower });
    authority = await require('../lib/tenant-authorization/postgres')({ connectionString: f.urls.api, namespace: f.ns.authorization, connection: f.lower });
    verifiers = require('../lib/secrets/legacy-verifiers').create({ read: legacy.readVerification, usesConnection: legacy.usesConnection,
      verifyToken: () => { throw Object.assign(new Error('SECRETS_TOKEN_INVALID'), { code: 'SECRETS_TOKEN_INVALID' }); } });
    const environment = require('../lib/server/tenant-app/environment');
    graph = await require('../lib/server/serve/preview-domains')({ config: { domains: DOMAINS, legacyEnabled: true, contextEnabled: true,
      bindings: new Map([[f.A, {}], [f.B, {}]]), environments: new Map([f.A, f.B].map(t => [t, environment()])),
      namespaces: Object.fromEntries(DOMAINS.map(d => [d, f.ns[d]])) }, connection: f.lower, exchange: async () => null });
  });
  after(async () => {
    try { if (original) pg.Client.prototype.query = original; }
    finally {
      try { if (legacy) await legacy.close(); }
      finally { try { if (authority) await authority.close(); } finally { await f.close(); } }
    }
  });

  it('reads verifiers and current authority in one tenant transaction for authorized GET and POST', async function () {
    const app = application();
    for (const tenant of [f.A, f.B]) for (const carrier of ['token', 'secret']) { await post(app, tenant, carrier).expect(200); await get(app, tenant, carrier).expect(200); }
    const report = {};
    for (const carrier of ['token', 'secret']) {
      const read = await tap(() => get(app, f.A, carrier).expect(200));
      oneAuthorityTransaction(read.seen, 1);
      assert.equal(count(read.seen, /FROM "[a-z_]+"\."entries"/), 1, 'JOINED_CLINICAL_READ');
      const write = await tap(() => post(app, f.B, carrier).expect(200));
      oneAuthorityTransaction(write.seen, 2);
      report[carrier] = { get: read.seen.length, post: write.seen.length };
    }
    console.log('REST_FUSED_STATEMENTS ' + JSON.stringify(report));
  });

  it('control: separate verifier transaction restores a second acquisition and fails the budget', async function () {
    // The verifier store no longer declares the request connection: data access
    // keeps the prior separate verifier transaction on the same pool.
    const { usesConnection, ...separate } = verifiers;
    assert.equal(typeof usesConnection, 'function');
    const app = application({ credentials: separate });
    const { seen } = await tap(() => get(app, f.A).expect(200));
    assert.equal(count(seen, /^BEGIN/), 2, 'BROKEN_FUSION_WAS_EXERCISED');
    assert.throws(() => oneAuthorityTransaction(seen, 1), /ONE_TRANSACTION_FOR_VERIFIER_AND_AUTHORITY/);
  });

  async function revocation (app) {
    await get(app).expect(200); await post(app).expect(200);
    await f.sql(`DELETE FROM "${f.ns.authorization}".tenant_authorization_subject_roles WHERE tenant_id=$1 AND subject_id='writer'`, [f.A]);
    try {
      return { read: (await get(app)).status, write: (await post(app)).status, other: (await get(app, f.B)).status };
    } finally {
      await f.sql(`INSERT INTO "${f.ns.authorization}".tenant_authorization_subject_roles (tenant_id,subject_id,role_name) VALUES ($1,'writer','writer')`, [f.A]);
    }
  }
  it('honours a revoked subject role on the very next request, then the regrant', async function () {
    const app = application();
    assert.deepEqual(await revocation(app), { read: 401, write: 401, other: 200 });
    await get(app).expect(200); await post(app).expect(200);
  });
  it('control: a retained prior allow serves the revoked subject and fails the revocation control', async function () {
    const remembered = new Map();
    const stale = Object.freeze({ ...authority, async subjectAuthorizationSnapshot (operation) {
      const key = operation.tenant + '/' + operation.principal.subjectId;
      if (!remembered.has(key)) remembered.set(key, await authority.subjectAuthorizationSnapshot(operation));
      return remembered.get(key);
    } });
    const outcome = await revocation(application({ authorityStore: stale }));
    assert.deepEqual(outcome, { read: 200, write: 200, other: 200 }, 'STALE_ALLOW_WAS_EXERCISED');
    assert.throws(() => assert.deepEqual(outcome, { read: 401, write: 401, other: 200 }), /deepStrictEqual|Expected values/);
  });

  it('honours credential and root rotation on the very next request', async function () {
    const app = application();
    const { prepare } = require('../lib/secrets/legacy-verifiers');
    const rotated = prepare(Buffer.from('synthetic-rotated-root-a'), [{ subjectId: 'writer', tokenPrefix: 'writer' }]);
    const [config] = (await f.sql(`SELECT root_verifiers FROM "${f.ns.legacy}".legacy_credential_config WHERE tenant_id=$1`, [f.A])).rows;
    const [subject] = (await f.sql(`SELECT verifiers FROM "${f.ns.legacy}".legacy_credential_subjects WHERE tenant_id=$1`, [f.A])).rows;
    await get(app, f.A, 'token').expect(200); await get(app, f.A, 'secret').expect(200);
    await f.sql(`UPDATE "${f.ns.legacy}".legacy_credential_subjects SET verifiers=$2, credential_version=credential_version+1 WHERE tenant_id=$1`, [f.A, rotated.subjects[0].verifiers]);
    await f.sql(`UPDATE "${f.ns.legacy}".legacy_credential_config SET root_verifiers=$2, root_version=root_version+1 WHERE tenant_id=$1`, [f.A, rotated.rootVerifiers]);
    try {
      assert.equal((await get(app, f.A, 'token')).status, 401, 'ROTATED_SUBJECT_TOKEN_REFUSED');
      assert.equal((await get(app, f.A, 'secret')).status, 401, 'ROTATED_ROOT_SECRET_REFUSED');
      await get(app, f.B, 'token').expect(200);
    } finally {
      await f.sql(`UPDATE "${f.ns.legacy}".legacy_credential_subjects SET verifiers=$2, credential_version=1 WHERE tenant_id=$1`, [f.A, subject.verifiers]);
      await f.sql(`UPDATE "${f.ns.legacy}".legacy_credential_config SET root_verifiers=$2, root_version=1 WHERE tenant_id=$1`, [f.A, config.root_verifiers]);
    }
    await get(app, f.A, 'token').expect(200); await get(app, f.A, 'secret').expect(200);
  });

  it('refuses a maintenance-locked, suspended or regenerated tenant before any fused read while the other tenant continues', async function () {
    const app = application();
    await get(app).expect(200);
    await f.admin(async holder => {
      assert.equal((await holder.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [f.locks[0].key])).rows[0].held, true);
      for (const carrier of ['token', 'secret']) {
        const refused = await refusedWithoutReads(app, f.A, carrier);
        assert.equal(refused.status, 503); assert.deepEqual(refused.body, { error: 'AUTHORITY_UNAVAILABLE' });
      }
      await get(app, f.B).expect(200);
    });
    await get(app).expect(200);
    const window = f.control('tenant_lifecycle_windows');
    // The warm participant still accepts; the fused transaction's own fence refuses.
    const changes = { suspended: ["phase='suspended',claim_id=$2,artifact_digest=$3", [crypto.randomUUID(), 'a'.repeat(64)]],
      regenerated: ['generation=generation+1', []] };
    for (const [change, [assignment, values]] of Object.entries(changes)) {
      const [before] = (await f.sql(`SELECT phase, generation FROM ${window} WHERE tenant_id=$1`, [f.A])).rows;
      await f.sql(`UPDATE ${window} SET ${assignment} WHERE tenant_id=$1`, [f.A, ...values]);
      try {
        for (const carrier of ['token', 'secret']) {
          const refused = await refusedWithoutReads(app, f.A, carrier);
          assert.equal(refused.status, 503, change); assert.deepEqual(refused.body, { error: 'AUTHORITY_UNAVAILABLE' });
        }
        await get(app, f.B).expect(200);
      } finally { await f.sql(`UPDATE ${window} SET phase=$2, generation=$3, claim_id=NULL, artifact_digest=NULL WHERE tenant_id=$1`, [f.A, before.phase, before.generation]); }
      await get(app).expect(200);
    }
  });
});
