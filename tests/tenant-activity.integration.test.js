'use strict';

// Durable pause/suspend on actual PostgreSQL with the actual selected evaluator
// role process (child), its realtime consumer and a controlled UDS sink, plus
// the owner router over the actual owner activity store. Synthetic tenants A/B.
// covers: lib/tenant-activity/postgres.js, lib/server/serve/evaluator-runtime.js, lib/server/serve/evaluator-consumers.js, lib/server/serve/evaluator-preview.js
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const request = require('supertest');
const scope = require('../lib/storage/tenant-scope');
const { run } = require('../lib/migrations/postgres');
const activityStore = require('../lib/tenant-activity/postgres');
const { createOwnerActivity } = require('../lib/tenant-activity/owner');
const { optInSuite } = require('./support/opt-in');
const createLab = require('./fixtures/evaluator-consumers-native');

optInSuite(process.env.NS_EVALUATOR_CONSUMERS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_EVALUATOR_CONSUMERS_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'tenant activity: durable pause/suspend on actual PostgreSQL and the actual evaluator role', function () {
    this.timeout(90000);
    const lab = createLab();
    const migrationNamespace = 'activity_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const provisioningNamespace = migrationNamespace + '_provision';
    const roles = { reader: migrationNamespace + '_reader', owner: migrationNamespace + '_owner', operator: migrationNamespace + '_operator' };
    let namespace;
    const urls = {}, stores = {}; let prior, initialVersions, provisioned = false;
    const operatorActor = tenant => ({ tenant, principal: 'synthetic-operator', consumer: 'operator-cli' });
    const ownerActor = tenant => ({ tenant, principal: 'owner', consumer: 'tenant-admin' });
    const catalogue = require('../lib/tenant-lifecycle/postgres-candidate.json');
    const lockKeys = () => Object.fromEntries([lab.A,lab.B].map(tenant=>[tenant,require('../lib/tenant-registry/rules').lockKey(tenant)]));
    let backfill, ownerUrl;
    const ceremonyRole = migrationNamespace + '_ceremony', schemaOwner = migrationNamespace + '_schema_owner';
    before(async function () {
      prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
      await lab.open();
      // Runtime activity and native receipt/restore authority use the actual
      // provisioned control namespace. Migration primitives stay isolated.
      namespace=lab.registryNamespaces.control;
      const admin = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
      // Migrations run as a NOSUPERUSER schema owner, as in a deployment: the
      // backfill must see every tenant despite FORCE ROW LEVEL SECURITY.
      const ownerPassword = randomBytes(24).toString('hex');
      await lab.admin.query(`CREATE ROLE "${schemaOwner}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ownerPassword}'`);
      ownerUrl = new URL(admin); ownerUrl.username = schemaOwner; ownerUrl.password = ownerPassword;
      await lab.admin.query(`CREATE SCHEMA "${migrationNamespace}" AUTHORIZATION "${schemaOwner}"`);
      // The runner issues CREATE SCHEMA IF NOT EXISTS; held only while migrating.
      const database = (await lab.admin.query('SELECT current_database() AS name')).rows[0].name;
      await lab.admin.query(`GRANT CREATE ON DATABASE "${database}" TO "${schemaOwner}"`);
      await run('up', { direct: true, connectionString: ownerUrl.toString(), namespace: migrationNamespace,
        catalogue: { ...catalogue, migrations: catalogue.migrations.filter(m => m.name < '0007_tenant_activity') } });
      for (const [tenant, key] of Object.entries(lockKeys())) {
        await lab.admin.query(`INSERT INTO "${migrationNamespace}".tenant_lifecycle_windows (tenant_id,lock_key,phase,generation) VALUES ($1,$2,'active',1)`, [tenant, key]);
      }
      await run('up', { direct: true, connectionString: ownerUrl.toString(), namespace: migrationNamespace, catalogue });
      // The C/D transaction primitive is independent of the A/B evaluator
      // roster. Its rows must not enter that roster's maintained WAL stream.
      await run('up', { direct: true, connectionString: ownerUrl.toString(), namespace: provisioningNamespace, catalogue });
      await lab.admin.query(`REVOKE CREATE ON DATABASE "${database}" FROM "${schemaOwner}"`);
      backfill = { rows: (await lab.admin.query(`SELECT tenant_id,version::text,paused,suspended,deletion_request_id FROM "${migrationNamespace}".tenant_activity ORDER BY tenant_id`)).rows,
        audit: (await lab.admin.query(`SELECT tenant_id,verb,authority,principal,consumer FROM "${migrationNamespace}".tenant_activity_audit ORDER BY tenant_id`)).rows,
        forced: (await lab.admin.query(`SELECT relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)`, ['"' + migrationNamespace + '".tenant_lifecycle_windows'])).rows[0].relforcerowsecurity };
      for (const [kind, role] of [...Object.entries(roles), ['ceremony', ceremonyRole]]) {
        const password = randomBytes(24).toString('hex');
        await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        const url = new URL(admin); url.username = role; url.password = password; urls[kind] = url.toString();
      }
      for (const statement of activityStore.grants({ namespace, ...roles, ceremony: ceremonyRole })) await lab.admin.query(statement);
      await lab.admin.query(`GRANT SELECT, INSERT, UPDATE ON "${namespace}".tenant_lifecycle_requests TO "${ceremonyRole}"`);
      await lab.admin.query(`GRANT SELECT, INSERT, UPDATE ON "${namespace}".tenant_lifecycle_ceremony TO "${ceremonyRole}"`);
      // Writer-driven input: the owner and operator writers mark the evaluator's completed-work row
      // pending in their own transactions (class b), as ordinary deployment grants allow.
      for (const sql of require('../lib/writer-driven').grants({ namespace: lab.replayNamespace, roles: [roles.owner, roles.operator] })) await lab.admin.query(sql);
      for (const kind of Object.keys(roles)) stores[kind] = await activityStore.create({ connectionString: urls[kind], namespace, capability: kind,
        ...(kind === 'reader' ? {} : { pending: lab.pendingBinding }) });
    });
    beforeEach(async function () {
      await lab.reset(); provisioned = false;
      await lab.admin.query(`DROP POLICY IF EXISTS synthetic_unreadable_a ON "${namespace}".tenant_activity`);
      for (const table of ['tenant_activity_audit', 'tenant_lifecycle_ceremony', 'tenant_lifecycle_requests']) await lab.admin.query(`DELETE FROM "${namespace}".${table}`);
      // The maintained slot replays committed history across cases. Reset
      // activity values without rolling their authoritative version backward.
      const reset = await lab.admin.query(`UPDATE "${namespace}".tenant_activity SET version=version+1,paused=false,suspended=false,deletion_request_id=NULL,paused_before_deletion=NULL RETURNING tenant_id,version::text`);
      initialVersions = new Map(reset.rows.map(row => {
        const version = Number(row.version); assert(Number.isSafeInteger(version)); return [row.tenant_id, version];
      }));
    });
    after(async function () {
      const errors = [];
      await lab.stopConsumers().catch(error => errors.push(error));
      for (const store of Object.values(stores)) await store.close().catch(error => errors.push(error));
      if (lab.admin) {
        for (const owned of [migrationNamespace, provisioningNamespace]) await lab.admin.query('DROP SCHEMA IF EXISTS "' + owned + '" CASCADE').catch(error => errors.push(error));
        for (const role of [...Object.values(roles), ceremonyRole, schemaOwner]) {
          await lab.admin.query(`DROP OWNED BY "${role}"`).catch(error => errors.push(error));
          await lab.admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(error => errors.push(error));
        }
      }
      await lab.close().catch(error => errors.push(error));
      scope.setTenancyMode(prior);
      if (errors.length) throw new globalThis.AggregateError(errors, 'activity fixture cleanup refused');
    });
    async function reading (value, tenant) {
      const at = await lab.epoch();
      await lab.persistDomains({ entries: [{ _id: 'synthetic-' + value + '-' + at, type: 'sgv', sgv: value, date: at - 1000,
        dateString: new Date(at - 1000).toISOString(), direction: 'Flat' }] }, tenant);
    }
    async function boot (change) {
      if (!provisioned) await lab.provisionPreview();
      provisioned = true; await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(change));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      // The two test tenants and their readings predate this producer slot.
      await worker.call('acquire', lab.A); await worker.call('acquire', lab.B);
      await worker.call('flush', lab.A); await worker.call('flush', lab.B); return worker;
    }
    const effects = tenant => lab.sinkEffects.filter(row => row.tenant === tenant);
    const tenantHealth = (health, tenant) => health.tenants.find(row => row.tenant === tenant);
    const consumerHealth = (health, tenant) => health.consumers.tenants.find(row => row.tenant === tenant);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // A typed bootstrap can initialize empty bookkeeping without completing
    // clinical input. Compare the completed semantic fields, not SQL NULL shape.
    async function noCompletion(before,label){
      const after=await lab.previewCompleted(lab.A);
      for(const key of ['checkpoint','output_identity','output_digest','output_revision','output_restore_generation'])assert.deepEqual(after[key],before[key],label+' '+key);
      assert.deepEqual(after.projection?.[0]?.output??null,before.projection?.[0]?.output??null,label+' output');
      assert.deepEqual(after.work_completed??Array(6).fill(null),before.work_completed??Array(6).fill(null),label+' covered versions');
    }

    it('paused A: no acquisition, timer work or output for A, uploads still stored; B unaffected; unpause recomputes before publishing', async function () {
      await reading(50, lab.A); await reading(50, lab.B);
      const paused = await stores.owner.transition(ownerActor(lab.A), 'pause', { expectedVersion: initialVersions.get(lab.A) });
      assert.equal(paused.state, 'paused');
      // Phase 1: actual committed B work progresses while A remains paused.
      // The maintained worker does not schedule unchanged idle evaluations.
      await lab.provisionPreview(); provisioned = true;
      const startCheckpoint = await lab.previewCompleted(lab.A), completedBefore=await lab.previewCompleted(lab.A); // before any evaluator process exists
      let worker = await boot(document => { document.timeIntervalMs = 150; });
      await reading(48, lab.A); // new A data while paused: any acquisition would advance A's checkpoint
      await worker.call('acquire', lab.A); await worker.call('tick', lab.A); await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      const bBefore = tenantHealth(await worker.call('health'), lab.B).cycles;
      const bCheckpoint = await lab.previewCompleted(lab.B);
      await reading(49, lab.B);
      await sleep(700); // preserve the existing bounded observation window
      await worker.call('flush', lab.A);
      let health = await worker.call('health');
      lab.traceConsumer('activity-paused-before-verdict', { checkpointA: await lab.previewCompleted(lab.A), checkpointB: await lab.previewCompleted(lab.B),
        effectsA: effects(lab.A).length, a: tenantHealth(health, lab.A), b: tenantHealth(health, lab.B), consumerA: consumerHealth(health, lab.A) });
      // Paused uploads keep their pending mark (the write is owed); they cannot earn clinical
      // coverage, run a clinical cycle or publish output.
      assert.equal(tenantHealth(health,lab.A).cycles,0,'ACTIVITY_PAUSED_NO_CLINICAL_ACQUISITION');
      await noCompletion(completedBefore,'ACTIVITY_PAUSED_NO_COMPLETION');
      const pending=(await lab.admin.query('SELECT work_observed,work_completed,work_pending_at FROM "'+lab.replayNamespace+'".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2',[lab.A,lab.consumerName+'-completed'])).rows[0];
      const workState=require('../lib/pgstream/work-state'),observedA=workState.map(pending.work_observed),completedA=workState.map(pending.work_completed);
      assert(BigInt(observedA.clock)>BigInt(completedA.clock??'0'),'ACTIVITY_PAUSED_UPLOAD_REMAINS_PENDING');
      assert.notEqual(pending.work_pending_at,null);

      assert.equal(effects(lab.A).length, 0, 'ACTIVITY_PAUSED_NO_DELIVERY'); assert.deepEqual(await lab.requests(lab.A), []);
      assert.deepEqual([tenantHealth(health, lab.A).code, tenantHealth(health, lab.A).activity, tenantHealth(health, lab.A).outputRevision],
        ['EVALUATOR_TENANT_PAUSED', 'paused', null]);
      assert.equal(consumerHealth(health, lab.A).code, 'EVALUATOR_CONSUMER_TENANT_PAUSED');
      assert.equal(await worker.call('last', lab.A), null);
      assert.ok(tenantHealth(health, lab.B).cycles > bBefore, 'ACTIVITY_B_UNAFFECTED committed B work completed');
      assert.notDeepEqual((await lab.previewCompleted(lab.B)).work_completed, bCheckpoint.work_completed, 'ACTIVITY_B_UNAFFECTED committed B input completed');
      assert((await worker.call('last',lab.B)).result.properties.bgnow.sgvs.some(row=>row.mgdl===49),'ACTIVITY_B_CURRENT_READING_WHILE_A_PAUSED');
      assert.notDeepEqual((await lab.previewCompleted(lab.B)).work_completed, startCheckpoint.work_completed);
      await lab.stopConsumer(worker);
      // Phase 2: default (manual) timers; B delivery, upload, unpause.
      worker = await boot();
      await lab.wait(async () => effects(lab.B).length >= 1);
      health = await worker.call('health');
      // Writer-driven admission is by the sweep over pending rows: wait for the role to settle A.
      await lab.wait(async () => tenantHealth(await worker.call('health'), lab.A)?.code === 'EVALUATOR_TENANT_PAUSED');
      health = await worker.call('health');
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_PAUSED', 'restart keeps A paused');
      assert.equal(effects(lab.A).length, 0);
      // Upload while paused: stored through the actual storage port.
      await reading(45, lab.A);
      assert.equal((await lab.physical(lab.A)).tables.entries.length, 3, 'ACTIVITY_PAUSED_UPLOAD_STORED');
      // Unpause, then a TIME-ONLY trigger: the first work must be a fresh acquisition
      // over current data, and output is published only after it.
      await stores.owner.transition(ownerActor(lab.A), 'unpause', { expectedVersion: initialVersions.get(lab.A) + 1 });
      await worker.call('tick', lab.A);
      const first = await lab.wait(() => worker.call('last', lab.A));
      lab.traceConsumer('activity-unpause-before-verdict', { first, checkpointA: await lab.previewCompleted(lab.A), effectsA: effects(lab.A).length });
      assert.equal(first.trigger, 'acquisition', 'ACTIVITY_UNPAUSE_RECOMPUTES first published output after unpause is an acquisition');
      assert.notDeepEqual((await lab.previewCompleted(lab.A)).work_completed, startCheckpoint.work_completed, 'acquisition read the data uploaded while paused');
      await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      try { await lab.wait(async () => effects(lab.A).length >= 1); }
      catch (error) {
        lab.traceConsumer('activity-resume-watchdog', { health: await worker.call('health'), requests: await lab.requests(lab.A), observations: lab.observations.length });
        throw error;
      }
      const delivered = await lab.requests(lab.A);
      lab.traceConsumer('activity-resume-before-verdict', { requests: delivered.map(row => ({ state: row.state, payload: row.payload })), effectsA: effects(lab.A).length });
      assert.ok(effects(lab.A).length >= 1, 'A alarm resumes after unpause');
      // Every A request ever committed carries the recomputed current reading
      // (45, uploaded while paused), never the pre-pause reading (50).
      assert.ok(delivered.length >= 1 && delivered.every(row => row.payload.debug?.lastSGV === 45), 'ACTIVITY_UNPAUSE_NO_STALE_PUBLICATION');
      const audit = (await lab.admin.query(`SELECT verb,authority,principal,paused,suspended FROM "${namespace}".tenant_activity_audit WHERE tenant_id=$1 ORDER BY version`, [lab.A])).rows;
      assert.deepEqual(audit.map(row => [row.verb, row.authority, row.principal]), [['pause', 'owner', 'owner'], ['unpause', 'owner', 'owner']]);
      await lab.stopConsumer(worker);
    });

    it('suspended A: nothing runs; the owner cannot lift it; restart and invalidation keep A paused', async function () {
      await reading(50, lab.A); await reading(50, lab.B);
      await stores.operator.transition(operatorActor(lab.A), 'suspend');
      await assert.rejects(stores.owner.transition(ownerActor(lab.A), 'unpause'), { code: 'ACTIVITY_SUSPENDED' });
      await lab.provisionPreview(); provisioned = true;
      const completedBefore=await lab.previewCompleted(lab.A); // before any evaluator process exists
      let worker = await boot();
      await reading(47, lab.A); // suspended: stored here by the storage port; the API refusal is not wired in this lane
      await worker.call('acquire', lab.A); await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      let health = await worker.call('health');
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_SUSPENDED');
      assert.equal(tenantHealth(health,lab.A).cycles,0,'ACTIVITY_SUSPENDED_NO_CLINICAL_ACQUISITION');
      await noCompletion(completedBefore,'ACTIVITY_SUSPENDED_NO_COMPLETION');
      assert.equal(effects(lab.A).length, 0); assert.ok(effects(lab.B).length >= 1);
      // Operator moves A from suspended to paused (owner pause kept), then restart.
      await stores.operator.transition(operatorActor(lab.A), 'pause');
      await stores.operator.transition(operatorActor(lab.A), 'unsuspend');
      assert.equal((await stores.reader.read(lab.A)).state, 'paused');
      await lab.stopConsumer(worker);
      worker = await boot();
      await worker.call('invalidate', lab.A); // what restore activation's cohort invalidation calls
      await worker.call('acquire', lab.A); await worker.call('tick', lab.A); await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      health = await worker.call('health');
      lab.traceConsumer('activity-restart-before-verdict', { a: tenantHealth(health, lab.A), checkpointA: await lab.previewCompleted(lab.A) });
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_PAUSED', 'ACTIVITY_RESTART_PRESERVES');
      assert.equal(tenantHealth(health,lab.A).cycles,0,'ACTIVITY_RESTART_NO_CLINICAL_ACQUISITION');
      await noCompletion(completedBefore,'ACTIVITY_RESTART_NO_COMPLETION');
      assert.equal(effects(lab.A).length, 0);
      await lab.stopConsumer(worker);
    });

    it('owner identity cannot write suspended; the owner of A cannot pause B; audit records the actor', async function () {
      const owner = new URL(urls.owner);
      const { Client } = require('pg'); const client = new Client({ connectionString: owner.toString() }); await client.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [lab.A]);
        await assert.rejects(client.query(`UPDATE "${namespace}".tenant_activity SET suspended=true WHERE tenant_id=$1`, [lab.A]), { code: '42501' },
          'ACTIVITY_OWNER_NO_SUSPEND_PRIVILEGE');
        await client.query('ROLLBACK');
      } finally { await client.end(); }
      await assert.rejects(activityStore.create({ connectionString: urls.owner, namespace, capability: 'reader' }), { code: 'ACTIVITY_STORE_UNSAFE' });
      const tokens = { 'owner-a': ownerActor(lab.A), 'owner-b': ownerActor(lab.B) };
      const hosts = { 'a.example.test': lab.A, 'b.example.test': lab.B };
      const app = express();
      app.use('/api/v1/tenant', require('../lib/server/tenant-app/owner-settings')({
        resolver: { resolve: async req => hosts[req.headers.host] },
        authenticateManagement: async ({ credential }) => tokens[credential] || null,
        tenantSettings: { read: async () => ({}), replace: async () => ({}), rollback: async () => ({}) },
        tenantActivity: createOwnerActivity({ store: stores.owner, authorize: async actor => actor.principal === 'owner' })
      }));
      const cross = await request(app).post('/api/v1/tenant/activity/pause').set('Host', 'b.example.test')
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: initialVersions.get(lab.A) });
      assert.equal(cross.status, 401, 'ACTIVITY_CROSS_TENANT');
      assert.equal((await stores.reader.read(lab.B)).state, 'active');
      const own = await request(app).post('/api/v1/tenant/activity/pause').set('Host', 'a.example.test')
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: initialVersions.get(lab.A) });
      assert.equal(own.status, 200); assert.equal(own.body.state, 'paused'); assert.match(own.body.notice, /alarms are not computed or delivered/);
      assert.equal((await stores.reader.read(lab.A)).state, 'paused'); assert.equal((await stores.reader.read(lab.B)).state, 'active');
      const audit = (await lab.admin.query(`SELECT tenant_id,verb,authority,principal,consumer FROM "${namespace}".tenant_activity_audit WHERE verb<>'provision' ORDER BY event_time`)).rows;
      assert.deepEqual(audit, [{ tenant_id: lab.A, verb: 'pause', authority: 'owner', principal: 'owner', consumer: 'tenant-admin' }]);
      const suspend = await request(app).post('/api/v1/tenant/activity/suspend').set('Host', 'a.example.test')
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: initialVersions.get(lab.A) + 1 });
      assert.equal(suspend.status, 404);
    });
    it('batched reader (realtime change detection): one round trip, each tenant under its own RLS binding, equal to single reads', async function () {
      await stores.operator.transition(operatorActor(lab.A), 'pause');
      await stores.operator.transition(operatorActor(lab.B), 'suspend');
      const unknown = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
      const many = await stores.reader.readMany([lab.A, lab.B, unknown]);
      assert.deepEqual([...many.keys()], [lab.A, lab.B, unknown]);
      assert.deepEqual(many.get(lab.A), await stores.reader.read(lab.A));
      assert.deepEqual(many.get(lab.B), await stores.reader.read(lab.B));
      assert.equal(many.get(lab.A).state, 'paused'); assert.equal(many.get(lab.B).state, 'suspended');
      assert.equal(many.get(unknown), null, 'a tenant without a row reads as null, as read() does');
      await stores.operator.transition(operatorActor(lab.B), 'unsuspend');
      assert.equal((await stores.reader.readMany([lab.B])).get(lab.B).state, 'active');
    });
    it('migration 0007 backfills every existing tenant as active; provisioning writes the row in the tenant transaction', async function () {
      lab.traceConsumer('activity-backfill', backfill);
      assert.deepEqual(backfill.rows.map(row => [row.tenant_id, row.version, row.paused, row.suspended, row.deletion_request_id]),
        [[lab.A, '1', false, false, null], [lab.B, '1', false, false, null]], 'ACTIVITY_BACKFILL every pre-existing window has an active row');
      assert.deepEqual(backfill.audit.map(row => [row.verb, row.authority, row.principal, row.consumer]), Array(2).fill(['provision', 'operator', 'migration', 'backfill-0007']));
      assert.equal(backfill.forced, true, 'windows FORCE ROW LEVEL SECURITY restored by the migration');
      const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
      const { provisionInTransaction } = require('../lib/tenant-activity/provisioning');
      const { Client } = require('pg'); const client = new Client({ connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI }); await client.connect();
      const provision = async (tenant, key, fail) => {
        await client.query('BEGIN');
        try {
          await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenant]);
          await client.query(`INSERT INTO "${provisioningNamespace}".tenant_lifecycle_windows (tenant_id,lock_key,phase,generation) VALUES ($1,$2,'active',1)`, [tenant, key]);
          await provisionInTransaction((text, values) => client.query(text, values), { namespace: provisioningNamespace, tenant, principal: 'synthetic-operator', consumer: 'provisioning' });
          if (fail) throw new Error('synthetic provisioning failure after the activity row');
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); if (!fail) throw error; }
      };
      try {
        await provision(C, '9103', false); await provision(D, '9104', true);
        const rows = (await client.query(`SELECT tenant_id,paused,suspended FROM "${provisioningNamespace}".tenant_activity WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id`, [[C, D]])).rows;
        const windows = (await client.query(`SELECT tenant_id FROM "${provisioningNamespace}".tenant_lifecycle_windows WHERE tenant_id = ANY($1::uuid[])`, [[C, D]])).rows;
        assert.deepEqual(rows, [{ tenant_id: C, paused: false, suspended: false }], 'ACTIVITY_PROVISIONED_WITH_TENANT C has a row; D rolled back with its window');
        assert.deepEqual(windows.map(row => row.tenant_id), [C]);
        await assert.rejects(client.query(`INSERT INTO "${provisioningNamespace}".tenant_activity (tenant_id,version) VALUES ($1,1)`, [D]), { code: '23503' }, 'no activity row without a tenant window');
      } finally {
        await client.query(`DELETE FROM "${provisioningNamespace}".tenant_activity_audit WHERE tenant_id=$1`, [C]);
        await client.query(`DELETE FROM "${provisioningNamespace}".tenant_activity WHERE tenant_id=$1`, [C]);
        await client.query(`DELETE FROM "${provisioningNamespace}".tenant_lifecycle_windows WHERE tenant_id=$1`, [C]);
        await client.end();
      }
    });

    it('an unreadable tenant activity row prevents its clinical result and delivery', async function () {
      // This is shared schema mutation, not a poison tenant input. The lower
      // tenant-bound reader still demonstrates the A error and independent B.
      await lab.admin.query(`CREATE POLICY synthetic_unreadable_a ON "${namespace}".tenant_activity AS RESTRICTIVE FOR SELECT
        USING (1 / (CASE WHEN tenant_id = '${lab.A}'::uuid THEN 0 ELSE 1 END) = 1)`);
      await assert.rejects(stores.reader.read(lab.A), { code: 'ACTIVITY_UNAVAILABLE' });
      assert.equal((await stores.reader.read(lab.B)).state, 'active');
      await reading(50, lab.A);
      await lab.provisionPreview(); provisioned = true; await lab.openSink();
      const before = [await lab.previewCompleted(lab.A), await lab.previewCompleted(lab.B)];
      const worker = await lab.workerConsumers(lab.configureConsumers());
      assert.equal(worker.startup.ready, true, 'the shared role starts before tenant admission');
      // The tenant-bound activity read fails for A on every admission attempt: A is never admitted,
      // so the sweep and an explicit acquire both leave it without a cycle, output or delivery.
      await worker.call('acquire', lab.A); await sleep(1500);
      assert.equal(tenantHealth(await worker.call('health'), lab.A), undefined, 'ACTIVITY_UNREADABLE_A_NOT_ADMITTED');
      // B is independent: its provisioned pending work completes while A's activity row is unreadable.
      await lab.wait(async () => BigInt((await lab.previewCompleted(lab.B)).output_revision) > 0n);
      await lab.stopConsumers();
      assert.equal(effects(lab.A).length, 0);
      assert.deepEqual(await lab.requests(lab.A), []);
      const after = [await lab.previewCompleted(lab.A), await lab.previewCompleted(lab.B)];
      lab.traceConsumer('activity-shared-schema-completion-before-verdict', { before, after });
      // Cold typed admission may initialize an empty envelope and NULL-filled
      // version array. Those are metadata initialization, not clinical output.
      // Keep every output, checkpoint, identity, revision and completed version.
      const completionEvidence = row => {
        const work = require('../lib/pgstream/work-state');
        assert(row.work_completed === null || Array.isArray(row.work_completed) && row.work_completed.length === work.SOURCES.length);
        let output = null;
        if (row.projection !== null) {
          assert(Array.isArray(row.projection) && row.projection.length === 1);
          assert.deepEqual(Object.keys(row.projection[0]).sort(), ['kind', 'output']);
          assert.equal(row.projection[0].kind, 'evaluator-work-v2');
          output = row.projection[0].output;
        }
        return { ...row, projection: output, work_completed: work.map(row.work_completed) };
      };
      const expected = before.map(completionEvidence);
      const plantedOutput = { ...after[0], projection: [{ kind: 'evaluator-work-v2', output: { synthetic: 'PLANTED_OUTPUT' } }] };
      assert.throws(() => assert.deepEqual(completionEvidence(plantedOutput), expected[0]), { code: 'ERR_ASSERTION' }, 'NONNULL_OUTPUT_MUST_FAIL_ORACLE');
      const plantedCompletion = { ...after[0], work_completed: ['1', null, null, null, null, null] };
      assert.throws(() => assert.deepEqual(completionEvidence(plantedCompletion), expected[0]), { code: 'ERR_ASSERTION' }, 'COMPLETED_VERSION_MUST_FAIL_ORACLE');
      assert.deepEqual(completionEvidence(after[0]), expected[0], 'SHARED_ACTIVITY_SCHEMA_NO_COMPLETED_OUTPUT');
      assert(BigInt(after[1].output_revision) > 0n, 'ACTIVITY_UNREADABLE_A_B_INDEPENDENT');
      assert.deepEqual(lab.sinkEffects, []); assert.deepEqual(await lab.requests(lab.A), []); assert.deepEqual(await lab.requests(lab.B), []);
      lab.traceConsumer('activity-shared-schema-refusal', { startup: worker.startup, outputsUnchanged: true, effects: lab.sinkEffects.length });
    });

    it('a deletion request pauses A now; owner may pause/unpause while pending; cancel restores; operator execution suspends', async function () {
      const artifacts = require('../lib/tenant-lifecycle/artifact');
      const artifactFor = tenant => { const manifest = { format: artifacts.FORMAT, version: artifacts.VERSION, tenant, catalogues: [] };
        return { format: artifacts.FORMAT, version: artifacts.VERSION, manifest, tables: {}, digest: artifacts.manifestDigest(manifest) }; };
      const connection = await require('../lib/storage/postgres-connection')({ connectionString: urls.ceremony, max: 2, statement_timeout: 5000 });
      let clock = 1000;
      const ceremony = require('../lib/tenant-lifecycle/ceremony')({
        authorize: async ({ tenant, action }) => ({ allowed: true, current: true, tenant, consumer: 'synthetic-console',
          ...(['request', 'cancel'].includes(action) ? { plane: 'owner', principal: 'owner' } : { plane: 'operator', principal: 'synthetic-operator' }) }),
        verifyDurableArtifact: async ({ tenant, artifact }) => ({ verified: true, tenant, digest: artifact.digest }),
        executionWindow: async ({ tenant }) => ({ current: true, quiesced: true, tenant }),
        namespaceOf: mapping => mapping.ledger, timestamp: () => ++clock, verifyRows: async () => [], eraseRows: async () => ({}),
        // The control namespace carries the native selection's catalogue, which the evaluator's start check requires.
        ledgerCatalogue: lab.lifecycleCatalogue });
      const base = tenant => ({ tenant, ledgerNamespace: namespace, artifact: artifactFor(tenant) });
      const state = async tenant => (await stores.reader.read(tenant));
      try {
        await reading(50, lab.A); await reading(50, lab.B);
        const worker = await boot();
        const request = await ceremony.requestDeletion(connection, base(lab.A));
        assert.match(request.notice, /Alarms stop now/, 'deletion confirmation says alarms stop now');
        assert.equal((await state(lab.A)).state, 'paused', 'ACTIVITY_DELETION_REQUEST_PAUSES');
        assert.equal((await state(lab.B)).state, 'active');
        await worker.call('acquire', lab.A);
        try { await lab.wait(async () => tenantHealth(await worker.call('health'), lab.A).code === 'EVALUATOR_TENANT_PAUSED'); }
        catch (error) {
          const work = (await lab.admin.query('SELECT work_observed::text[] AS observed,work_completed::text[] AS completed FROM "' + lab.replayNamespace + '".tenant_consumer_checkpoint WHERE tenant_id=$1 AND consumer=$2', [lab.A, lab.consumerName + '-completed'])).rows;
          lab.traceConsumer('deletion-cdc-watchdog', { health: await worker.call('health'), activity: await state(lab.A), work });
          throw error;
        }
        assert.equal(tenantHealth(await worker.call('health'), lab.A).code, 'EVALUATOR_TENANT_PAUSED');
        // Owner pause/unpause during the pending ceremony is allowed.
        const v = (await state(lab.A)).version;
        assert.equal((await stores.owner.transition(ownerActor(lab.A), 'unpause', { expectedVersion: v })).state, 'active');
        assert.equal((await stores.owner.transition(ownerActor(lab.A), 'pause')).state, 'paused');
        await ceremony.cancelDeletion(connection, { ...base(lab.A), requestId: request.requestId });
        assert.equal((await state(lab.A)).state, 'active', 'ACTIVITY_DELETION_CANCEL_RESTORES the pre-request state (active)');
        // Paused before the request: cancel leaves it paused.
        await stores.owner.transition(ownerActor(lab.A), 'pause');
        const second = await ceremony.requestDeletion(connection, base(lab.A));
        await ceremony.cancelDeletion(connection, { ...base(lab.A), requestId: second.requestId });
        assert.equal((await state(lab.A)).state, 'paused', 'ACTIVITY_DELETION_CANCEL_RESTORES the pre-request state (paused)');
        await stores.owner.transition(ownerActor(lab.A), 'unpause');
        // Operator execution (claim) suspends.
        const third = await ceremony.requestDeletion(connection, base(lab.A));
        await ceremony.confirmDeletion(connection, { ...base(lab.A), requestId: third.requestId });
        await ceremony.claimDeletion(connection, { ...base(lab.A), requestId: third.requestId });
        assert.equal((await state(lab.A)).state, 'suspended', 'ACTIVITY_DELETION_EXECUTION_SUSPENDS');
        await assert.rejects(stores.owner.transition(ownerActor(lab.A), 'unpause'), { code: 'ACTIVITY_SUSPENDED' });
        await worker.call('acquire', lab.A);
        await lab.wait(async () => tenantHealth(await worker.call('health'), lab.A).code === 'EVALUATOR_TENANT_SUSPENDED');
        assert.equal(tenantHealth(await worker.call('health'), lab.A).code, 'EVALUATOR_TENANT_SUSPENDED');
        const audit = (await lab.admin.query(`SELECT verb,authority FROM "${namespace}".tenant_activity_audit WHERE tenant_id=$1 ORDER BY version`, [lab.A])).rows;
        assert.deepEqual(audit.map(row => row.verb + ':' + row.authority), ['deletion-request:owner', 'unpause:owner', 'pause:owner', 'deletion-cancel:owner',
          'pause:owner', 'deletion-request:owner', 'deletion-cancel:owner', 'unpause:owner', 'deletion-request:owner', 'deletion-execute:operator']);
        assert.equal((await state(lab.B)).state, 'active');
        await lab.stopConsumer(worker);
      } finally { await connection.end(); }
    });

    it('HTTP admission: paused A refuses reads and admits uploads; suspended A refuses both; B unaffected', async function () {
      const { createTenantApp } = require('../lib/server/tenant-app');
      const gate = require('../lib/tenant-activity/serving').createServingGate(require('../lib/tenant-activity/eligibility').create({ read: stores.reader.read }));
      const stored = [];
      const data = express.Router();
      data.get('/entries', (req, res) => res.json([{ sgv: 100 }]));
      data.post('/entries', (req, res) => { stored.push(req.tenantContext.tenant); res.status(201).json({ ok: true }); });
      const hosts = { 'a.example.test': lab.A, 'b.example.test': lab.B };
      const app = createTenantApp({ resolver: { resolve: async req => hosts[req.headers.host] },
        verifyCredential: async ({ tenant }) => ({ tenant, principal: 'synthetic-uploader', consumer: 'synthetic' }), authorizeRequest: async () => true,
        tenantSettings: { read: async () => ({}), replace: async () => ({}), rollback: async () => ({}) }, subjectPolicy: { read: async () => ({}), replace: async () => ({}) },
        dataRouter: data, exchange: async () => ({ token: 'synthetic' }), prepareTenant: async (tenant, req) => { await gate(tenant, req); } });
      const call = (method, host, path) => request(app)[method](path).set('Host', host).set('Authorization', 'Bearer synthetic').send(method === 'post' ? { sgv: 100 } : undefined);
      const matrix = async () => Object.fromEntries(await Promise.all([['a.example.test', 'A'], ['b.example.test', 'B']].flatMap(([host, label]) => [
        call('get', host, '/api/v3/entries').then(r => [label + ' read', r.status + (r.body.error ? ' ' + r.body.error : '')]),
        call('post', host, '/api/v3/entries').then(r => [label + ' upload', r.status + (r.body.error ? ' ' + r.body.error : '')]),
        call('get', host, '/api/v2/authorization/request/synthetic-token').then(r => [label + ' exchange', String(r.status)])])));
      const active = await matrix();
      await stores.owner.transition(ownerActor(lab.A), 'pause');
      const paused = await matrix();
      await stores.operator.transition(operatorActor(lab.A), 'suspend');
      const suspended = await matrix();
      lab.traceConsumer('activity-http-admission', { active, paused, suspended, stored });
      assert.deepEqual(active, { 'A read': '200', 'A upload': '201', 'A exchange': '200', 'B read': '200', 'B upload': '201', 'B exchange': '200' });
      assert.deepEqual(paused, { 'A read': '423 TENANT_PAUSED', 'A upload': '201', 'A exchange': '200', 'B read': '200', 'B upload': '201', 'B exchange': '200' }, 'ACTIVITY_HTTP_PAUSED');
      assert.deepEqual(suspended, { 'A read': '423 TENANT_SUSPENDED', 'A upload': '423 TENANT_SUSPENDED', 'A exchange': '423', 'B read': '200', 'B upload': '201', 'B exchange': '200' }, 'ACTIVITY_HTTP_SUSPENDED');
      assert.deepEqual(stored.filter(tenant => tenant === lab.A).length, 2, 'A uploads stored while active and paused, none while suspended');
    });
  });
