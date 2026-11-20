'use strict';

// Native registry provisioning plus the existing PostgreSQL human session
// engine. Human signing keys are derived from the deployment signing secret
// (decision deployment-signing-secret): provisioning writes their public keys,
// the issuer signs in process, no Vault signing policy exists. Synthetic only.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const scope = require('../lib/storage/tenant-scope');
const connect = require('../lib/storage/postgres-connection');
const { createLab, enabled } = require('./fixtures/tenant-registry-lab');
const { createProvisioning, HUMAN_KIDS } = require('../lib/tenant-registry/provision');
const { createRegistryHumanAccess } = require('../lib/human-session/registry-access');
const { createEngine } = require('../lib/human-session/engine');
const { optInSuite } = require('./support/opt-in');

optInSuite(enabled(), 'disposable NS_TEST_POSTGRES_ADMIN_URI and NS_VAULT_DOCKER_TEST=1')('registry human signing and durable sessions (native PostgreSQL and Vault)', function () {
  this.timeout(180000);
  it('RH_NATIVE: provisioned derived human keys sign both session purposes, current key revocation and wrong tenant refuse', async function () {
    const previous = scope.getTenancyMode(), saved = {};
    const names = ['HUMAN_SESSION_NATIVE_RESERVED', 'HUMAN_SESSION_PG_ADMIN_URL', 'HUMAN_SESSION_PG_APP_URL'];
    for (const name of names) saved[name] = process.env[name];
    let lab, provisioning, connection, native, role;
    try {
      scope.setTenancyMode('multi'); lab = await createLab();
      const tenant = randomUUID(), other = randomUUID();
      provisioning = createProvisioning(lab.provisioningOptions());
      assert.equal((await provisioning.provision({ id: tenant, hosts: ['human.example.test'] })).outcome, 'created');
      assert.equal((await provisioning.provision({ id: other, hosts: ['other.example.test'] })).outcome, 'created');
      connection = await connect({ connectionString: lab.urls.api, max: 1 });
      const reader = require('../lib/tenant-registry/postgres').create({ connection, namespace: lab.namespaces.registry });
      const access = createRegistryHumanAccess({ source: {
        OIDC_ACCESS_CONFIG: JSON.stringify({ version: 1, registry: true, issuer: 'https://human.example.test', audiences: { data: 'human-data', management: 'human-management' } }),
        ...require('./fixtures/signing-secret').env()
      }, registry: { maxTenants: 2, entry: reader.entry } });
      const acceptedKeys = (await lab.admin.query(`SELECT kid,purpose,active FROM "${lab.namespaces.access}".access_keys WHERE tenant_id=$1 AND kid=ANY($2::text[])`,
        [tenant, Object.values(HUMAN_KIDS)])).rows;
      assert.equal(acceptedKeys.length, 2);
      role = 'trl_human_' + lab.id;
      const password = randomBytes(18).toString('hex');
      await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
      const app = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI); app.username = role; app.password = password;
      process.env.HUMAN_SESSION_NATIVE_RESERVED = '1'; process.env.HUMAN_SESSION_PG_ADMIN_URL = process.env.NS_TEST_POSTGRES_ADMIN_URI;
      process.env.HUMAN_SESSION_PG_APP_URL = app.toString();
      const issuer = 'https://idp.example.test', subject = 'synthetic-provider-subject';
      native = await require('./fixtures/human-native-stores').createNativeStore({ kind: 'postgres', tenant, issuer,
        providerSubject: subject, consumer: 'oidc', acceptedKeys });
      const engine = createEngine({ store: native.store, access });
      const proof = { issuer, subject, authenticatedAt: Math.floor(Date.now() / 1000) };
      for (const purpose of ['data', 'management']) {
        const issued = await engine.login({ tenant, identity: proof, purpose });
        const claims = await access.verify({ tenant, token: issued.token });
        assert.equal(claims.kid, HUMAN_KIDS[purpose]);
        assert.equal((await engine.authenticate({ tenant, token: issued.token, purpose })).session.purpose, purpose);
        await assert.rejects(engine.authenticate({ tenant: other, token: issued.token, purpose }), { code: 'HUMAN_SESSION_REFUSED' });
        await lab.admin.query(`UPDATE "${native.resources.access}".access_keys SET active=false WHERE tenant_id=$1 AND kid=$2`, [tenant, HUMAN_KIDS[purpose]]);
        await assert.rejects(engine.authenticate({ tenant, token: issued.token, purpose }), { code: 'HUMAN_AUTHORITY_REFUSED' });
        await lab.admin.query(`UPDATE "${native.resources.access}".access_keys SET active=true WHERE tenant_id=$1 AND kid=$2`, [tenant, HUMAN_KIDS[purpose]]);
        assert.equal((await engine.authenticate({ tenant, token: issued.token, purpose })).session.purpose, purpose);
      }
      // The other tenant's key is its own derivation: a token issued for it never verifies on this tenant (D14).
      const foreign = await access.issue({ tenant: other, purpose: 'data', subject: 'synthetic', session: 'synthetic', credentialVersion: 1,
        issuedAt: proof.authenticatedAt, expiresAt: proof.authenticatedAt + 600 });
      await assert.rejects(access.verify({ tenant, token: foreign }), { code: 'HUMAN_SESSION_REFUSED' });
    } finally {
      if (native) await native.close();
      if (connection) await connection.end();
      if (provisioning) await provisioning.close();
      if (lab && role) { await lab.admin.query(`DROP OWNED BY "${role}"`); await lab.admin.query(`DROP ROLE "${role}"`); }
      if (lab) await lab.close();
      for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      scope.setTenancyMode(previous);
    }
  });
});
