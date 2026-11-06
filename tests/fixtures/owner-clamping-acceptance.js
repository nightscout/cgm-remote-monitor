'use strict';

// Real PostgreSQL and HTTP acceptance choreography, enabled only by the owning
// authority suite. No production preview configuration selects ownerPolicy.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { Client } = require('pg');
const { run } = require('../../lib/migrations/postgres');
const authorityCatalogue = require('../../lib/tenant-authorization/postgres-candidate.json');
const accessCatalogue = require('../../lib/tenant-authorization/access-candidate.json');
const legacyFor = require('../../lib/tenant-authorization/postgres');
const accessFor = require('../../lib/tenant-authorization/access-postgres');
const { createVerifier, createAuthorizer } = require('../../lib/tenant-authorization/access-token');
const { catalogueDigest } = require('../../lib/subject-admin/owner-policy');

const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const SUBJECT = 'synthetic_subject';
const permission = 'api:entries:read';
const catalogue = [permission, 'api:entries:create'];
const namespace = 'owner_clamping_test';
const accessNamespace = 'owner_clamping_access_test';
const policy = namespace + '.tenant_owner_policy';
const roles = namespace + '.tenant_authorization_roles';

module.exports = async function acceptance ({ admin, adminURI, appURI, appRole }) {
  assert.match(appRole, /^[a-z_]+$/);
  await run('up', { direct: true, connectionString: adminURI, namespace, catalogue: authorityCatalogue });
  await run('up', { direct: true, connectionString: adminURI, namespace: accessNamespace, catalogue: accessCatalogue });
  await admin.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`);
  await admin.query(`GRANT USAGE ON SCHEMA ${namespace},${accessNamespace} TO ${appRole}`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${namespace},${accessNamespace} TO ${appRole}`);
  for (const tenant of [D, E]) {
    await admin.query(`INSERT INTO ${namespace}.tenant_authorization_config (tenant_id,anonymous_roles) VALUES ($1,ARRAY['denied'])`, [tenant]);
    await admin.query(`INSERT INTO ${roles} (tenant_id,name,permissions) VALUES ($1,'reader',$2)`, [tenant, [permission]]);
    await admin.query(`INSERT INTO ${namespace}.tenant_authorization_subjects (tenant_id,subject_id,display_name) VALUES ($1,$2,'Synthetic Subject')`, [tenant, SUBJECT]);
    await admin.query(`INSERT INTO ${namespace}.tenant_authorization_subject_roles VALUES ($1,$2,'reader')`, [tenant, SUBJECT]);
    await admin.query(`INSERT INTO ${policy} (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)`,
      [tenant, catalogueDigest(catalogue), tenant === D ? catalogue : []]);
    await admin.query(`INSERT INTO ${accessNamespace}.access_tenants VALUES ($1,true)`, [tenant]);
    await admin.query(`INSERT INTO ${accessNamespace}.access_credentials VALUES ($1,'credential',$2,1,true)`, [tenant, SUBJECT]);
    await admin.query(`INSERT INTO ${accessNamespace}.access_sessions VALUES ($1,'session',$2,'credential',1,$3,true,'data')`,
      [tenant, SUBJECT, Math.floor(Date.now() / 1000) + 3600]);
    await admin.query(`INSERT INTO ${accessNamespace}.access_keys VALUES ($1,'key1','data',true)`, [tenant]);
  }
  const selected = { ownerPolicy: { catalogue } };
  const legacy = [], local = [];
  let server, closed = false;
  try {
    for (let i = 0; i < 2; i++) {
      legacy.push(await legacyFor({ connectionString: appURI, namespace, ...selected }));
      local.push(await accessFor({ connectionString: appURI, namespace: accessNamespace, authorityNamespace: namespace, ...selected }));
    }
  } catch (error) {
    await Promise.all(legacy.map(reader => reader.close()).concat(local.map(reader => reader.close())));
    throw error;
  }
  const principal = { kind: 'subject', subjectId: SUBJECT };
  const claims = tenant => ({ tid: tenant, sub: SUBJECT, sid: 'session', kid: 'key1', purpose: 'data' });
  const ask = (worker, tenant = D) => legacy[worker].authorize({ tenant, principal, permission });
  async function effective (worker = 0, tenant = D) {
    const snapshot = await legacy[worker].subjectSnapshot({ tenant, principal });
    return [await ask(worker, tenant), snapshot.permissionGroups.flat().includes(permission),
      (await local[worker].snapshot(claims(tenant))).allows(permission)];
  }
  async function ceiling (values) { await admin.query(`UPDATE ${policy} SET ceiling=$2 WHERE tenant_id=$1`, [D, values]); }
  async function invalid () {
    for (let worker = 0; worker < 2; worker++) {
      await assert.rejects(ask(worker), { code: 'TENANT_AUTHORITY_INVALID' });
      await assert.rejects(legacy[worker].subjectSnapshot({ tenant: D, principal }), { code: 'TENANT_AUTHORITY_INVALID' });
      await assert.rejects(local[worker].snapshot(claims(D)), { code: 'ACCESS_AUTHORITY_INVALID' });
    }
  }
  async function policyCalls () {
    const result = await admin.query(`SELECT query,calls::text FROM pg_stat_statements
      WHERE query LIKE '%op.catalogue_digest AS owner_catalogue_digest%'
        AND query LIKE '%owner_clamping_test%tenant_owner_policy%'`);
    const all = await admin.query(`SELECT coalesce(sum(calls),0)::text AS calls FROM pg_stat_statements
      WHERE userid=to_regrole($1) AND query LIKE '%owner_clamping_%'`, [appRole]);
    return { rows: result.rows, count: result.rows.reduce((sum, row) => sum + Number(row.calls), 0),
      allCount: Number(all.rows[0].calls) };
  }
  async function close () {
    if (closed) return;
    closed = true;
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.all(legacy.map(reader => reader.close()).concat(local.map(reader => reader.close())));
  }
  return {
    close,
    async authorityOutage () {
      for (let worker = 0; worker < 2; worker++) {
        await assert.rejects(ask(worker), { code: 'TENANT_AUTHORITY_UNAVAILABLE' });
        await assert.rejects(local[worker].snapshot(claims(D)), { code: 'ACCESS_AUTHORITY_UNAVAILABLE' });
      }
    },
    async currentSnapshots () {
      const before = await policyCalls();
      assert.deepEqual(await effective(), [true, true, true]);
      const after = await policyCalls();
      assert.equal(after.count - before.count, 3, 'one policy-bearing SQL statement per protected authority operation');
      assert.equal(after.allCount - before.allCount, 3, 'no additional authority/schema SELECT outside those snapshots');
      for (const row of after.rows) {
        assert.match(row.query, /LEFT JOIN .*tenant_owner_policy/s);
        assert.match(row.query, /tenant_authorization_roles/);
      }
      assert.deepEqual(await effective(1), [true, true, true]);
      const stored = (await admin.query(`SELECT permissions FROM ${roles} WHERE tenant_id=$1`, [D])).rows;
      await ceiling([]);
      try {
        assert.deepEqual(await effective(1), [false, false, false]);
        assert.deepEqual(await effective(0), [false, false, false]);
        assert.deepEqual((await admin.query(`SELECT permissions FROM ${roles} WHERE tenant_id=$1`, [D])).rows, stored);
      } finally { await ceiling(catalogue); }
      assert.deepEqual(await effective(1), [true, true, true]);
      assert.deepEqual(await effective(1, E), [false, false, false]);
    },
    async policyRefusals () {
      const saved = (await admin.query(`SELECT catalogue_digest,ceiling FROM ${policy} WHERE tenant_id=$1`, [D])).rows[0];
      try {
        await admin.query(`DELETE FROM ${policy} WHERE tenant_id=$1`, [D]);
        await invalid();
        await admin.query(`INSERT INTO ${policy} (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)`, [D, saved.catalogue_digest, saved.ceiling]);
        await admin.query(`UPDATE ${policy} SET catalogue_digest=$2 WHERE tenant_id=$1`, [D, '0'.repeat(64)]);
        await invalid();
        await admin.query(`UPDATE ${policy} SET catalogue_digest=$2 WHERE tenant_id=$1`, [D, saved.catalogue_digest]);
        for (const values of [['api:*:read'], ['api:entries:invented'], [permission, permission]]) {
          await ceiling(values);
          await invalid();
        }
      } finally {
        await admin.query(`INSERT INTO ${policy} (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,$3)
          ON CONFLICT (tenant_id) DO UPDATE SET catalogue_digest=EXCLUDED.catalogue_digest,ceiling=EXCLUDED.ceiling`,
        [D, saved.catalogue_digest, saved.ceiling]);
      }
      for (const kind of ['root', 'anonymous']) {
        await assert.rejects(legacy[0].authorize({ tenant: D, principal: { kind }, permission }), { code: 'TENANT_AUTHORITY_PRINCIPAL_INVALID' });
      }
      try {
        await admin.query(`UPDATE ${roles} SET permissions=ARRAY['api:*:read'] WHERE tenant_id=$1`, [D]);
        await invalid();
      } finally { await admin.query(`UPDATE ${roles} SET permissions=$2 WHERE tenant_id=$1`, [D, [permission]]); }
      try {
        await admin.query(`UPDATE ${namespace}.tenant_authorization_config SET anonymous_roles=ARRAY['readable'] WHERE tenant_id=$1`, [D]);
        await invalid();
      } finally { await admin.query(`UPDATE ${namespace}.tenant_authorization_config SET anonymous_roles=ARRAY['denied'] WHERE tenant_id=$1`, [D]); }
      assert.deepEqual(await effective(), [true, true, true]);
    },
    async policySecurity () {
      const direct = new Client({ connectionString: appURI });
      await direct.connect();
      try {
        await direct.query('BEGIN');
        await direct.query("SELECT set_config('app.current_tenant_id',$1,true)", [D]);
        assert.deepEqual((await direct.query(`SELECT tenant_id::text FROM ${policy}`)).rows, [{ tenant_id: D }]);
        await assert.rejects(direct.query(`UPDATE ${policy} SET ceiling=ARRAY[]::text[]`), { code: '42501' });
      } finally { await direct.query('ROLLBACK'); await direct.end(); }
      for (const sql of [`ALTER TABLE ${policy} DISABLE ROW LEVEL SECURITY`, `GRANT UPDATE(ceiling) ON ${policy} TO ${appRole}`]) {
        await admin.query(sql);
        try {
          await assert.rejects(legacyFor({ connectionString: appURI, namespace, ...selected }), { code: 'TENANT_AUTHORITY_UNSAFE' });
          await assert.rejects(accessFor({ connectionString: appURI, namespace: accessNamespace, authorityNamespace: namespace, ...selected }), { code: 'ACCESS_AUTHORITY_UNSAFE' });
        } finally {
          await admin.query(`ALTER TABLE ${policy} ENABLE ROW LEVEL SECURITY`);
          await admin.query(`ALTER TABLE ${policy} FORCE ROW LEVEL SECURITY`);
          await admin.query(`REVOKE UPDATE(ceiling) ON ${policy} FROM ${appRole}`);
        }
      }
      await admin.query(`REVOKE SELECT ON ${policy} FROM ${appRole}`);
      try {
        await assert.rejects(ask(1), { code: 'TENANT_AUTHORITY_UNAVAILABLE' });
        await assert.rejects(local[1].snapshot(claims(D)), { code: 'ACCESS_AUTHORITY_UNAVAILABLE' });
      } finally { await admin.query(`GRANT SELECT ON ${policy} TO ${appRole}`); }
      assert.deepEqual(await effective(1), [true, true, true]);
    },
    async newTokenHTTP () {
      const keys = new Map([D, E].map(tenant => [tenant, crypto.generateKeyPairSync('ed25519')]));
      const now = Math.floor(Date.now() / 1000);
      const verifier = createVerifier({ issuer: 'synthetic-issuer', audience: 'synthetic-data', purpose: 'data', maxLifetimeSeconds: 600,
        resolveKey: (tenant, kid) => ({ tenant, kid, issuer: 'synthetic-issuer', purpose: 'data', publicKey: keys.get(tenant).publicKey }) });
      const authorizers = local.map(reader => createAuthorizer({ verifyToken: verifier, snapshot: reader.snapshot }));
      const token = tenant => {
        const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'ns-access+jwt', kid: 'key1' })).toString('base64url');
        const body = Buffer.from(JSON.stringify({ iss: 'synthetic-issuer', aud: 'synthetic-data', tid: tenant, purpose: 'data',
          sub: SUBJECT, sid: 'session', cv: 1, iat: now, nbf: now, exp: now + 300 })).toString('base64url');
        const input = header + '.' + body;
        return input + '.' + crypto.sign(null, Buffer.from(input), keys.get(tenant).privateKey).toString('base64url');
      };
      const app = express();
      app.get('/probe', async (req, res) => {
        try {
          const result = await authorizers[Number(req.get('x-worker'))]({ token: req.get('authorization')?.slice(7),
            tenant: req.get('host') === 'one.example.test' ? D : E, permissions: [permission] });
          res.json(result);
        } catch (error) { res.status(error.code === 'AUTHORITY_FORBIDDEN' ? 403 : error.code?.startsWith('TOKEN_') ? 401 : 503).json({ error: error.code }); }
      });
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      const get = (worker, host = 'one.example.test') => request(server).get('/probe').set('Host', host)
        .set('x-worker', String(worker)).set('Authorization', 'Bearer ' + token(D));
      assert.equal((await get(0).expect(200)).body.subject, SUBJECT);
      assert.equal((await get(1).expect(200)).body.tenant, D);
      await ceiling([]);
      try { await get(1).expect(403); await get(0).expect(403); }
      finally { await ceiling(catalogue); }
      await get(1).expect(200);
      await get(0, 'two.example.test').expect(401);
      await admin.query(`REVOKE SELECT ON ${policy} FROM ${appRole}`);
      try { await get(1).expect(503); }
      finally { await admin.query(`GRANT SELECT ON ${policy} TO ${appRole}`); }
      await get(1).expect(200);
      const stored = await admin.query(`SELECT permissions FROM ${roles} WHERE tenant_id=$1`, [D]);
      assert.deepEqual(stored.rows, [{ permissions: [permission] }]);
    }
  };
};
