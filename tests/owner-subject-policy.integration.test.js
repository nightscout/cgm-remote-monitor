'use strict';

// covers: lib/subject-admin/owner-policy.js, lib/subject-admin/postgres.js, lib/server/subject-management-app.js
const assert = require('node:assert/strict');
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
      assert.equal(response.status, status, JSON.stringify(response.body));
      assert.deepEqual(await f.snapshot(), before, 'a refusal must preserve every target/link/credential/audit row in both tenants');
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

    it('preserves unknown-role and malformed-body refusal while bounding wildcard roles/defaults and catalogue versions', async function () {
      await refused(f.proposal(['foreign-only']), 400);
      await refused(f.proposal(['reader', 'reader']), 400);
      await refused(f.proposal(['wildcard']));
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET catalogue_digest=$2 WHERE tenant_id=$1', [A, '0'.repeat(64)]);
      await refused(f.proposal());
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET catalogue_digest=$2 WHERE tenant_id=$1', [A, f.digest(CATALOGUE)]);
      await f.admin.query('UPDATE ' + f.tables.config + ' SET anonymous_roles=ARRAY[\'readable\'] WHERE tenant_id=$1', [A]);
      await refused(f.proposal());
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

    it('keeps selected DELETE refused and legacy/default update/remove behavior available', async function () {
      await refused(undefined, 403, { method: 'delete' });
      await f.admin.query('UPDATE ' + f.tables.policy + ' SET ceiling=ARRAY[]::text[] WHERE tenant_id=$1', [A]);
      const old = await f.http({ ...f.proposal(['uploader']), notes: '' }, { app: f.legacyApp });
      assert.equal(old.status, 200); assert.deepEqual(old.body.roles, ['uploader']); assert.equal(old.body.notes, '');
      const omitted = await f.http({ _id: TARGET, name: 'Legacy Omitted' }, { app: f.legacyApp });
      assert.equal(omitted.status, 200); assert.deepEqual(omitted.body.roles, []);
      assert.equal(omitted.body.created_at, '2026-01-01T00:00:00.000Z');
      assert.equal((await f.http(undefined, { app: f.legacyApp, method: 'delete' })).status, 200);
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
      ['config', table => 'UPDATE ' + table + ' SET anonymous_roles=ARRAY[\'readable\'] WHERE tenant_id=$1']
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
  });
