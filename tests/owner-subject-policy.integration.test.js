'use strict';

// covers: lib/subject-admin/owner-policy.js, lib/subject-admin/postgres.js, lib/server/subject-management-app.js, lib/server/tenant-app/root-admin.js
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { createFixture, A, B, TARGET, CATALOGUE } = require('./fixtures/owner-subject-policy');
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_OWNER_SUBJECT_POLICY_DOCKER_TEST === '1',
  'NS_OWNER_SUBJECT_POLICY_DOCKER_TEST=1')('owner subject proposed-grant policy (owned PostgreSQL HTTP)', function () {
    this.timeout(90000);
    let f;
    before(async () => { f = await createFixture(); });
    beforeEach(async () => { await f.reset(); });
    after(async () => { if (f) await f.close(); });

    async function refused (body, status = 403, options) {
      const before = await f.snapshot();
      const response = await f.http(body, options);
      const after = await f.snapshot();
      assert.equal(response.status, status, JSON.stringify(response.body) +
        '; persistent effects changed: ' + !isDeepStrictEqual(after, before));
      assert.deepEqual(after, before, 'a refusal must preserve every target/link/credential/audit row in both tenants');
      return response;
    }

    it('persists the exact allowed roles/metadata with one audit and leaves the foreign tenant unchanged', async function () {
      const foreign = await f.snapshot(B);
      const body = { ...f.proposal(['reader', 'uploader']), notes: 'owner note', created_at: '2026-03-01T00:00:00.000Z' };
      const response = await f.http(body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, { subjectId: TARGET, name: body.name, roles: body.roles,
        notes: body.notes, created_at: body.created_at });
      const target = (await f.admin.query('SELECT * FROM ' + f.tables.subjects + ' WHERE tenant_id=$1 AND subject_id=$2', [A, TARGET])).rows[0];
      assert.equal(target.display_name, body.name); assert.equal(target.notes, body.notes);
      const links = (await f.admin.query('SELECT role_name FROM ' + f.tables.links + ' WHERE tenant_id=$1 ORDER BY role_name', [A])).rows;
      assert.deepEqual(links.map(row => row.role_name), ['reader', 'uploader']);
      assert.equal((await f.admin.query('SELECT token_prefix FROM ' + f.tables.credentials + ' WHERE tenant_id=$1', [A])).rows[0].token_prefix, 'allowedown');
      const audit = (await f.admin.query('SELECT * FROM ' + f.tables.audit)).rows;
      assert.equal(audit.length, 1); assert.equal(audit[0].operation, 'update');
      assert.equal(audit[0].principal, 'manager'); assert.equal(audit[0].consumer, 'admin');
      assert.deepEqual(await f.snapshot(B), foreign);
    });

    it('rejects the code-catalogue intersection even if operator and actor lists both contain the outside permission', async function () {
      const wider = CATALOGUE.concat('api:settings:admin');
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET ceiling=$2 WHERE tenant_id=$1', [A, wider]);
      await f.admin.query('UPDATE ' + f.tables.actors + ' SET delegable=$2 WHERE tenant_id=$1', [A, wider]);
      await refused(f.proposal(['outside']));
    });

    it('rejects the current operator-ceiling intersection independently of catalogue and actor delegation', async function () {
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET ceiling=ARRAY[\'api:entries:read\'] WHERE tenant_id=$1', [A]);
      await refused(f.proposal(['uploader']));
    });

    it('rejects the current actor-delegation intersection even when the actor can use that data permission', async function () {
      await f.admin.query('UPDATE ' + f.tables.actors + ' SET delegable=ARRAY[\'api:entries:read\'] WHERE tenant_id=$1', [A]);
      // Data use exists as a provisioned role; it is not delegation authority.
      await f.admin.query('INSERT INTO ' + f.tables.subjects + ' (tenant_id,subject_id,display_name) VALUES ($1,\'manager\',\'Synthetic manager\')', [A]);
      await f.admin.query('INSERT INTO ' + f.tables.links + ' (tenant_id,subject_id,role_name) VALUES ($1,\'manager\',\'uploader\')', [A]);
      await refused(f.proposal(['uploader']));
    });

    it('refuses inactive or non-management actors and never borrows another tenant actor/policy', async function () {
      for (const field of ['active', 'can_update']) {
        await f.admin.query('UPDATE ' + f.tables.actors + ' SET ' + field + '=false WHERE tenant_id=$1', [A]);
        await refused(f.proposal());
        await f.admin.query('UPDATE ' + f.tables.actors + ' SET ' + field + '=true WHERE tenant_id=$1', [A]);
      }
      await refused(f.proposal(), 403, { credential: 'synthetic-wrong-consumer' });
      await f.admin.query('DELETE FROM ' + f.tables.actors + ' WHERE tenant_id=$1', [A]);
      await refused(f.proposal());
      await f.admin.query('DELETE FROM ' + f.tables.policy + ' WHERE tenant_id=$1', [A]);
      await refused(f.proposal());
    });

    it('rejects data/root/foreign authentication and malicious tenant/actor proposal fields without effects', async function () {
      for (const credential of [null, 'synthetic-data', 'synthetic-root', 'synthetic-cross-tenant']) await refused(f.proposal(), 401, { credential });
      for (const extra of [{ tenant: B }, { principal: 'manager' }, { consumer: 'admin' }, { permission: '*' }]) await refused({ ...f.proposal(), ...extra }, 400);
      await refused(f.proposal(), 401, { host: 'two.example.test' });
    });

    it('preserves unknown-role and malformed-body refusal while bounding wildcard roles and catalogue versions while preserving anonymous readable', async function () {
      await refused(f.proposal(['foreign-only']), 400);
      await refused(f.proposal(['reader', 'reader']), 400);
      await refused(f.proposal(['wildcard']));
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET catalogue_digest=$2 WHERE tenant_id=$1', [A, '0'.repeat(64)]);
      await refused(f.proposal());
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET catalogue_digest=$2 WHERE tenant_id=$1', [A, f.digest(CATALOGUE)]);
      await f.admin.query('UPDATE ' + f.tables.config + ' SET anonymous_roles=ARRAY[\'readable\'] WHERE tenant_id=$1', [A]);
      // Adopted readable is an independent read-clamped default, not an owner grant.
      assert.equal((await f.http(f.proposal())).status, 200);
    });

    it('includes concrete status-only defaults in the effective-grant ceiling and preserves metadata omission', async function () {
      await f.admin.query('UPDATE ' + f.tables.config + ' SET anonymous_roles=ARRAY[\'status-only\'] WHERE tenant_id=$1', [A]);
      await refused({ _id: TARGET, name: 'No Roles' });
      const catalogue = CATALOGUE.concat('api:status:read');
      const store = await f.newStore({ ownerPolicy: { catalogue } });
      const { createSubjectAdmin } = require('../lib/subject-admin/component');
      const service = createSubjectAdmin({ store, authorizeManagement: async () => true });
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET catalogue_digest=$2,ceiling=$3 WHERE tenant_id=$1', [A, f.digest(catalogue), catalogue]);
      await f.admin.query('UPDATE ' + f.tables.actors + ' SET delegable=$2 WHERE tenant_id=$1', [A, catalogue]);
      const response = await service.update(f.actor, TARGET, { name: 'No Roles', notes: '' });
      assert.deepEqual(response.roles, []); assert.equal(response.notes, '');
      assert.equal(response.created_at, '2026-01-01T00:00:00.000Z');
    });

    it('allows explicit owner revocation; the writer without an owner policy is not buildable in multi mode', async function () {
      // Adopted subject revoke supersedes the earlier R53 selected DELETE refusal.
      assert.equal((await f.http(undefined, { method: 'delete' })).status, 200);
      // Decision root-may-edit-owner-subjects: one writer in multitenant mode.
      const createStore = require('../lib/subject-admin/postgres');
      for (const options of [{}, { ownerPolicy: undefined }, { ownerPolicy: null }]) {
        await assert.rejects(createStore({ connectionString: f.legacyURI, namespace: f.NS, credentialNamespace: f.CREDENTIAL_NS, ...options }),
          { name: 'TypeError', message: 'Owner policy requires an explicit catalogue' });
      }
      await assert.rejects(createStore({ connectionString: f.legacyURI, namespace: f.NS, credentialNamespace: f.CREDENTIAL_NS, ownerPolicy: {} }),
        { name: 'TypeError', message: 'Owner catalogue requires distinct Shiro permissions' });
      // The earlier writer's privilege shape (no owner rows) cannot pass as either plane.
      for (const plane of ['owner', 'root']) {
        await assert.rejects(createStore({ connectionString: f.legacyURI, namespace: f.NS, credentialNamespace: f.CREDENTIAL_NS,
          ownerPolicy: { catalogue: CATALOGUE.slice() }, plane }), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
      }
    });

    it('does not let a caller mutate a copied proposal while the transaction waits at the real target lock', async function () {
      const blocker = await f.open(); await blocker.query('BEGIN');
      const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await blocker.query('SELECT subject_id FROM ' + f.tables.subjects + ' WHERE tenant_id=$1 AND subject_id=$2 FOR UPDATE', [A, TARGET]);
      const input = { name: 'Copied Proposal', roles: ['reader'] };
      let pending;
      try {
        pending = f.service.update(f.actor, TARGET, input);
        const waiters = await f.blockedBy(pid);
        assert.ok(waiters.some(row => row.query.includes('tenant_authorization_subjects')));
        input.roles.splice(0, 1, 'outside'); input.name = 'Changed Caller';
        await blocker.query('COMMIT');
        const result = await pending;
        assert.equal(result.name, 'Copied Proposal'); assert.deepEqual(result.roles, ['reader']);
      } finally { await blocker.query('ROLLBACK'); if (pending) await pending.catch(() => {}); }
    });

    const races = [
      ['policy', table => 'UPDATE ' + table + ' SET ceiling=ARRAY[]::text[] WHERE tenant_id=$1'],
      ['actors', table => 'UPDATE ' + table + ' SET delegable=ARRAY[]::text[] WHERE tenant_id=$1'],
      ['roles', table => 'UPDATE ' + table + ' SET permissions=ARRAY[\'api:settings:admin\'] WHERE tenant_id=$1 AND name=\'reader\''],
      ['config', table => 'UPDATE ' + table + ' SET anonymous_roles=ARRAY[\'status-only\'] WHERE tenant_id=$1']
    ];
    for (const [key, update] of races) {
      it('fences a prior committed ' + key + ' narrowing before the waiting proposal can mutate', async function () {
        const revoker = await f.open(); await revoker.query('BEGIN');
        const pid = (await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const changed = await revoker.query(update(f.tables[key]) + ' RETURNING tenant_id', [A]);
        assert.equal(changed.rowCount, 1, 'the intended authority row must actually change');
        const before = await f.snapshot(); let pending;
        try {
          pending = f.http(f.proposal());
          await f.blockedBy(pid);
          assert.deepEqual(await f.snapshot(), before);
          await revoker.query('COMMIT');
          const response = await pending;
          assert.equal(response.status, 403, JSON.stringify(response.body));
          assert.deepEqual(await f.snapshot(), before);
        } finally { await revoker.query('ROLLBACK'); if (pending) await pending.catch(() => {}); }
      });
      it('holds ' + key + ' authority stable through commit and refuses the next proposal after narrowing', async function () {
        const blocker = await f.open(), revoker = await f.open();
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await blocker.query('SELECT subject_id FROM ' + f.tables.subjects + ' WHERE tenant_id=$1 AND subject_id=$2 FOR UPDATE', [A, TARGET]);
        let pending;
        try {
          pending = f.http(f.proposal());
          const waiters = await f.blockedBy(pid);
          assert.ok(waiters.some(row => row.query.includes('tenant_authorization_subjects')));
          await revoker.query('BEGIN'); await revoker.query("SET LOCAL lock_timeout='150ms'");
          await assert.rejects(revoker.query(update(f.tables[key]) + ' RETURNING tenant_id', [A]), { code: '55P03' });
          await revoker.query('ROLLBACK');
          await blocker.query('COMMIT');
          assert.equal((await pending).status, 200);
          const changed = await revoker.query(update(f.tables[key]) + ' RETURNING tenant_id', [A]);
          assert.equal(changed.rowCount, 1);
          await refused(f.proposal());
        } finally { await revoker.query('ROLLBACK'); await blocker.query('ROLLBACK'); if (pending) await pending.catch(() => {}); }
      });
    }

    it('acquires SHARE with fence-only privileges while real authority-column writes and serving writes are denied', async function () {
      const writer = await f.open('owner_writer'), reader = await f.open('owner_reader');
      for (const table of [f.tables.config, f.tables.roles, f.tables.policy, f.tables.actors]) {
        const rows = await f.bound(writer, A, client => client.query('SELECT tenant_id FROM ' + table + ' FOR SHARE'));
        assert.ok(rows.rows.length > 0); assert.ok(rows.rows.every(row => row.tenant_id === A));
      }
      for (const [table, assignment] of [[f.tables.roles, "permissions=ARRAY['*']"], [f.tables.roles, "name='escalated'"],
        [f.tables.config, "anonymous_roles=ARRAY['readable']"], [f.tables.policy, 'ceiling=ARRAY[]::text[]'],
        [f.tables.policy, "catalogue_digest='" + '0'.repeat(64) + "'"], [f.tables.actors, 'active=false'],
        [f.tables.actors, 'can_update=true'], [f.tables.actors, 'delegable=ARRAY[]::text[]']]) {
        await assert.rejects(f.bound(writer, A, client => client.query('UPDATE ' + table + ' SET ' + assignment + ' WHERE tenant_id=$1', [A])), { code: '42501' });
      }
      await assert.rejects(f.bound(reader, A, client => client.query('UPDATE ' + f.tables.roles + ' SET owner_fence=true WHERE tenant_id=$1', [A])), { code: '42501' });
      const unbound = await writer.query('SELECT tenant_id FROM ' + f.tables.policy);
      assert.deepEqual(unbound.rows, []);
    });

    it('refuses unsafe extra authority grants and disabled RLS at startup, with restored positive controls', async function () {
      await f.admin.query('GRANT UPDATE(ceiling) ON ' + f.tables.policy + ' TO owner_writer');
      try { await assert.rejects(f.newStore(), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' }); }
      finally { await f.admin.query('REVOKE UPDATE(ceiling) ON ' + f.tables.policy + ' FROM owner_writer'); }
      await f.newStore();
      await f.admin.query('ALTER TABLE ' + f.tables.actors + ' DISABLE ROW LEVEL SECURITY');
      try { await assert.rejects(f.newStore(), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' }); }
      finally { await f.admin.query('ALTER TABLE ' + f.tables.actors + ' ENABLE ROW LEVEL SECURITY'); }
      await f.newStore();
    });

    it('rolls back all subject effects when the final real audit insert fails', async function () {
      const before = await f.snapshot();
      await f.admin.query('ALTER TABLE ' + f.tables.audit + " ADD CONSTRAINT owner_audit_control CHECK (operation='impossible')");
      try {
        assert.equal((await f.http(f.proposal())).status, 503);
        assert.deepEqual(await f.snapshot(), before);
      } finally { await f.admin.query('ALTER TABLE ' + f.tables.audit + ' DROP CONSTRAINT owner_audit_control'); }
    });

    it('refuses unavailable current authority before effect and recovers after the owned database resumes', async function () {
      const before = await f.snapshot();
      f.pause();
      try { assert.equal((await f.http(f.proposal())).status, 503); }
      finally { f.unpause(); }
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.http(f.proposal())).status, 200);
    });

    // Last-owner protection (owner-authority: "last-owner removal must not orphan
    // the tenant"). A usable owner is an active, updating actor row whose
    // principal is an existing subject of the tenant (lib/tenant-ownership).
    async function usableOwners (tenant = A) {
      return (await f.admin.query('SELECT DISTINCT a.principal FROM ' + f.tables.actors + ' a JOIN ' + f.tables.subjects +
        ' s ON s.tenant_id=a.tenant_id AND s.subject_id=a.principal WHERE a.tenant_id=$1 AND a.active AND a.can_update ORDER BY 1', [tenant]))
        .rows.map(row => row.principal);
    }
    async function makeOwner (principal, { subject = true } = {}) {
      if (subject) {
        await f.admin.query('INSERT INTO ' + f.tables.subjects + ' (tenant_id,subject_id,display_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [A, principal, 'Synthetic owner']);
        await f.admin.query('INSERT INTO ' + f.tables.credentials + ' (tenant_id,subject_id,token_prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [A, principal, 'synthetic']);
      }
      await f.admin.query('INSERT INTO ' + f.tables.actors + ' (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,$2,\'admin\',true,true,$3) ON CONFLICT DO NOTHING', [A, principal, CATALOGUE]);
    }
    async function lockWaiters (application, count) {
      const limit = Date.now() + 15000;
      for (;;) {
        const n = (await f.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application])).rows[0].n;
        if (n === count) return n;
        if (Date.now() > limit) throw new Error('expected ' + count + ' lock waiters from ' + application + ', saw ' + n);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }

    it('refuses revoking the last usable owner subject (409) without effect, and allows it while another owner remains', async function () {
      // `manager` has an actor row but no subject, so TARGET is the only usable owner.
      await makeOwner(TARGET, { subject: false });
      assert.deepEqual(await usableOwners(), [TARGET]);
      const response = await refused(undefined, 409, { method: 'delete' });
      assert.deepEqual(response.body, { error: 'SUBJECT_ADMIN_LAST_OWNER' });
      assert.deepEqual(await usableOwners(), [TARGET], 'the tenant keeps its owner');
      // Self-revocation of the last owner is refused the same way.
      await f.admin.query('DELETE FROM ' + f.tables.actors + ' WHERE tenant_id=$1 AND principal=\'manager\'', [A]);
      await assert.rejects(f.ownerStore.remove({ tenant: A, principal: TARGET, consumer: 'admin' }, TARGET), { code: 'SUBJECT_ADMIN_LAST_OWNER' });
      // Positive control: with a second usable owner the same revocation applies.
      await makeOwner('manager');
      assert.deepEqual(await usableOwners(), [TARGET, 'manager'].sort());
      assert.equal((await f.http(undefined, { method: 'delete' })).status, 200);
      assert.deepEqual(await usableOwners(), ['manager']);
    });

    it('race: two owners revoking each other concurrently leave exactly one usable owner', async function () {
      await makeOwner('manager'); await makeOwner(TARGET);
      // Both actors are owners; the store's current owner policy is the authority under test.
      const service = require('../lib/subject-admin/component').createSubjectAdmin({ store: f.ownerStore, authorizeManagement: async () => true });
      const holder = await f.open(); await holder.query('BEGIN');
      // Barrier: both revocations must be inside their transactions before either commits.
      await holder.query('LOCK TABLE ' + f.tables.audit + ' IN SHARE MODE');
      let attempts;
      try {
        attempts = [service.remove({ tenant: A, principal: 'manager', consumer: 'admin' }, TARGET),
          service.remove({ tenant: A, principal: TARGET, consumer: 'admin' }, 'manager')].map(p => p.then(() => 'applied', error => error.code));
        assert.equal(await lockWaiters('nightscout-subject-admin', 2), 2);
        await holder.query('COMMIT');
        const outcomes = (await Promise.all(attempts)).sort();
        assert.deepEqual(outcomes, ['SUBJECT_ADMIN_LAST_OWNER', 'applied'], 'one revocation applies, the other is refused');
        assert.equal((await usableOwners()).length, 1, 'the tenant keeps one usable owner');
      } finally { await holder.query('ROLLBACK'); if (attempts) await Promise.allSettled(attempts); }
    });

    it('race: an owner revocation of the incoming owner serializes with an operator transfer to it', async function () {
      const createOwnership = require('../lib/tenant-ownership/postgres');
      const { createOwnershipOperations } = require('../lib/tenant-ownership/component');
      const { tenantSetAuthority } = require('../lib/tenant-ownership/service');
      if (!f.state.operatorURI) {
        const crypto = require('node:crypto'), pw = crypto.randomBytes(24).toString('hex');
        await f.admin.query(`CREATE ROLE ownership_operator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
        await f.admin.query(`GRANT USAGE ON SCHEMA ${f.NS} TO ownership_operator`);
        await f.admin.query(`GRANT SELECT, UPDATE (owner_fence) ON ${f.tables.config}, ${f.tables.policy} TO ownership_operator`);
        await f.admin.query(`GRANT SELECT, INSERT, UPDATE (active, can_update, delegable) ON ${f.tables.actors} TO ownership_operator`);
        await f.admin.query(`GRANT SELECT ON ${f.tables.subjects} TO ownership_operator`);
        await f.admin.query(`GRANT INSERT ON ${f.tables.audit} TO ownership_operator`);
        const url = new URL(f.writerURI); url.username = 'ownership_operator'; url.password = pw; f.state.operatorURI = url.toString();
      }
      const store = await createOwnership({ connectionString: f.state.operatorURI, namespace: f.NS });
      const operator = { principal: 'synthetic_operator', consumer: 'operator_plane' };
      const ops = createOwnershipOperations({ store, authorizeOperator: tenantSetAuthority({ ...operator, tenants: [A] }) });
      const ref = principal => ({ principal, consumer: 'admin' });
      await makeOwner('manager');
      const holder = await f.open(); await holder.query('BEGIN');
      await holder.query('LOCK TABLE ' + f.tables.audit + ' IN SHARE MODE');
      let revoke, transfer;
      try {
        revoke = f.service.remove(f.actor, TARGET).then(() => 'applied', error => error.code);
        await lockWaiters('nightscout-subject-admin', 1);
        transfer = ops.transfer(operator, { tenant: A, from: ref('manager'), to: ref(TARGET), expectedOwners: [ref('manager')] });
        await lockWaiters('nightscout-ownership-ops', 1);
        await holder.query('COMMIT');
        assert.equal(await revoke, 'applied');
        const moved = await transfer;
        assert.deepEqual({ outcome: moved.outcome, code: moved.code }, { outcome: 'refused', code: 'OWNERSHIP_SUBJECT_UNKNOWN' });
        assert.deepEqual(await usableOwners(), ['manager'], 'the transfer saw the committed revocation; the tenant keeps its owner');
      } finally {
        await holder.query('ROLLBACK');
        await Promise.allSettled([revoke, transfer].filter(Boolean));
        await store.close();
      }
    });

    // Decisions tenant-root-single-site-parity and root-may-edit-owner-subjects:
    // the tenant's API_SECRET administers subjects and roles through the single-site
    // admin tools routes and payloads, on the owner-aware writer's root plane.
    describe('tenant root (API_SECRET) single-site admin tools parity', function () {
      const crypto = require('node:crypto');
      const request = require('supertest');
      const { createSecrets } = require('../lib/secrets/component');
      const createLegacy = require('../lib/secrets/legacy-postgres');
      const { createSubjectAdmin } = require('../lib/subject-admin/component');
      const { createTenantApp } = require('../lib/server/tenant-app');
      const { createRootAuthentication } = require('../lib/server/tenant-app/root-admin');
      const sha1 = value => crypto.createHash('sha1').update(value).digest('hex');
      const roots = new Map([[A, crypto.randomBytes(24).toString('hex')], [B, crypto.randomBytes(24).toString('hex')]]);
      const hosts = new Map([[A, 'one.example.test'], [B, 'two.example.test']]);
      const consumer = 'tenant-api';
      const verifierContext = tenant => ({ tenant, principal: 'preview-api', consumer });
      let legacy, secrets, app, ownerCalls;
      // jQuery.param as the admin tools send it: arrays as key[]=v, empty arrays omitted.
      const form = value => Object.entries(value).flatMap(([key, item]) => Array.isArray(item)
        ? item.map(entry => encodeURIComponent(key + '[]') + '=' + encodeURIComponent(entry))
        : [encodeURIComponent(key) + '=' + encodeURIComponent(item)]).join('&');
      function call (method, path, { tenant = A, as = A, body, secret } = {}) {
        let pending = request(app)[method]('/api/v2/authorization' + path).set('Host', hosts.get(tenant)).timeout({ response: 20000 });
        const presented = secret !== undefined ? secret : as === null ? null : sha1(roots.get(as));
        if (presented !== null) pending = pending.set('api-secret', presented);
        return body === undefined ? pending : pending.type('form').send(form(body));
      }
      const token = (tenant, subjectId, prefix) => prefix + '-' + sha1(sha1(roots.get(tenant)) + subjectId).slice(0, 16);
      async function unchanged (fn, status) {
        const before = await f.snapshot();
        const response = await fn();
        assert.equal(response.status, status, JSON.stringify(response.body));
        assert.deepEqual(await f.snapshot(), before, 'a refusal must leave both tenants unchanged');
        return response;
      }
      async function makeOwner (principal, { subject = true } = {}) {
        if (subject) {
          await f.admin.query('INSERT INTO ' + f.tables.subjects + ' (tenant_id,subject_id,display_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [A, principal, 'Synthetic owner']);
          await f.admin.query('INSERT INTO ' + f.tables.credentials + ' (tenant_id,subject_id,token_prefix) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [A, principal, 'synthetic']);
        }
        await f.admin.query('INSERT INTO ' + f.tables.actors + ' (tenant_id,principal,consumer,active,can_update,delegable) VALUES ($1,$2,\'admin\',true,true,$3) ON CONFLICT DO NOTHING', [A, principal, CATALOGUE]);
      }
      async function usableOwners () {
        return (await f.admin.query('SELECT a.principal FROM ' + f.tables.actors + ' a JOIN ' + f.tables.subjects +
          ' s ON s.tenant_id=a.tenant_id AND s.subject_id=a.principal WHERE a.tenant_id=$1 AND a.active AND a.can_update ORDER BY 1', [A])).rows.map(row => row.principal);
      }

      before(async function () {
        const pw = crypto.randomBytes(24).toString('hex');
        await f.admin.query(`CREATE ROLE root_legacy_reader LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
        await f.admin.query(`GRANT USAGE ON SCHEMA ${f.CREDENTIAL_NS} TO root_legacy_reader`);
        await f.admin.query(`GRANT SELECT ON ${f.CREDENTIAL_NS}.legacy_credential_config, ${f.tables.credentials} TO root_legacy_reader`);
        const url = new URL(f.writerURI); url.username = 'root_legacy_reader'; url.password = pw;
        legacy = await createLegacy({ connectionString: url.toString(), namespace: f.CREDENTIAL_NS });
        const provider = require('./fixtures/tenant-credential-provider')(), encrypted = new Map();
        secrets = createSecrets({ providerFor: async () => provider, maxTokenLifetimeSeconds: 28800,
          store: { async get (tenant, id) { return encrypted.get(tenant + ':' + id); },
            async insert (record) { encrypted.set(record.tenant + ':' + record.id, record); } },
          authorize: async (identity, action) => identity.principal === 'preview-api' && ['encrypt', 'decrypt'].includes(action.operation),
          audit: async () => {}, legacyAuthorityFor: tenant => legacy.read(tenant) });
        await secrets.encrypt(verifierContext(A), 'synthetic-root-a', Buffer.from(roots.get(A)));
        await secrets.encrypt(verifierContext(B), 'synthetic-root-b', Buffer.from(roots.get(B)));
        const service = createSubjectAdmin({ store: f.rootStore,
          authorizeManagement: async actor => actor.principal === 'root' && actor.consumer === consumer });
        const record = name => async () => { ownerCalls.push(name); return {}; };
        app = createTenantApp({ resolver: f.resolver, verifyCredential: async () => null, authorizeRequest: async () => false,
          dataRouter: (req, res) => res.status(404).json({ error: 'NOT_FOUND' }),
          tenantSettings: { read: record('settings.read'), replace: record('settings.replace'), rollback: record('settings.rollback') },
          subjectPolicy: { read: record('policy.read'), replace: record('policy.replace') },
          rootAdmin: { ...service, authenticate: createRootAuthentication({ secrets, verifierContext, tenants: [A, B] }) } });
      });
      beforeEach(() => { ownerCalls = []; });
      after(async () => { if (legacy) await legacy.close(); });

      it('lists, creates, edits and deletes subjects and creates roles with the admin tools payloads', async function () {
        const listed = await call('get', '/subjects');
        assert.equal(listed.status, 200, JSON.stringify(listed.body));
        assert.deepEqual(listed.body, [{ _id: TARGET, name: 'Original', roles: ['reader'], notes: 'preserved', accessToken: token(A, TARGET, 'original') }]);
        // The listed token is the subject's own legacy credential on this tenant.
        assert.deepEqual(await secrets.verifyLegacyCredential(verifierContext(A), { apiSecret: listed.body[0].accessToken }), { kind: 'subject', subjectId: TARGET });
        const role = await call('post', '/roles', { body: { name: 'school', permissions: ['api:entries:read'], notes: '' } });
        assert.equal(role.status, 200, JSON.stringify(role.body));
        assert.deepEqual(role.body, { _id: 'school', name: 'school', permissions: ['api:entries:read'] });
        const roles = await call('get', '/roles');
        assert.deepEqual(roles.body.find(row => row.name === 'school'), { _id: 'school', name: 'school', permissions: ['api:entries:read'] });
        const created = await call('post', '/subjects', { body: { name: 'Caregiver', roles: ['school'], notes: 'synthetic' } });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        const id = created.body._id;
        assert.match(id, /^[0-9a-f]{32}$/);
        assert.deepEqual({ ...created.body, _id: undefined }, { _id: undefined, name: 'Caregiver', roles: ['school'], notes: 'synthetic' });
        // Edit as the dialog does: the listed record (with its derived token) sent back with changes.
        const relisted = (await call('get', '/subjects')).body.find(row => row._id === id);
        assert.equal(relisted.accessToken, token(A, id, 'caregiver'));
        const edited = await call('put', '/subjects', { body: { ...relisted, name: 'Caregiver Two', roles: ['reader', 'school'], notes: '' } });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.deepEqual(edited.body, { _id: id, name: 'Caregiver Two', roles: ['reader', 'school'], notes: '' });
        // An empty role list is omitted by jQuery and revokes every role, as on a single site.
        const cleared = await call('put', '/subjects', { body: { _id: id, name: 'Caregiver Two', roles: [], notes: '' } });
        assert.deepEqual(cleared.body.roles, []);
        assert.deepEqual((await call('delete', '/subjects/' + id)).body, {});
        assert.equal((await f.admin.query('SELECT count(*)::int n FROM ' + f.tables.subjects + ' WHERE tenant_id=$1 AND subject_id=$2', [A, id])).rows[0].n, 0);
        const audit = (await f.admin.query('SELECT principal,consumer,operation FROM ' + f.tables.audit + ' WHERE tenant_id=$1 ORDER BY event_time,operation', [A])).rows;
        assert.deepEqual(new Set(audit.map(row => row.principal + '/' + row.consumer)), new Set(['root/' + consumer]));
        assert.deepEqual(audit.map(row => row.operation).sort(), ['create', 'create-role', 'remove', 'update', 'update'].sort());
        assert.equal((await f.admin.query('SELECT count(*)::int n FROM ' + f.tables.audit + ' WHERE tenant_id=$1', [B])).rows[0].n, 0);
      });

      it('stays inside the project catalogue and operator ceiling', async function () {
        await unchanged(() => call('put', '/subjects', { body: { _id: TARGET, name: 'Original', roles: ['outside'] } }), 403);
        await unchanged(() => call('post', '/roles', { body: { name: 'everything', permissions: ['*'] } }), 403);
        await f.admin.query('UPDATE ' + f.tables.policy + ' SET ceiling=ARRAY[\'api:entries:read\'] WHERE tenant_id=$1', [A]);
        await unchanged(() => call('put', '/subjects', { body: { _id: TARGET, name: 'Original', roles: ['uploader'] } }), 403);
        assert.equal((await call('put', '/subjects', { body: { _id: TARGET, name: 'Original', roles: ['reader'] } })).status, 200);
      });

      it('edits and deletes a co-owner\'s subject without touching ownership', async function () {
        await makeOwner(TARGET); await makeOwner('000000000000000000000002');
        const actors = (await f.admin.query('SELECT * FROM ' + f.tables.actors + ' ORDER BY tenant_id,principal')).rows;
        const edited = await call('put', '/subjects', { body: { _id: TARGET, name: 'Renamed Owner', roles: ['reader', 'uploader'] } });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        assert.equal((await call('delete', '/subjects/' + TARGET)).status, 200);
        assert.deepEqual(await usableOwners(), ['000000000000000000000002']);
        assert.deepEqual((await f.admin.query('SELECT * FROM ' + f.tables.actors + ' ORDER BY tenant_id,principal')).rows, actors,
          'root never writes owner actor rows');
      });

      it('refuses removing the last usable owner (409) with no effect', async function () {
        await makeOwner(TARGET);
        assert.deepEqual(await usableOwners(), [TARGET]);
        const response = await unchanged(() => call('delete', '/subjects/' + TARGET), 409);
        assert.deepEqual(response.body, { error: 'SUBJECT_ADMIN_LAST_OWNER' });
        assert.deepEqual(await usableOwners(), [TARGET]);
      });

      it('race: a root revocation of the incoming owner serializes with an operator transfer to it', async function () {
        const createOwnership = require('../lib/tenant-ownership/postgres');
        const { createOwnershipOperations } = require('../lib/tenant-ownership/component');
        const { tenantSetAuthority } = require('../lib/tenant-ownership/service');
        if (!f.state.operatorURI) {
          const pw = crypto.randomBytes(24).toString('hex');
          await f.admin.query(`CREATE ROLE ownership_operator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${pw}'`);
          await f.admin.query(`GRANT USAGE ON SCHEMA ${f.NS} TO ownership_operator`);
          await f.admin.query(`GRANT SELECT, UPDATE (owner_fence) ON ${f.tables.config}, ${f.tables.policy} TO ownership_operator`);
          await f.admin.query(`GRANT SELECT, INSERT, UPDATE (active, can_update, delegable) ON ${f.tables.actors} TO ownership_operator`);
          await f.admin.query(`GRANT SELECT ON ${f.tables.subjects} TO ownership_operator`);
          await f.admin.query(`GRANT INSERT ON ${f.tables.audit} TO ownership_operator`);
          const url = new URL(f.writerURI); url.username = 'ownership_operator'; url.password = pw; f.state.operatorURI = url.toString();
        }
        const store = await createOwnership({ connectionString: f.state.operatorURI, namespace: f.NS });
        const operator = { principal: 'synthetic_operator', consumer: 'operator_plane' };
        const ops = createOwnershipOperations({ store, authorizeOperator: tenantSetAuthority({ ...operator, tenants: [A] }) });
        const ref = principal => ({ principal, consumer: 'admin' });
        await makeOwner('manager');
        const holder = await f.open(); await holder.query('BEGIN');
        await holder.query('LOCK TABLE ' + f.tables.audit + ' IN SHARE MODE');
        let revoke, transfer;
        try {
          revoke = f.rootStore.remove({ tenant: A, principal: 'root', consumer }, TARGET).then(() => 'applied', error => error.code);
          const limit = Date.now() + 15000;
          while ((await f.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='nightscout-subject-admin' AND wait_event_type='Lock'")).rows[0].n !== 1) {
            if (Date.now() > limit) throw new Error('root revocation never reached the barrier');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          transfer = ops.transfer(operator, { tenant: A, from: ref('manager'), to: ref(TARGET), expectedOwners: [ref('manager')] });
          const until = Date.now() + 15000;
          while ((await f.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='nightscout-ownership-ops' AND wait_event_type='Lock'")).rows[0].n !== 1) {
            if (Date.now() > until) throw new Error('transfer never waited');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          await holder.query('COMMIT');
          assert.equal(await revoke, 'applied');
          const moved = await transfer;
          assert.deepEqual({ outcome: moved.outcome, code: moved.code }, { outcome: 'refused', code: 'OWNERSHIP_SUBJECT_UNKNOWN' });
          assert.deepEqual(await usableOwners(), ['manager']);
        } finally {
          await holder.query('ROLLBACK');
          await Promise.allSettled([revoke, transfer].filter(Boolean));
          await store.close();
        }
      });

      it('refuses root on owner and operator routes, and on owner-plane issuance', async function () {
        for (const [method, path] of [['get', '/api/v1/tenant/settings'], ['put', '/api/v1/tenant/settings'],
          ['post', '/api/v1/tenant/settings/rollback'], ['get', '/api/v1/tenant/subject-policy'], ['put', '/api/v1/tenant/subject-policy']]) {
          const response = await unchanged(() => {
            const pending = request(app)[method](path).set('Host', hosts.get(A)).set('api-secret', sha1(roots.get(A)));
            return method === 'get' ? pending : pending.send({ expectedVersion: 0, values: {} });
          }, 401);
          assert.deepEqual(response.body, { error: 'CREDENTIAL_REFUSED' }, method + ' ' + path);
        }
        assert.deepEqual(ownerCalls, [], 'no owner service was reached');
        for (const [method, path] of [['get', '/api/v1/operator/tenants/' + A + '/policy'], ['post', '/api/v2/authorization/subjects/' + TARGET + '/credential']]) {
          await unchanged(() => request(app)[method](path).set('Host', hosts.get(A)).set('api-secret', sha1(roots.get(A))), 404);
        }
        // The owner listener's subject routes accept only management credentials.
        await unchanged(() => request(f.app).delete('/api/v2/authorization/subjects/' + TARGET).set('Host', hosts.get(A))
          .set('api-secret', sha1(roots.get(A))), 401);
        // Editing or deleting a role is not part of the owner-aware writer.
        assert.equal((await unchanged(() => call('put', '/roles', { body: { _id: 'reader', name: 'reader', permissions: ['*'] } }), 501)).body.error, 'SUBJECT_ADMIN_UNSUPPORTED');
        await unchanged(() => call('delete', '/roles/reader'), 501);
        // Owner-plane issuance is refused on the root plane's store itself.
        await assert.rejects(f.rootStore.withCredential({ tenant: A, principal: 'root', consumer }, TARGET, async () => ({})), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
      });

      it('refuses another tenant\'s root, subject tokens and missing credentials; B\'s root changes only B', async function () {
        await unchanged(() => call('get', '/subjects', { as: B }), 401);
        await unchanged(() => call('delete', '/subjects/' + TARGET, { as: B }), 401);
        await unchanged(() => call('put', '/subjects', { as: B, body: { _id: TARGET, name: 'Hijacked', roles: [] } }), 401);
        await unchanged(() => call('post', '/subjects', { as: B, body: { name: 'Planted', roles: ['reader'] } }), 401);
        await unchanged(() => call('post', '/roles', { as: B, body: { name: 'planted', permissions: ['api:entries:read'] } }), 401);
        const subjectToken = token(A, TARGET, 'original');
        await unchanged(() => call('get', '/subjects', { secret: subjectToken }), 401);
        await unchanged(() => call('delete', '/subjects/' + TARGET, { as: null }), 401);
        assert.deepEqual((await call('get', '/subjects', { as: null })).body, { status: 401, message: 'Unauthorized', description: 'Invalid/Missing' });
        const foreign = await f.snapshot(A);
        assert.equal((await call('delete', '/subjects/' + TARGET, { tenant: B, as: B })).status, 200);
        assert.deepEqual(await f.snapshot(A), foreign, 'B\'s root acting on B leaves A unchanged');
        assert.equal((await f.admin.query('SELECT count(*)::int n FROM ' + f.tables.subjects + ' WHERE tenant_id=$1', [B])).rows[0].n, 0);
      });

      it('holds distinct privilege shapes for the owner and root planes', async function () {
        const createStore = require('../lib/subject-admin/postgres');
        const options = { namespace: f.NS, credentialNamespace: f.CREDENTIAL_NS, ownerPolicy: { catalogue: CATALOGUE.slice() } };
        await assert.rejects(createStore({ ...options, connectionString: f.writerURI, plane: 'root' }), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
        await assert.rejects(createStore({ ...options, connectionString: f.rootURI, plane: 'owner' }), { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
        await assert.rejects(createStore({ ...options, connectionString: f.rootURI, plane: 'operator' }), TypeError);
      });
    });
  });
