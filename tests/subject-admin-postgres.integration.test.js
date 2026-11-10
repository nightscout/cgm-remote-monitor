'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const credentialCatalogue = require('../lib/secrets/legacy-credentials-candidate.json');
const createStore = require('../lib/subject-admin/postgres');
const { catalogueDigest } = require('../lib/subject-admin/owner-policy');
const ownerPolicy = Object.freeze({ catalogue: Object.freeze(['*']) });
const { createSubjectAdmin } = require('../lib/subject-admin/component');
const createAuthority = require('../lib/tenant-authorization/postgres');
const createLegacy = require('../lib/secrets/legacy-postgres');
const { createSecrets } = require('../lib/secrets/component');
const provider = require('./fixtures/tenant-credential-provider');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '000000000000000000000001';
const context = { tenant: A, principal: 'manager', consumer: 'admin' };
const namespace = 'subject_admin';
const credentialNamespace = 'subject_identity';
const S = namespace + '.tenant_authorization_subjects';
const R = namespace + '.tenant_authorization_roles';
const L = namespace + '.tenant_authorization_subject_roles';
const C = credentialNamespace + '.legacy_credential_subjects';
const AUDIT = namespace + '.tenant_subject_admin_audit';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_SUBJECT_ADMIN_POSTGRES_DOCKER_TEST === '1',
  'NS_SUBJECT_ADMIN_POSTGRES_DOCKER_TEST=1')('bounded subject administration (disposable PostgreSQL)', function () {
  this.timeout(30000);
  const container = 'ns-subject-admin-' + crypto.randomBytes(8).toString('hex');
  let owned = false, previousMode, admin, adminURI, writerURI, readerURI, store, service;
  const workers = [];
  const roots = new Map([[A, crypto.randomBytes(24).toString('hex')], [B, crypto.randomBytes(24).toString('hex')]]);
  const cryptoProvider = provider();
  const encrypted = new Map();
  let originalCredential, issuedJWT;
  const verifierContext = tenant => ({ tenant, principal: 'verifier', consumer: 'api' });
  async function snapshot () {
    const result = {};
    for (const table of [S, L, C, AUDIT]) {
      result[table] = (await admin.query('SELECT * FROM ' + table + ' ORDER BY tenant_id, ' +
        (table === AUDIT ? 'event_id' : 'subject_id'))).rows;
    }
    return result;
  }
  async function protectedOperation (worker, tenant, credential) {
    const principal = await worker.secrets.verifyLegacyCredential(verifierContext(tenant), credential);
    return principal !== null && await worker.authority.authorize({ tenant, principal, permission: 'api:entries:create' });
  }
  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator',
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=subject_admin', 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/subject_admin';
    const deadline = Date.now() + 15000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator']); ready = true; }
      catch { await sleep(100); }
    }
    assert.ok(ready);
    await run('up', { direct: true, connectionString: adminURI, namespace, catalogue });
    await run('check', { direct: true, connectionString: adminURI, namespace, catalogue });
    await run('up', { direct: true, connectionString: adminURI, namespace: credentialNamespace, catalogue: credentialCatalogue });
    admin = new Client({ connectionString: adminURI });
    await admin.connect();
    async function role (name) {
      const rolePassword = crypto.randomBytes(24).toString('hex');
      await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`);
      await admin.query(`GRANT USAGE ON SCHEMA ${namespace}, ${credentialNamespace} TO ${name}`);
      const url = new URL(adminURI); url.username = name; url.password = rolePassword; return url.toString();
    }
    writerURI = await role('subject_writer');
    readerURI = await role('subject_reader');
    await admin.query(`GRANT SELECT, UPDATE, DELETE ON ${S}, ${C} TO subject_writer`);
    await admin.query(`GRANT SELECT ON ${R} TO subject_writer`);
    await admin.query(`GRANT SELECT, INSERT, DELETE ON ${L} TO subject_writer`);
    await admin.query(`GRANT INSERT ON ${AUDIT} TO subject_writer`);
    // Multitenant subject writes go through the owner-aware writer only
    // (decision root-may-edit-owner-subjects): owner-shape grants and a current
    // owner policy whose project catalogue, ceiling and delegation are complete.
    await admin.query(`GRANT INSERT ON ${S}, ${C}, ${R} TO subject_writer`);
    await admin.query(`GRANT SELECT, UPDATE (owner_fence) ON ${namespace}.tenant_authorization_config, ${R},
      ${namespace}.tenant_owner_policy, ${namespace}.tenant_owner_actors TO subject_writer`);
    await admin.query(`GRANT SELECT ON ${S}, ${R}, ${L}, ${namespace}.tenant_authorization_config,
      ${C}, ${credentialNamespace}.legacy_credential_config TO subject_reader`);
    await admin.query(`INSERT INTO ${namespace}.tenant_authorization_config VALUES ($1, ARRAY['denied']), ($2, ARRAY['denied'])`, [A, B]);
    for (const tenant of [A, B]) {
      await admin.query(`INSERT INTO ${namespace}.tenant_owner_policy (tenant_id,catalogue_digest,ceiling) VALUES ($1,$2,ARRAY['*'])`,
        [tenant, catalogueDigest(ownerPolicy.catalogue)]);
      await admin.query(`INSERT INTO ${namespace}.tenant_owner_actors (tenant_id,principal,consumer,active,can_update,delegable)
        VALUES ($1,'manager','admin',true,true,ARRAY['*'])`, [tenant]);
    }
    await admin.query(`INSERT INTO ${credentialNamespace}.legacy_credential_config VALUES ($1,'root'),($2,'root')`, [A, B]);
    await admin.query(`INSERT INTO ${R} VALUES ($1,'uploader',ARRAY['api:entries:create']),
      ($2,'uploader',ARRAY['api:treatments:create']), ($2,'foreign-only',ARRAY['*'])`, [A, B]);
    store = await createStore({ connectionString: writerURI, namespace, credentialNamespace, ownerPolicy });
    // Synthetic management authorization only, deliberately separate from data root/subject authority.
    service = createSubjectAdmin({ store, authorizeManagement: async actor => actor.principal === 'manager' });
    for (let i = 0; i < 2; i++) {
      const worker = { authority: await createAuthority({ connectionString: readerURI, namespace }),
        legacy: await createLegacy({ connectionString: readerURI, namespace: credentialNamespace }) };
      worker.secrets = createSecrets({ providerFor: async () => cryptoProvider,
        store: { async get (tenant, id) { return encrypted.get(tenant + ':' + id); },
          async insert (record) { encrypted.set(record.tenant + ':' + record.id, record); } },
        authorize: async () => true, audit: async () => {}, maxTokenLifetimeSeconds: 28800,
        legacyAuthorityFor: tenant => worker.legacy.read(tenant) });
      workers.push(worker);
    }
    for (const tenant of [A, B]) {
      await workers[0].secrets.encrypt(verifierContext(tenant), 'root', Buffer.from(roots.get(tenant)));
    }
    const enclave = require('../lib/server/enclave')();
    enclave.setApiKey(roots.get(A));
    originalCredential = 'original-' + enclave.getSubjectHash(SUBJECT).substring(0, 16);
    issuedJWT = await workers[0].secrets.signJWT(verifierContext(A), originalCredential, 60);
  });
  beforeEach(async function () {
    await admin.query('DELETE FROM ' + L);
    await admin.query('DELETE FROM ' + S);
    await admin.query('DELETE FROM ' + C);
    await admin.query('DELETE FROM ' + AUDIT);
    await admin.query(`INSERT INTO ${S} (tenant_id,subject_id,display_name,notes,created_at) VALUES
      ($1,$3,'Original','preserved','2026-01-01T00:00:00.000Z'),($2,$3,'Foreign','foreign notes','2026-02-01T00:00:00.000Z')`, [A, B, SUBJECT]);
    await admin.query(`INSERT INTO ${C} VALUES ($1,$3,'original'),($2,$3,'foreign')`, [A, B, SUBJECT]);
    await admin.query(`INSERT INTO ${L} VALUES ($1,$3,'uploader'),($2,$3,'uploader')`, [A, B, SUBJECT]);
  });
  after(async function () {
    try {
      if (store) await store.close();
      for (const worker of workers) { await worker.authority.close(); await worker.legacy.close(); }
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
    }
  });

  it('appends metadata/audit without changing applied migration bytes or inventing historical timestamps', async function () {
    const options = { direct: true, connectionString: adminURI, namespace: 'subject_upgrade' };
    const original = { version: 1, migrations: catalogue.migrations.slice(0, 2) };
    await run('up', { ...options, catalogue: original });
    await admin.query('INSERT INTO subject_upgrade.tenant_authorization_subjects (tenant_id,subject_id) VALUES ($1,$2)', [A, SUBJECT]);
    assert.deepEqual((await run('status', { ...options, catalogue })).pending,
      ['0003_subject_management_metadata', '0004_owner_policy_fencing', '0005_owner_subject_creation', '0006_owner_ownership_operations']);
    const metadata = { version: 1, migrations: catalogue.migrations.slice(0, 3) };
    await run('up', { ...options, catalogue: metadata });
    const applied = (await admin.query('SELECT name,checksum FROM subject_upgrade.schema_migrations ORDER BY name')).rows;
    assert.deepEqual(applied, metadata.migrations.map(({ name, checksum }) => ({ name, checksum })));
    assert.deepEqual((await run('status', { ...options, catalogue })).pending, ['0004_owner_policy_fencing', '0005_owner_subject_creation', '0006_owner_ownership_operations']);
    await run('up', { ...options, catalogue });
    assert.equal((await run('check', { ...options, catalogue })).current, true);
    assert.deepEqual((await admin.query('SELECT notes,created_at FROM subject_upgrade.tenant_authorization_subjects')).rows,
      [{ notes: null, created_at: null }]);
    const checksums = (await admin.query(
      'SELECT name,checksum FROM subject_upgrade.schema_migrations WHERE name=ANY($1::text[]) ORDER BY name',
      [applied.map(row => row.name)])).rows;
    assert.deepEqual(checksums, applied);
  });

  it('atomically renames stable identity and credential prefix while preserving omitted notes/time and foreign state', async function () {
    const foreignBefore = (await snapshot());
    const result = await service.update(context, SUBJECT, { name: 'Renamed Test_user', roles: ['uploader'] });
    assert.deepEqual(result, { subjectId: SUBJECT, name: 'Renamed Test_user', roles: ['uploader'], notes: 'preserved',
      created_at: '2026-01-01T00:00:00.000Z' });
    assert.equal((await workers[1].legacy.read(A)).subjects[0].tokenPrefix, 'renamedtes');
    assert.equal((await workers[1].authority.subjectSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: SUBJECT } })).sub,
      'Renamed Test_user');
    assert.equal(await protectedOperation(workers[1], A, { apiSecret: originalCredential }), true);
    assert.equal(await protectedOperation(workers[1], A, { token: issuedJWT }), true);
    assert.equal(await protectedOperation(workers[1], B, { apiSecret: originalCredential }), false);
    const after = await snapshot();
    for (const table of [S, L, C]) {
      assert.deepEqual(after[table].filter(row => row.tenant_id === B), foreignBefore[table].filter(row => row.tenant_id === B));
    }
    assert.equal(after[AUDIT][0].principal, 'manager');
    assert.equal(after[AUDIT][0].consumer, 'admin');
    assert.doesNotMatch(JSON.stringify(after[AUDIT]), /preserved|Renamed|original-/);
  });

  it('revokes omitted roles for the same earlier raw and JWT credentials on the next operation across workers', async function () {
    for (const worker of workers) assert.equal(await protectedOperation(worker, A, { token: issuedJWT }), true);
    await service.update(context, SUBJECT, { name: 'Original' });
    for (const worker of workers) {
      assert.equal(await protectedOperation(worker, A, { token: issuedJWT }), false);
      assert.equal(await protectedOperation(worker, A, { apiSecret: originalCredential }), false);
      assert.equal((await worker.secrets.verifyLegacyCredential(verifierContext(A), { token: issuedJWT })).subjectId, SUBJECT);
    }
    assert.equal((await admin.query('SELECT * FROM ' + L + ' WHERE tenant_id = $1', [B])).rows.length, 1);
  });

  it('deletes credential metadata and authority together and denies the same earlier credential on both workers', async function () {
    assert.equal(await protectedOperation(workers[0], A, { token: issuedJWT }), true);
    await service.remove(context, SUBJECT);
    for (const worker of workers) {
      assert.equal(await protectedOperation(worker, A, { token: issuedJWT }), false);
      assert.equal(await protectedOperation(worker, A, { apiSecret: originalCredential }), false);
      assert.equal(await worker.authority.subjectSnapshot({ tenant: A, principal: { kind: 'subject', subjectId: SUBJECT } }), null);
    }
    const rows = await snapshot();
    for (const table of [S, L, C]) assert.deepEqual(rows[table].map(row => row.tenant_id), [B]);
  });

  it('refuses unknown and foreign-only roles, absent subjects and incomplete metadata without partial writes', async function () {
    const before = await snapshot();
    for (const role of ['unknown', 'foreign-only']) {
      await assert.rejects(service.update(context, SUBJECT, { name: 'Changed', roles: [role] }),
        { code: 'SUBJECT_ADMIN_UNKNOWN_ROLE' });
    }
    await assert.rejects(service.update(context, 'absent', { name: 'Missing' }), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
    await assert.rejects(service.remove(context, 'absent'), { code: 'SUBJECT_ADMIN_NOT_FOUND' });
    assert.deepEqual(await snapshot(), before);
    await admin.query('DELETE FROM ' + C + ' WHERE tenant_id = $1', [A]);
    const incomplete = await snapshot();
    await assert.rejects(service.update(context, SUBJECT, { name: 'Incomplete' }), { code: 'SUBJECT_ADMIN_METADATA_MISSING' });
    await assert.rejects(service.remove(context, SUBJECT), { code: 'SUBJECT_ADMIN_METADATA_MISSING' });
    assert.deepEqual(await snapshot(), incomplete);
  });

  it('preserves explicit empty notes, supplied creation time and exact known role assignment', async function () {
    const updated = await service.update(context, SUBJECT, { name: '!!!', notes: '',
      created_at: '2026-03-01T00:00:00.000Z', roles: ['uploader'] });
    assert.equal(updated.notes, '');
    assert.equal(updated.created_at, '2026-03-01T00:00:00.000Z');
    assert.equal((await workers[1].legacy.read(A)).subjects[0].tokenPrefix, '');
    assert.equal(await protectedOperation(workers[1], A, { token: issuedJWT }), true);
  });

  it('rolls back rename, role links, credential prefix and deletion when final audit insertion fails', async function () {
    const before = await snapshot();
    await admin.query(`ALTER TABLE ${AUDIT} ADD CONSTRAINT fail_control CHECK (operation = 'impossible')`);
    try {
      await assert.rejects(service.update(context, SUBJECT, { name: 'Rollback' }), { code: 'SUBJECT_ADMIN_STORE_UNAVAILABLE' });
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(service.remove(context, SUBJECT), { code: 'SUBJECT_ADMIN_STORE_UNAVAILABLE' });
      assert.deepEqual(await snapshot(), before);
      assert.equal(await protectedOperation(workers[1], A, { token: issuedJWT }), true);
    } finally { await admin.query(`ALTER TABLE ${AUDIT} DROP CONSTRAINT fail_control`); }
  });

  it('serializes concurrent subject replacements without mixing a name with another write prefix or grants', async function () {
    const second = await createStore({ connectionString: writerURI, namespace, credentialNamespace, ownerPolicy });
    try {
      const other = createSubjectAdmin({ store: second, authorizeManagement: async () => true });
      await Promise.all([service.update(context, SUBJECT, { name: 'First', roles: ['uploader'], notes: 'one' }),
        other.update(context, SUBJECT, { name: 'Second', notes: 'two' })]);
      const row = (await admin.query('SELECT display_name, notes FROM ' + S + ' WHERE tenant_id = $1', [A])).rows[0];
      const prefix = (await workers[0].legacy.read(A)).subjects[0].tokenPrefix;
      assert.equal(prefix, row.display_name.toLowerCase());
      const grants = (await admin.query('SELECT role_name FROM ' + L + ' WHERE tenant_id = $1', [A])).rows;
      assert.deepEqual(grants, row.display_name === 'First' ? [{ role_name: 'uploader' }] : []);
      assert.equal(row.notes, row.display_name === 'First' ? 'one' : 'two');
    } finally { await second.close(); }
  });

  it('refuses serving credentials as writer and prevents raw serving-role mutations of every authority table', async function () {
    await assert.rejects(createStore({ connectionString: readerURI, namespace, credentialNamespace, ownerPolicy }),
      { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
    await assert.rejects(createAuthority({ connectionString: writerURI, namespace }), { code: 'TENANT_AUTHORITY_UNSAFE' });
    const reader = new Client({ connectionString: readerURI });
    await reader.connect();
    try {
      for (const table of [S, R, L, C, AUDIT, namespace + '.tenant_authorization_config',
        credentialNamespace + '.legacy_credential_config']) {
        await assert.rejects(reader.query('DELETE FROM ' + table), { code: '42501' });
        await assert.rejects(reader.query('UPDATE ' + table + ' SET tenant_id = tenant_id'), { code: '42501' });
        await assert.rejects(reader.query('INSERT INTO ' + table + ' DEFAULT VALUES'), { code: '42501' });
      }
    } finally { await reader.end(); }
    const before = await snapshot();
    await assert.rejects(service.update({ ...context, principal: 'root' }, SUBJECT, { name: 'Unauthorized' }),
      { code: 'SUBJECT_ADMIN_FORBIDDEN' });
    assert.deepEqual(await snapshot(), before);
  });

  it('enforces tenant RLS on writer credentials and rejects disabled RLS at adapter startup', async function () {
    const writer = new Client({ connectionString: writerURI });
    await writer.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
      assert.deepEqual((await writer.query('SELECT tenant_id FROM ' + C)).rows, [{ tenant_id: A }]);
      await writer.query('ROLLBACK');
      await admin.query('ALTER TABLE ' + C + ' DISABLE ROW LEVEL SECURITY');
      try {
        await assert.rejects(createStore({ connectionString: writerURI, namespace, credentialNamespace, ownerPolicy }),
          { code: 'SUBJECT_ADMIN_STORE_UNSAFE' });
        await writer.query('BEGIN');
        await writer.query("SELECT set_config('app.current_tenant_id', $1, true)", [A]);
        assert.deepEqual((await writer.query('SELECT tenant_id FROM ' + C + ' ORDER BY tenant_id')).rows,
          [{ tenant_id: A }, { tenant_id: B }]);
        await writer.query('ROLLBACK');
      } finally { await admin.query('ALTER TABLE ' + C + ' ENABLE ROW LEVEL SECURITY'); }
    } finally { await writer.end(); }
  });
});
