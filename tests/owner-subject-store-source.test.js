'use strict';
const assert = require('node:assert/strict');
const scope = require('../lib/storage/tenant-scope');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const actor = { tenant: A, principal: 'owner', consumer: 'management' };

async function fixture () {
  let data = { subjects: {}, metadata: {}, links: {}, roles: { [A + '/reader']: ['*:*:read'], [B + '/foreign']: ['*'] }, audit: [] };
  const control = { active: true, ceiling: ['*'], delegable: ['*'], auditFail: false, issued: false, locks: [] };
  const connection = {
    async withTenant (tenant, action) {
      const previous = structuredClone(data);
      try { return await action(); } catch (error) { data = previous; throw error; }
    },
    async end () {},
    async query (sql, args = []) {
      const rows = values => ({ rows: values });
      if (sql.includes('FROM pg_class') && sql.includes('is_records')) throw new Error('unexpected secrets adapter');
      if (sql.includes('FROM pg_class') && sql.includes('AS column_reads')) {
        return rows(['tenant_authorization_subjects','tenant_authorization_roles','tenant_authorization_subject_roles',
          'legacy_credential_subjects','tenant_subject_admin_audit'].map((name, i) => {
          const bits = [[true,true,true,true],[true,true,false,false],[true,true,false,true],[true,true,true,true],[false,true,false,false]][i];
          return { name: (i === 3 ? 'cred.' : 'auth.') + name, secured: true, owns: false, unsafe: false,
            reads: bits[0], inserts: bits[1], updates: bits[2], deletes: bits[3],
            column_reads: bits[0], column_inserts: bits[1], column_updates: i === 1 || bits[2] };
        }));
      }
      if (sql.includes('FROM pg_class')) return rows(args[0].map(name => ({ secured: true, owns: false, reads: true,
        mutates: false, inserts: name.includes('tenant_authorization_roles'), column_inserts: name.includes('tenant_authorization_roles'),
        name: name.replaceAll('"',''), update_columns: ['owner_fence'] })));
      if (sql.startsWith('SET LOCAL')) return rows([]);
      if (sql.includes('FOR SHARE')) control.locks.push(sql);
      if (sql.startsWith('SELECT anonymous_roles')) return rows([{ anonymous_roles: ['denied'] }]);
      if (sql.startsWith('SELECT catalogue_digest')) return rows([{ catalogue_digest: catalogueDigest(['*']), ceiling: control.ceiling }]);
      if (sql.startsWith('SELECT active,can_update')) return rows([{ active: control.active, can_update: true, delegable: control.delegable }]);
      // Usable owners: the one modelled actor counts only while its subject exists.
      if (sql.startsWith('SELECT s.subject_id')) return rows(control.active && data.subjects[args[0] + '/' + actor.principal] ? [{ subject_id: actor.principal }] : []);
      const key = args[0] + '/' + args[1];
      if (sql.startsWith('SELECT name,permissions')) return rows(args[1].flatMap(name => {
        const permissions = data.roles[args[0] + '/' + name]; return permissions ? [{ name, permissions }] : [];
      }));
      if (sql.startsWith('SELECT role_name')) return rows((data.links[key] || []).map(role_name => ({ role_name })));
      if (sql.startsWith('SELECT display_name')) return rows(data.subjects[key] ? [structuredClone(data.subjects[key])] : []);
      if (sql.startsWith('SELECT subject_id')) return rows(data.metadata[key] ? [{ subject_id: args[1] }] : []);
      if (sql.startsWith('INSERT INTO "auth".tenant_authorization_subjects')) data.subjects[key] = { display_name: args[2], notes: args[3], created_at: args[4] };
      else if (sql.startsWith('INSERT INTO "cred".legacy_credential_subjects')) data.metadata[key] = { token_prefix: args[2] };
      else if (sql.startsWith('INSERT INTO "auth".tenant_authorization_subject_roles')) {
        if (!data.links[key]) data.links[key] = [];
        data.links[key].push(args[2]);
      }
      else if (sql.startsWith('INSERT INTO "auth".tenant_authorization_roles')) {
        if (data.roles[key]) throw Object.assign(new Error('duplicate'), { code: '23505' }); data.roles[key] = args[2].slice();
      } else if (sql.startsWith('INSERT INTO "auth".tenant_subject_admin_audit')) {
        if (control.auditFail) throw new Error('audit unavailable'); data.audit.push(args.slice());
      } else if (sql.startsWith('DELETE FROM "auth".tenant_authorization_subject_roles')) delete data.links[key];
      else if (sql.startsWith('DELETE FROM "cred".legacy_credential_subjects')) delete data.metadata[key];
      else if (sql.startsWith('DELETE FROM "auth".tenant_authorization_subjects')) delete data.subjects[key];
      else throw new Error('Unmodelled SQL: ' + sql);
      return rows([]);
    }
  };
  const connector = require.resolve('../lib/storage/postgres-connection'); require(connector);
  const previous = require.cache[connector].exports;
  const storePath = require.resolve('../lib/subject-admin/postgres'); const cachedStore = require.cache[storePath];
  let factory;
  try {
    require.cache[connector].exports = async () => connection; delete require.cache[storePath]; factory = require(storePath);
  } finally { require.cache[connector].exports = previous; delete require.cache[storePath]; if (cachedStore) require.cache[storePath] = cachedStore; }
  const store = await factory({ connectionString: 'synthetic-test-only', namespace: 'auth', credentialNamespace: 'cred', ownerPolicy: { catalogue: ['*'] } });
  return { store, control, snapshot: () => structuredClone(data) };
}

describe('owner subject persistence source boundary (synthetic connection)', function () {
  let mode;
  beforeEach(function () { mode = scope.getTenancyMode(); scope.setTenancyMode('multi'); });
  afterEach(function () { scope.setTenancyMode(mode); });
  it('stores subject/metadata/roles independently, issues inside locks, and revokes without touching B', async function () {
    const f = await fixture(), before = f.snapshot();
    await f.store.createRole(actor, { name: 'custom', permissions: ['api:future:*'] });
    const subject = await f.store.create(actor, { name: 'Synthetic Reader', roles: ['custom'] });
    const key = A + '/' + subject.subjectId;
    const stored = f.snapshot();
    assert.equal(stored.subjects[key].display_name, 'Synthetic Reader');
    assert.equal(stored.metadata[key].token_prefix, 'syntheticr');
    assert.deepEqual(stored.links[key], ['custom']); assert.deepEqual(stored.roles[A + '/custom'], ['api:future:*']);
    const issued = { token: 'synthetic-result' };
    assert.equal(await f.store.withCredential(actor, subject.subjectId, async () => {
      assert.ok(f.control.locks.some(sql => sql.includes('tenant_owner_actors')));
      assert.ok(f.snapshot().audit.some(row => row[5] === 'issue')); return issued;
    }), issued);
    assert.equal(await f.store.remove(actor, subject.subjectId), true);
    assert.equal(f.snapshot().subjects[key], undefined); assert.equal(f.snapshot().metadata[key], undefined);
    assert.equal(f.snapshot().links[key], undefined); assert.deepEqual(f.snapshot().roles[B + '/foreign'], before.roles[B + '/foreign']);
    await assert.rejects(f.store.withCredential(actor, subject.subjectId, async () => { throw new Error('must not issue'); }), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
    const live = await f.store.create(actor, { name: 'Revocation control', roles: [] });
    f.control.active = false; const prior = f.snapshot();
    await assert.rejects(f.store.remove(actor, live.subjectId), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    assert.deepEqual(f.snapshot(), prior);
    await f.store.close();
  });
  it('refuses current revocation, overceiling and undelegated proposals with unchanged independently read rows', async function () {
    const f = await fixture();
    for (const field of ['active', 'ceiling', 'delegable']) {
      const original = f.control[field]; f.control[field] = field === 'active' ? false : [];
      const before = f.snapshot();
      await assert.rejects(f.store.createRole(actor, { name: 'blocked', permissions: ['*'] }), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
      await assert.rejects(f.store.create(actor, { name: 'Blocked', roles: ['reader'] }), { code: 'SUBJECT_ADMIN_FORBIDDEN' });
      assert.deepEqual(f.snapshot(), before); f.control[field] = original;
    }
  });
  it('rolls all subject writes back when final audit fails and cannot reveal on failed issuance audit', async function () {
    const f = await fixture(), before = f.snapshot(); f.control.auditFail = true;
    await assert.rejects(f.store.create(actor, { name: 'Rollback', roles: ['reader'] }), { code: 'SUBJECT_ADMIN_STORE_UNAVAILABLE' });
    assert.deepEqual(f.snapshot(), before);
    f.control.auditFail = false; const subject = await f.store.create(actor, { name: 'Subject', roles: [] });
    f.control.auditFail = true;
    await assert.rejects(f.store.withCredential(actor, subject.subjectId, async () => { f.control.issued = true; }), { code: 'SUBJECT_ADMIN_STORE_UNAVAILABLE' });
    assert.equal(f.control.issued, false);
  });
});
