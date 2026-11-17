'use strict';

const assert = require('node:assert/strict');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_OPERATION_LIFETIME_DOCKER_TEST === '1', 'NS_OPERATION_LIFETIME_DOCKER_TEST=1')(
  'tenant transaction admission across actual API replicas', function () {
    this.timeout(120000);
    const f = createFixture();
    const [A, B] = f.base.tenants; let a, b;
    const call = (id, tenant, method, route, token) => f.base.http(f.current.get(id), tenant, method, route, token);
    before(async () => { await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B); });
    after(() => f.cleanup());
    it('preserves fresh current authorization and cross-tenant denial', async () => {
      await f.withAdmin(client => client.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['denied'] WHERE tenant_id=$1 AND name='viewer'", [A]));
      try {
        for (const id of ['api-1', 'api-2']) {
          assert.equal((await call(id, A, 'GET', '/api/v3/entries', a)).status, 403);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', a)).status, 401);
          assert.equal((await call(id, B, 'GET', '/api/v3/entries', b)).status, 200);
        }
      } finally { await f.withAdmin(client => client.query("UPDATE preview_auth.tenant_authorization_roles SET permissions=ARRAY['api:entries:read','api:entries:create','api:entries:update'] WHERE tenant_id=$1 AND name='viewer'", [A])); }
    });
    it('refuses a clinical-write grant on its metadata-only lifetime identity', async () => {
      await f.withAdmin(client => client.query('GRANT UPDATE ON preview_clock.tenant_write_clock TO preview_lifetime_api'));
      try { await assert.rejects(f.restore(async () => assert.fail('unknown lifetime writer must not restore')), { code: 'RESTORE_COHORT_UNKNOWN_BACKEND' }); }
      finally { await f.withAdmin(client => client.query('REVOKE UPDATE ON preview_clock.tenant_write_clock FROM preview_lifetime_api')); }
    });
  });
