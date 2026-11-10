'use strict';

// Operator-assisted ownership on actual PostgreSQL: list, add co-owner, transfer,
// recover, through the component and the private internal service (UDS and
// internal HTTP). Synthetic tenants and identifiers only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { run } = require('../lib/migrations/postgres');
const catalogue = require('../lib/tenant-authorization/postgres-candidate.json');
const createStore = require('../lib/tenant-ownership/postgres');
const { createOwnershipOperations } = require('../lib/tenant-ownership/component');
const service = require('../lib/tenant-ownership/service');
const clients = require('../lib/server/internal-api/clients');
const { createOwnerPolicy, catalogueDigest } = require('../lib/subject-admin/owner-policy');
const scope = require('../lib/storage/tenant-scope');
const { optInSuite } = require('./support/opt-in');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NS = 'own_auth';
const t = name => NS + '.' + name;
const CONSUMER = 'tenant-admin';
const ref = principal => ({ principal, consumer: CONSUMER });
const OPERATOR = { principal: 'synthetic_operator', consumer: 'operator_plane' };
const CEILING = ['api:*:read', 'api:entries:create'];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_TENANT_OWNERSHIP_DOCKER_TEST === '1',
  'NS_TENANT_OWNERSHIP_DOCKER_TEST=1')('operator-assisted tenant ownership (disposable PostgreSQL, private service)', function () {
  this.timeout(60000);
  const container = 'ns-own-' + crypto.randomBytes(6).toString('hex');
  let owned = false, previousMode, admin, adminURI, operatorURI, store, socketDir;
  const opened = [];
  const operatorFor = tenants => createOwnershipOperations({ store, authorizeOperator: service.tenantSetAuthority({ ...OPERATOR, tenants }) });

  async function rows (tenant) {
    const actors = (await admin.query(`SELECT principal,consumer,active,can_update,delegable FROM ${t('tenant_owner_actors')}
      WHERE tenant_id=$1 ORDER BY principal,consumer`, [tenant])).rows;
    const audit = (await admin.query(`SELECT principal,consumer,subject_id,operation,outcome,detail FROM ${t('tenant_subject_admin_audit')}
      WHERE tenant_id=$1 ORDER BY event_time,event_id`, [tenant])).rows;
    return { actors, audit };
  }
  async function owners (tenant) {
    return (await rows(tenant)).actors.filter(row => row.active && row.can_update).map(row => row.principal).sort();
  }
  async function listen (operations, transport = 'unix') {
    let endpoint;
    if (transport === 'unix') {
      endpoint = { socketPath: path.join(socketDir, crypto.randomBytes(4).toString('hex') + '.sock'), maxBytes: 65536, timeoutMs: 10000 };
    } else {
      const port = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
      endpoint = { url: 'http://127.0.0.1:' + port + '/', trust: 'network', maxBytes: 65536, timeoutMs: 10000 };
    }
    opened.push(await service.open(endpoint, { ownership: operations, operator: OPERATOR }));
    return clients.ownershipOperations(endpoint);
  }

  before(async function () {
    previousMode = scope.getTenancyMode();
    scope.setTenancyMode('multi');
    socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-own-'));
    fs.chmodSync(socketDir, 0o700);
    const password = crypto.randomBytes(24).toString('hex');
    execFileSync('docker', ['run', '--name', container, '-d', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=operator',
      '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=ownership', 'postgres:16'],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    owned = true;
    const port = docker(['port', container, '5432/tcp']).split(':').pop();
    adminURI = 'postgres://operator:' + password + '@127.0.0.1:' + port + '/ownership';
    const deadline = Date.now() + 20000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'operator']); admin = new Client({ connectionString: adminURI }); await admin.connect(); ready = true; }
      catch { admin = null; await sleep(200); }
    }
    assert.ok(ready, 'disposable PostgreSQL ready');
    await run('up', { direct: true, connectionString: adminURI, namespace: NS, catalogue });
    assert.equal((await run('check', { direct: true, connectionString: adminURI, namespace: NS, catalogue })).current, true);
    const rolePassword = crypto.randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ownership_operator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${rolePassword}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${NS} TO ownership_operator`);
    await admin.query(`GRANT SELECT, UPDATE (owner_fence) ON ${t('tenant_authorization_config')}, ${t('tenant_owner_policy')} TO ownership_operator`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE (active, can_update, delegable) ON ${t('tenant_owner_actors')} TO ownership_operator`);
    await admin.query(`GRANT SELECT ON ${t('tenant_authorization_subjects')} TO ownership_operator`);
    await admin.query(`GRANT INSERT ON ${t('tenant_subject_admin_audit')} TO ownership_operator`);
    const url = new URL(adminURI); url.username = 'ownership_operator'; url.password = rolePassword; operatorURI = url.toString();
    store = await createStore({ connectionString: operatorURI, namespace: NS });
  });

  beforeEach(async function () {
    for (const table of ['tenant_subject_admin_audit', 'tenant_owner_actors', 'tenant_owner_policy', 'tenant_authorization_subjects', 'tenant_authorization_config']) {
      await admin.query('DELETE FROM ' + t(table));
    }
    await admin.query(`INSERT INTO ${t('tenant_authorization_config')} (tenant_id, anonymous_roles) VALUES ($1, ARRAY['denied']), ($2, ARRAY['denied'])`, [A, B]);
    await admin.query(`INSERT INTO ${t('tenant_owner_policy')} (tenant_id, catalogue_digest, ceiling) VALUES ($1,$3,$4), ($2,$3,$4)`, [A, B, catalogueDigest(['*']), CEILING]);
    await admin.query(`INSERT INTO ${t('tenant_authorization_subjects')} (tenant_id, subject_id) VALUES
      ($1,'s_owner1'),($1,'s_owner2'),($1,'s_new'),($1,'s_new2'),($2,'s_bowner'),($2,'s_new')`, [A, B]);
    await admin.query(`INSERT INTO ${t('tenant_owner_actors')} (tenant_id,principal,consumer,active,can_update,delegable) VALUES
      ($1,'s_owner1',$3,true,true,ARRAY['api:*:read']), ($2,'s_bowner',$3,true,true,ARRAY['api:*:read'])`, [A, B, CONSUMER]);
  });

  after(async function () {
    try {
      for (const listener of opened) await listener.close();
      if (store) await store.close();
      if (admin) await admin.end();
    } finally {
      scope.setTenancyMode(previousMode);
      if (owned) docker(['rm', '-f', '-v', container]);
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });

  it('refuses an operator store whose identity can delete or rewrite authority rows', async function () {
    await admin.query(`GRANT DELETE ON ${t('tenant_owner_actors')} TO ownership_operator`);
    try {
      await assert.rejects(createStore({ connectionString: operatorURI, namespace: NS }), { code: 'OWNERSHIP_STORE_UNSAFE' });
    } finally { await admin.query(`REVOKE DELETE ON ${t('tenant_owner_actors')} FROM ownership_operator`); }
    await admin.query(`GRANT UPDATE (ceiling) ON ${t('tenant_owner_policy')} TO ownership_operator`);
    try {
      await assert.rejects(createStore({ connectionString: operatorURI, namespace: NS }), { code: 'OWNERSHIP_STORE_UNSAFE' });
    } finally { await admin.query(`REVOKE UPDATE (ceiling) ON ${t('tenant_owner_policy')} FROM ownership_operator`); }
  });

  it('adds a co-owner atomically with an applied audit record, and audits refused adds without ownership effect', async function () {
    const ops = operatorFor([A, B]);
    assert.deepEqual(await ops.list(OPERATOR, { tenant: A }), { owners: [ref('s_owner1')] });
    const added = await ops.add(OPERATOR, { tenant: A, owner: ref('s_owner2'), delegable: ['api:entries:create'], expectedOwners: [ref('s_owner1')] });
    assert.equal(added.outcome, 'applied');
    assert.deepEqual(added.owners, [ref('s_owner1'), ref('s_owner2')]);
    const refusals = [
      [{ owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1'), ref('s_owner2')] }, 'OWNERSHIP_ALREADY_OWNER'],
      [{ owner: ref('s_missing'), delegable: [], expectedOwners: [ref('s_owner1'), ref('s_owner2')] }, 'OWNERSHIP_SUBJECT_UNKNOWN'],
      [{ owner: ref('s_new'), delegable: ['*'], expectedOwners: [ref('s_owner1'), ref('s_owner2')] }, 'OWNERSHIP_DELEGATION_EXCEEDS_CEILING'],
      [{ owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_owner1')] }, 'OWNERSHIP_CONFLICT']
    ];
    for (const [input, code] of refusals) {
      const result = await ops.add(OPERATOR, { tenant: A, ...input });
      assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'refused', code });
    }
    const state = await rows(A);
    assert.deepEqual(await owners(A), ['s_owner1', 's_owner2']);
    assert.deepEqual(state.actors.find(row => row.principal === 's_owner2').delegable, ['api:entries:create']);
    assert.deepEqual(state.audit.map(row => [row.operation, row.outcome, row.detail.code || null]),
      [['owner-add', 'applied', null], ...refusals.map(([, code]) => ['owner-add', 'refused', code])]);
    assert(state.audit.every(row => row.principal === OPERATOR.principal && row.consumer === OPERATOR.consumer));
    assert.deepEqual((await rows(B)).audit, [], 'foreign tenant audit untouched');
  });

  it('transfers ownership so the previous owner loses owner-plane authority and the new owner gains it', async function () {
    const ops = operatorFor([A]);
    const moved = await ops.transfer(OPERATOR, { tenant: A, from: ref('s_owner1'), to: ref('s_new'), expectedOwners: [ref('s_owner1')] });
    assert.deepEqual({ outcome: moved.outcome, owners: moved.owners }, { outcome: 'applied', owners: [ref('s_new')] });
    const state = await rows(A);
    assert.deepEqual(state.actors.map(row => [row.principal, row.active, row.delegable]),
      [['s_new', true, ['api:*:read']], ['s_owner1', false, ['api:*:read']]]);
    const notOwner = await ops.transfer(OPERATOR, { tenant: A, from: ref('s_owner1'), to: ref('s_new2'), expectedOwners: [ref('s_new')] });
    assert.equal(notOwner.code, 'OWNERSHIP_NOT_OWNER');
    // The owner plane's own current-authority read (owner-policy.js) sees the change.
    const policy = createOwnerPolicy({ namespace: NS, catalogue: ['*'] });
    const check = async principal => {
      await admin.query('BEGIN');
      try { await policy.authorizePermissions(admin, { tenant: A, principal, consumer: CONSUMER }, []); return true; }
      catch (error) { assert.equal(error.code, 'SUBJECT_ADMIN_FORBIDDEN'); return false; }
      finally { await admin.query('ROLLBACK'); }
    };
    assert.equal(await check('s_owner1'), false);
    assert.equal(await check('s_new'), true);
  });

  it('recovers an orphaned tenant to one named owner without returning or logging any credential', async function () {
    const ops = operatorFor([A]);
    await ops.add(OPERATOR, { tenant: A, owner: ref('s_owner2'), delegable: [], expectedOwners: [ref('s_owner1')] });
    // Both owner subjects removed out of band: the tenant has owner actor rows but no usable owner.
    await admin.query(`DELETE FROM ${t('tenant_authorization_subjects')} WHERE tenant_id=$1 AND subject_id IN ('s_owner1','s_owner2')`, [A]);
    assert.deepEqual(await ops.list(OPERATOR, { tenant: A }), { owners: [] });
    const lines = [];
    const saved = ['log', 'info', 'warn', 'error'].map(level => [level, console[level]]);
    for (const [level] of saved) console[level] = (...args) => lines.push(args.join(' '));
    let recovered;
    try {
      recovered = await ops.recover(OPERATOR, { tenant: A, owner: ref('s_new'), delegable: ['api:*:read'], expectedOwners: [] });
    } finally { for (const [level, fn] of saved) console[level] = fn; }
    assert.deepEqual(lines, [], 'recovery writes nothing to the process log');
    assert.deepEqual(Object.keys(recovered).sort(), ['code', 'event', 'outcome', 'owners']);
    assert.deepEqual({ outcome: recovered.outcome, owners: recovered.owners }, { outcome: 'applied', owners: [ref('s_new')] });
    const state = await rows(A);
    assert.deepEqual(state.actors.filter(row => row.active).map(row => row.principal), ['s_new']);
    const record = state.audit.at(-1);
    assert.equal(record.operation, 'owner-recover');
    assert.deepEqual(Object.keys(record.detail).sort(), ['after', 'before', 'expected', 'owner']);
    const unchanged = await ops.recover(OPERATOR, { tenant: A, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_new')] });
    assert.equal(unchanged.code, 'OWNERSHIP_UNCHANGED');
    // Recovery also retires remaining owners when the operator names the observed set.
    const again = await ops.add(OPERATOR, { tenant: A, owner: ref('s_new2'), delegable: [], expectedOwners: [ref('s_new')] });
    assert.equal(again.outcome, 'applied');
    const replaced = await ops.recover(OPERATOR, { tenant: A, owner: ref('s_new2'), delegable: [], expectedOwners: [ref('s_new'), ref('s_new2')] });
    assert.deepEqual(replaced.owners, [ref('s_new2')]);
  });

  it('race control: two concurrent transfers from one owner, exactly one wins and both attempts are audited', async function () {
    const ops = operatorFor([A]);
    const holder = new Client({ connectionString: adminURI });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ${t('tenant_owner_actors')} WHERE tenant_id=$1 AND principal='s_owner1' FOR UPDATE`, [A]);
      const attempts = ['s_new', 's_new2'].map(to => ops.transfer(OPERATOR, { tenant: A, from: ref('s_owner1'), to: ref(to), expectedOwners: [ref('s_owner1')] }));
      const deadline = Date.now() + 10000;
      let waiting = 0;
      while (Date.now() < deadline) {
        waiting = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name='nightscout-ownership-ops' AND wait_event_type='Lock'`)).rows[0].n;
        if (waiting === 2) break;
        await sleep(25);
      }
      assert.equal(waiting, 2, 'both transfers are inside their transactions and blocked before the barrier is released');
      await holder.query('COMMIT');
      const results = await Promise.all(attempts);
      const outcomes = results.map(result => result.outcome + ':' + (result.code || '')).sort();
      assert.equal(results.filter(result => result.outcome === 'applied').length, 1, 'exactly one transfer applies: ' + outcomes.join(','));
      assert.equal(results.filter(result => result.outcome === 'refused').length, 1, 'the other transfer is refused: ' + outcomes.join(','));
      const winner = results.find(result => result.outcome === 'applied').owners[0].principal;
      assert.deepEqual(await owners(A), [winner], 'one owner, the winner; the other target never became an owner');
      const audit = (await rows(A)).audit.filter(row => row.operation === 'owner-transfer');
      assert.equal(audit.length, 2, 'audit shows both attempts');
      assert.deepEqual(audit.map(row => row.outcome).sort(), ['applied', 'refused']);
      assert.deepEqual(new Set(audit.map(row => row.subject_id)), new Set(['s_new', 's_new2']));
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
  });

  it('foreign-authority control: an operator bound to tenant B acting on tenant A has no effect in either tenant', async function () {
    const before = { a: await rows(A), b: await rows(B) };
    const foreign = operatorFor([B]);
    const input = { tenant: A, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_owner1')] };
    for (const call of [() => foreign.add(OPERATOR, input), () => foreign.recover(OPERATOR, input),
      () => foreign.transfer(OPERATOR, { tenant: A, from: ref('s_owner1'), to: ref('s_new'), expectedOwners: [ref('s_owner1')] }),
      () => foreign.list(OPERATOR, { tenant: A })]) await assert.rejects(call(), { code: 'OWNERSHIP_FORBIDDEN' });
    // An authority adapter that answers for its own bound tenant instead of the requested one.
    const misbound = createOwnershipOperations({ store, authorizeOperator: async request => ({ allowed: true, current: true, tenant: B, plane: 'operator', principal: request.principal, consumer: request.consumer }) });
    await assert.rejects(misbound.add(OPERATOR, input), { code: 'OWNERSHIP_FORBIDDEN' });
    const stale = createOwnershipOperations({ store, authorizeOperator: async request => ({ allowed: true, current: false, tenant: request.tenant, plane: 'operator', principal: request.principal, consumer: request.consumer }) });
    await assert.rejects(stale.add(OPERATOR, input), { code: 'OWNERSHIP_FORBIDDEN' });
    const ownerPlane = createOwnershipOperations({ store, authorizeOperator: async request => ({ allowed: true, current: true, tenant: request.tenant, plane: 'owner', principal: request.principal, consumer: request.consumer }) });
    await assert.rejects(ownerPlane.add(OPERATOR, input), { code: 'OWNERSHIP_FORBIDDEN' });
    // Private service: the same operator binding, over the wire.
    const client = await listen(foreign);
    assert.deepEqual(await client.addOwner(input), { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null });
    assert.deepEqual(await client.listOwners({ tenant: A }), { outcome: 'denied', code: 'OWNERSHIP_FORBIDDEN', event: null });
    assert.deepEqual({ a: await rows(A), b: await rows(B) }, before, 'no actor or audit row changed in A or B');
    // Positive control: the same binding acts on its own tenant.
    const own = await client.addOwner({ tenant: B, owner: ref('s_new'), delegable: [], expectedOwners: [ref('s_bowner')] });
    assert.equal(own.outcome, 'applied');
    assert.deepEqual(await rows(A), before.a);
  });

  it('serves the operations over the private internal service on UDS and internal HTTP with schema-checked results', async function () {
    const ops = operatorFor([A]);
    for (const transport of ['unix', 'http']) {
      const client = await listen(ops, transport);
      const current = (await client.listOwners({ tenant: A })).owners;
      const next = current[0].principal === 's_owner1' ? 's_new' : 's_owner1';
      const moved = await client.transferOwner({ tenant: A, from: current[0], to: ref(next), expectedOwners: current });
      assert.equal(moved.outcome, 'applied', transport);
      assert.match(moved.event, /^[0-9a-f-]{36}$/);
      assert.deepEqual(moved.owners, [ref(next)]);
      const stale = await client.transferOwner({ tenant: A, from: ref(next), to: current[0], expectedOwners: current });
      assert.deepEqual({ outcome: stale.outcome, code: stale.code }, { outcome: 'refused', code: 'OWNERSHIP_CONFLICT' });
      await assert.rejects(client.addOwner({ tenant: A, owner: ref('s_new2'), delegable: [], expectedOwners: [ref(next)], credential: 'x' }),
        { code: 'INTERNAL_API_SCHEMA_REFUSED' });
    }
    assert.deepEqual(await owners(A), ['s_owner1']);
  });
});
