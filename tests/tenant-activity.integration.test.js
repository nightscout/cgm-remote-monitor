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
    const namespace = 'activity_' + randomUUID().replace(/-/g, '').slice(0, 12);
    const roles = { reader: namespace + '_reader', owner: namespace + '_owner', operator: namespace + '_operator' };
    const urls = {}, stores = {}; let prior;
    const operatorActor = tenant => ({ tenant, principal: 'synthetic-operator', consumer: 'operator-cli' });
    const ownerActor = tenant => ({ tenant, principal: 'owner', consumer: 'tenant-admin' });
    before(async function () {
      prior = scope.getTenancyMode(); scope.setTenancyMode('multi');
      await lab.open();
      const admin = new URL(process.env.NS_TEST_POSTGRES_ADMIN_URI);
      await lab.admin.query('CREATE SCHEMA "' + namespace + '"');
      await run('up', { direct: true, connectionString: admin.toString(), namespace, catalogue: require('../lib/tenant-activity/postgres-candidate.json') });
      for (const [kind, role] of Object.entries(roles)) {
        const password = randomBytes(24).toString('hex');
        await lab.admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
        const url = new URL(admin); url.username = role; url.password = password; urls[kind] = url.toString();
      }
      for (const statement of activityStore.grants({ namespace, ...roles })) await lab.admin.query(statement);
      for (const kind of Object.keys(roles)) stores[kind] = await activityStore.create({ connectionString: urls[kind], namespace, capability: kind });
      lab.extraEnv.NS_ACTIVITY_READER = urls.reader;
      lab.document.activity = { connectionEnv: 'NS_ACTIVITY_READER', namespace };
    });
    beforeEach(async function () {
      await lab.reset();
      await lab.admin.query(`TRUNCATE "${namespace}".tenant_activity, "${namespace}".tenant_activity_audit`); provisioned = false;
      for (const tenant of [lab.A, lab.B]) await stores.operator.provision(operatorActor(tenant));
    });
    after(async function () {
      const errors = [];
      for (const store of Object.values(stores)) await store.close().catch(error => errors.push(error));
      if (lab.admin) {
        await lab.admin.query('DROP SCHEMA IF EXISTS "' + namespace + '" CASCADE').catch(error => errors.push(error));
        for (const role of Object.values(roles)) {
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
    let provisioned = false;
    async function boot (change) {
      if (!provisioned) await lab.provisionPreview();
      provisioned = true; await lab.openSink();
      const worker = await lab.workerConsumers(lab.configureConsumers(change));
      assert.equal(worker.startup.ready, true, JSON.stringify(worker.startup));
      await worker.call('flush', lab.A); await worker.call('flush', lab.B); return worker;
    }
    const effects = tenant => lab.sinkEffects.filter(row => row.tenant === tenant);
    const tenantHealth = (health, tenant) => health.tenants.find(row => row.tenant === tenant);
    const consumerHealth = (health, tenant) => health.consumers.tenants.find(row => row.tenant === tenant);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    it('paused A: no acquisition, timer work or output for A, uploads still stored; B unaffected; unpause recomputes before publishing', async function () {
      await reading(50, lab.A); await reading(50, lab.B);
      const paused = await stores.owner.transition(ownerActor(lab.A), 'pause', { expectedVersion: 1 });
      assert.equal(paused.state, 'paused');
      // Phase 1: actual evaluator timers at 150 ms. Only work/output oracles here:
      // the realtime consumer refuses changed output under this timer churn on the
      // unmodified b70ad83f too (see the evidence README), so delivery is phase 2.
      await lab.provisionPreview(); provisioned = true;
      const startCheckpoint = await lab.previewCheckpoint(lab.A); // before any evaluator process exists
      let worker = await boot(document => { document.recoveryIntervalMs = 150; document.timeIntervalMs = 150; });
      await reading(48, lab.A); // new A data while paused: any acquisition would advance A's checkpoint
      await worker.call('acquire', lab.A); await worker.call('tick', lab.A); await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      const bBefore = tenantHealth(await worker.call('health'), lab.B).outputRevision;
      await sleep(700); // several actual recovery/time timer rounds
      await worker.call('flush', lab.A);
      let health = await worker.call('health');
      lab.traceConsumer('activity-paused-before-verdict', { checkpointA: await lab.previewCheckpoint(lab.A), checkpointB: await lab.previewCheckpoint(lab.B),
        effectsA: effects(lab.A).length, a: tenantHealth(health, lab.A), b: tenantHealth(health, lab.B), consumerA: consumerHealth(health, lab.A) });
      assert.deepEqual(await lab.previewCheckpoint(lab.A), startCheckpoint, 'ACTIVITY_PAUSED_NO_ACQUISITION A replay checkpoint never advanced');
      assert.equal(effects(lab.A).length, 0, 'ACTIVITY_PAUSED_NO_DELIVERY'); assert.deepEqual(await lab.requests(lab.A), []);
      assert.deepEqual([tenantHealth(health, lab.A).code, tenantHealth(health, lab.A).activity, tenantHealth(health, lab.A).outputRevision],
        ['EVALUATOR_TENANT_PAUSED', 'paused', null]);
      assert.equal(consumerHealth(health, lab.A).code, 'EVALUATOR_CONSUMER_TENANT_PAUSED');
      assert.equal(await worker.call('last', lab.A), null);
      assert.ok(tenantHealth(health, lab.B).outputRevision > bBefore + 2, 'ACTIVITY_B_UNAFFECTED B kept cycling on the actual timers');
      assert.notDeepEqual(await lab.previewCheckpoint(lab.B), startCheckpoint);
      await lab.stopConsumer(worker);
      // Phase 2: default (manual) timers; B delivery, upload, unpause.
      worker = await boot();
      await lab.wait(async () => effects(lab.B).length >= 1);
      health = await worker.call('health');
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_PAUSED', 'restart keeps A paused');
      assert.equal(effects(lab.A).length, 0);
      // Upload while paused: stored through the actual storage port.
      await reading(45, lab.A);
      assert.equal((await lab.physical(lab.A)).tables.entries.length, 3, 'ACTIVITY_PAUSED_UPLOAD_STORED');
      // Unpause, then a TIME-ONLY trigger: the first work must be a fresh acquisition
      // over current data, and output is published only after it.
      await stores.owner.transition(ownerActor(lab.A), 'unpause', { expectedVersion: 2 });
      const first = await worker.call('tick', lab.A);
      lab.traceConsumer('activity-unpause-before-verdict', { first, checkpointA: await lab.previewCheckpoint(lab.A), effectsA: effects(lab.A).length });
      assert.equal(first.trigger, 'acquisition', 'ACTIVITY_UNPAUSE_RECOMPUTES first published output after unpause is an acquisition');
      assert.notDeepEqual(await lab.previewCheckpoint(lab.A), startCheckpoint, 'acquisition read the data uploaded while paused');
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
      assert.deepEqual(audit.map(row => [row.verb, row.authority, row.principal]), [['provision', 'operator', 'synthetic-operator'], ['pause', 'owner', 'owner'], ['unpause', 'owner', 'owner']]);
      await lab.stopConsumer(worker);
    });

    it('suspended A: nothing runs; the owner cannot lift it; restart and invalidation keep A paused', async function () {
      await reading(50, lab.A); await reading(50, lab.B);
      await stores.operator.transition(operatorActor(lab.A), 'suspend');
      await assert.rejects(stores.owner.transition(ownerActor(lab.A), 'unpause'), { code: 'ACTIVITY_SUSPENDED' });
      await lab.provisionPreview(); provisioned = true;
      const start = await lab.previewCheckpoint(lab.A); // before any evaluator process exists
      let worker = await boot();
      await reading(47, lab.A); // suspended: stored here by the storage port; the API refusal is not wired in this lane
      await worker.call('acquire', lab.A); await worker.call('wake', lab.A); await worker.call('flush', lab.A);
      let health = await worker.call('health');
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_SUSPENDED');
      assert.deepEqual(await lab.previewCheckpoint(lab.A), start, 'ACTIVITY_SUSPENDED_NOTHING_RUNS');
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
      lab.traceConsumer('activity-restart-before-verdict', { a: tenantHealth(health, lab.A), checkpointA: await lab.previewCheckpoint(lab.A) });
      assert.equal(tenantHealth(health, lab.A).code, 'EVALUATOR_TENANT_PAUSED', 'ACTIVITY_RESTART_PRESERVES');
      assert.deepEqual(await lab.previewCheckpoint(lab.A), start); assert.equal(effects(lab.A).length, 0);
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
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
      assert.equal(cross.status, 401, 'ACTIVITY_CROSS_TENANT');
      assert.equal((await stores.reader.read(lab.B)).state, 'active');
      const own = await request(app).post('/api/v1/tenant/activity/pause').set('Host', 'a.example.test')
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 1 });
      assert.equal(own.status, 200); assert.equal(own.body.state, 'paused'); assert.match(own.body.notice, /alarms are not computed or delivered/);
      assert.equal((await stores.reader.read(lab.A)).state, 'paused'); assert.equal((await stores.reader.read(lab.B)).state, 'active');
      const audit = (await lab.admin.query(`SELECT tenant_id,verb,authority,principal,consumer FROM "${namespace}".tenant_activity_audit WHERE verb<>'provision' ORDER BY event_time`)).rows;
      assert.deepEqual(audit, [{ tenant_id: lab.A, verb: 'pause', authority: 'owner', principal: 'owner', consumer: 'tenant-admin' }]);
      const suspend = await request(app).post('/api/v1/tenant/activity/suspend').set('Host', 'a.example.test')
        .set('Authorization', 'Bearer owner-a').send({ expectedVersion: 2 });
      assert.equal(suspend.status, 404);
    });
  });
