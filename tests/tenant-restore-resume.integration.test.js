'use strict';
// Native lab for decision restore-resume-and-precheck: real PostgreSQL row
// security and advisory locks, two actual API CLI processes with real operation
// windows, the real restore controller and the real resume module. Evaluator,
// realtime and tenant-admin are synthetic lifecycle-only peers, and the
// "replaced rows" are rows in a probe table the restore transaction writes, so
// this is the control protocol, not a full artifact restore.
// covers: lib/tenant-lifecycle/restore-resume.js
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { optInSuite } = require('./support/opt-in');
const createFixture = require('./fixtures/api-fixed-roster-serving');
const cohorts = require('../lib/server/serve/operation-cohort');
const maintenance = require('../lib/tenant-lifecycle/maintenance-window');
const recovery = require('../lib/tenant-lifecycle/restore-resume');
const entry = identifier => ({ identifier, type: 'sgv', date: Date.now(), utcOffset: 0, app: 'synthetic-resume', sgv: 125 });
const DIGEST = 'e'.repeat(64);

optInSuite(process.env.NS_RESTORE_RESUME_DOCKER_TEST === '1', 'NS_RESTORE_RESUME_DOCKER_TEST=1')(
  'restore, resume and legacy marker inspection on native PostgreSQL with actual API processes', function () {
    this.timeout(180000);
    const f = createFixture(), [A, B] = f.base.tenants, pools = [], written = [];
    let a, b, observer, sequence = 0;
    const call = (id, tenant, method, path, token, body, headers) => f.base.http(f.current.get(id), tenant, method, path, token, body, headers);
    const operatorPool = () => { const pool = new Pool({ connectionString: f.operatorPool.options.connectionString, max: 1 }); pool.on('error', () => {}); pools.push(pool); return pool; };
    // Every admin session is a superuser backend the cohort census refuses, so
    // wait until it has left the server's session list before the next operator call.
    async function admin (fn) {
      const value = await f.withAdmin(fn);
      await f.base.until(async () => (await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='operator' AND backend_type='client backend'")).rows[0].n === 0, 'admin session gone');
      return value;
    }
    const state = () => admin(async client => ({
      window: (await client.query('SELECT phase,generation::text,claim_id FROM preview_control.tenant_lifecycle_windows WHERE tenant_id=$1', [A])).rows[0],
      audit: (await client.query('SELECT claim_id,state FROM preview_control.tenant_lifecycle_restore_audit WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1', [A])).rows[0],
      probe: (await client.query('SELECT value FROM restore_probe.rows WHERE tenant_id=$1 ORDER BY value', [A])).rows.map(row => row.value),
      resumes: (await client.query('SELECT claim_id,interrupted FROM preview_control.tenant_lifecycle_restore_resume WHERE tenant_id=$1 ORDER BY resumed_at', [A])).rows,
      unfinished: (await client.query('SELECT operation_id,owner_pid FROM preview_control.tenant_lifecycle_operations WHERE tenant_id=$1 AND finished=false ORDER BY operation_id', [A])).rows,
      cleared: (await client.query('SELECT operation_id FROM preview_control.tenant_lifecycle_operation_clearance WHERE tenant_id=$1 ORDER BY operation_id', [A])).rows.map(row => row.operation_id)
    }));
    // One fresh cohort (every participant answers now) and one operator pool per operation.
    async function operator (fn, { controller = maintenance, drainTimeoutMs = 300 } = {}) {
      const cohort = await cohorts.createRemote({ namespace: f.namespace, tenants: f.cohortTenants, participants: f.participants });
      const pool = operatorPool();
      const restore = controller.create({ namespace: f.namespace, locks: f.locks, pool, cohort, drainTimeoutMs });
      const resume = recovery.create({ namespace: f.namespace, locks: f.locks, pool, cohort });
      try { return await fn({ restore, resume }); }
      finally { await restore.close(); await resume.close(); await cohort.close(); await pool.end(); }
    }
    const bWrites = async stage => {
      const identifier = 'resume-b-' + stage + '-' + (++sequence);
      assert.equal((await call('api-1', B, 'POST', '/api/v3/entries', b, entry(identifier))).status, 201, 'OTHER_TENANT_WRITES ' + stage);
      written.push(identifier);
    };
    const aServes = async id => (await call(id, A, 'GET', '/api/v3/entries/resume-a-before', a)).status;
    // A request with no client deadline whose committed response the owned control holds.
    function held (id, identifier) {
      fs.rmSync(f.mark('held', id), { force: true });
      const body = JSON.stringify(entry(identifier));
      const request = http.request({ hostname: '127.0.0.1', port: f.current.get(id).port, path: '/api/v3/entries', method: 'POST', agent: false,
        headers: { Host: 'one.example.test', Accept: 'application/json', Authorization: 'Bearer ' + a, 'Content-Type': 'application/json', 'x-roster-hold': 'postcommit' } });
      const done = new Promise(resolve => { request.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); request.on('error', () => resolve(null)); });
      request.end(body);
      return { done, ready: () => f.base.until(async () => fs.existsSync(f.mark('held', id)), 'committed response held on ' + id), abort: () => request.destroy() };
    }
    const probe = value => ({ connection }) => connection.query('INSERT INTO restore_probe.rows(tenant_id,value) VALUES ($1,$2)', [A, value]);

    before(async () => {
      await f.setup(); a = await f.base.localToken(A); b = await f.base.localToken(B);
      await f.withAdmin(async client => {
        await client.query('CREATE SCHEMA restore_probe');
        await client.query('CREATE TABLE restore_probe.rows(tenant_id uuid NOT NULL, value text NOT NULL)');
        await client.query('GRANT USAGE ON SCHEMA restore_probe TO preview_restore_operator');
        await client.query('GRANT SELECT,INSERT ON restore_probe.rows TO preview_restore_operator');
      });
      observer = operatorPool();
      assert.equal((await call('api-1', A, 'POST', '/api/v3/entries', a, entry('resume-a-before'))).status, 201);
      await bWrites('before');
    });
    after(async () => { for (const pool of pools) await pool.end().catch(() => {}); await f.cleanup(); });

    // The drills' four interruption kinds. Each leaves A closed; resume reopens it.
    const kinds = [
      { name: 'operator dies inside the data transaction', audit: 'suspended', interrupted: 'before-data', replaced: false,
        async interrupt (restore) {
          await assert.rejects(restore.withRestore(A, { artifactDigest: DIGEST }, async context => {
            await probe('in-data')(context); await bWrites('held-in-data');
            await context.connection.query('SELECT pg_terminate_backend(pg_backend_pid())');
          }));
        } },
      { name: 'operator dies after the data commit', audit: 'restored', interrupted: 'data-replaced', replaced: 'after-data',
        async interrupt (restore) {
          await assert.rejects(restore.withRestore(A, { artifactDigest: DIGEST }, async context => {
            await probe('after-data')(context);
            context.connection.afterCommit(async () => { await observer.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=current_user AND pid<>pg_backend_pid()'); });
          }));
        } },
      { name: 'a cohort role is killed during the restore', audit: 'suspended', interrupted: 'before-data', replaced: false, roleDown: true,
        async interrupt (restore) {
          await assert.rejects(restore.withRestore(A, { artifactDigest: DIGEST }, async context => {
            await probe('role-killed')(context); await f.base.kill(f.current.get('api-2')); f.current.delete('api-2');
          }));
        } },
      { name: 'a cohort role loses the acknowledgement after the data commit', audit: 'restored', interrupted: 'data-replaced', replaced: 'ack-lost',
        async interrupt (restore) {
          fs.writeFileSync(f.mark('drop-invalidation', 'api-2'), '1', { mode: 0o600 });
          await assert.rejects(restore.withRestore(A, { artifactDigest: DIGEST }, probe('ack-lost')));
          assert(fs.existsSync(f.mark('lost-invalidation', 'api-2')), 'the role completed its handler and the reply was lost');
        } }
    ];
    for (const kind of kinds) it('resume reopens A after: ' + kind.name, async function () {
      const before = await state();
      await operator(({ restore }) => kind.interrupt(restore));
      const closed = await state();
      assert.equal(closed.window.phase, 'suspended'); assert.equal(closed.audit.state, kind.audit); assert.equal(closed.audit.claim_id, closed.window.claim_id);
      assert.deepEqual(closed.probe, kind.replaced ? [...before.probe, kind.replaced].sort() : before.probe, 'replaced rows are durable only after the data commit');
      const refused = await aServes('api-1');
      assert(refused >= 400, 'A is refused while closed'); await bWrites('while-closed');
      // What J offered: a second restore refuses, and the tenant stays closed.
      const again = operator(({ restore }) => assert.rejects(restore.withRestore(A, { artifactDigest: DIGEST }, async () => assert.fail('must not run')), { code: 'LIFECYCLE_RESTORE_ALREADY_SUSPENDED' }));
      if (kind.roleDown) {
        // Fresh acknowledgement from every role: with api-2 down no cohort can be formed.
        await assert.rejects(again, /^Error: SOCKET_IPC_UNAVAILABLE$/);
        await assert.rejects(operator(({ resume }) => resume.resume(A, { claimId: closed.window.claim_id })), /^Error: SOCKET_IPC_UNAVAILABLE$/);
        assert.equal((await state()).window.phase, 'suspended', 'RESUME_REQUIRES_EVERY_ROLE');
        await f.start('api-2', { readinessTenant: B });
      } else await again;
      const seen = await operator(({ resume }) => resume.inspect(A));
      assert.equal(seen.interrupted, kind.interrupted); assert.equal(seen.claimId, closed.window.claim_id); assert.deepEqual(seen.reasons, []);
      const result = await operator(({ resume }) => resume.resume(A, { claimId: seen.claimId }));
      assert.equal(result.interrupted, kind.interrupted); assert.equal(result.generation, closed.window.generation);
      const open = await state();
      assert.equal(open.window.phase, 'active'); assert.equal(open.window.claim_id, null); assert.equal(open.audit.state, kind.audit, 'the restore audit row is unchanged');
      assert.deepEqual(open.resumes.at(-1), { claim_id: closed.window.claim_id, interrupted: kind.interrupted });
      for (const id of ['api-1', 'api-2']) assert.equal(await aServes(id), 200, 'A serves again through ' + id);
      assert.equal((await call('api-2', A, 'POST', '/api/v3/entries', a, entry('resume-a-after-' + (++sequence)))).status, 201);
      await bWrites('after-resume');
      await operator(({ resume }) => assert.rejects(resume.resume(A, { claimId: seen.claimId }), { code: 'LIFECYCLE_RESUME_NOT_SUSPENDED' }));
      process.stdout.write('RESTORE_RESUME_NATIVE ' + JSON.stringify({ kind: kind.name, audit: kind.audit, interrupted: kind.interrupted, refusedStatusWhileClosed: refused, reopened: true }) + '\n');
    });

    it('refuses a resume while the restore that holds A is still running, and a mislabelled resume record', async function () {
      let release; const gate = new Promise(resolve => { release = resolve; });
      let entered; const inside = new Promise(resolve => { entered = resolve; });
      const cohort = await cohorts.createRemote({ namespace: f.namespace, tenants: f.cohortTenants, participants: f.participants });
      const pool = operatorPool(), restore = maintenance.create({ namespace: f.namespace, locks: f.locks, pool, cohort, drainTimeoutMs: 300 });
      const running = restore.withRestore(A, { artifactDigest: DIGEST }, async context => { await probe('running')(context); entered(); await gate; });
      try {
        await inside;
        const claim = (await state()).window.claim_id;
        const other = operatorPool(), resume = recovery.create({ namespace: f.namespace, locks: f.locks, pool: other, cohort: await cohorts.createRemote({ namespace: f.namespace, tenants: f.cohortTenants, participants: f.participants }) });
        assert.deepEqual((await resume.inspect(A)).reasons, ['LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT']);
        // The pin belongs to the running restore: a second operator cannot take it over.
        await assert.rejects(resume.resume(A, { claimId: claim }), error => ['LIFECYCLE_RESUME_RESTORE_OWNER_PRESENT', 'RESTORE_COHORT_UNKNOWN_BACKEND'].includes(error.code));
        // Row policy of migration 0009, on the database itself: the operator role
        // cannot record a resume whose label contradicts the audit state.
        const client = await observer.connect();
        try {
          await client.query('BEGIN'); await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
          await assert.rejects(client.query("INSERT INTO preview_control.tenant_lifecycle_restore_resume(tenant_id,resume_id,claim_id,generation,artifact_digest,interrupted) SELECT tenant_id,gen_random_uuid(),claim_id,generation,artifact_digest,'data-replaced' FROM preview_control.tenant_lifecycle_restore_audit WHERE claim_id=$1", [claim]),
            { code: '42501' }, 'RESUME_LABEL_POLICY');
        } finally { await client.query('ROLLBACK'); client.release(); }
        assert.equal((await state()).window.phase, 'suspended');
      } finally { release(); }
      assert.equal((await running).state, 'activated', 'the running restore completes on its own');
      await restore.close(); await cohort.close();
      assert.equal((await state()).window.phase, 'active');
    });

    it('retains legacy clearance evidence independently of restore admission', async function () {
      // Create an old-format marker through its real narrow owner; release that
      // backend so inspect and explicit clearance can report its known outcome.
      const operation = randomUUID();
      const legacy = new Pool({ connectionString: f.lifetimeConnectionString, max: 1 });
      const owner = await legacy.connect();
      try {
        await owner.query('BEGIN');
        await owner.query("SELECT set_config('app.current_tenant_id',$1,true)", [A]);
        await owner.query('INSERT INTO preview_control.tenant_lifecycle_operations(tenant_id,operation_id,generation) VALUES($1,$2,1)', [A, operation]);
        await owner.query('COMMIT');
      } finally { owner.release(true); await legacy.end(); }
      const result = await operator(({ restore }) => restore.withRestore(A, { artifactDigest: DIGEST }, probe('legacy-marker')));
      assert.equal(result.state, 'activated');
      assert.deepEqual((await operator(({ resume }) => resume.inspect(A))).operations, { unfinished: 1, ownerGone: 1 });
      assert.deepEqual(await operator(({ resume }) => resume.clearOperations(A)), { tenant: A, cleared: [operation], retained: [] });
      assert((await state()).unfinished.some(row => row.operation_id === operation));
      await bWrites('after-clearance');
    });

    it('preserves a committed write across loss of the response process and restoration', async function () {
      const pending = held('api-2', 'resume-held-committed');
      await pending.ready();
      try {
        await f.base.kill(f.current.get('api-2')); f.current.delete('api-2');
        assert.equal(await pending.done, null);
      } finally { pending.abort(); }
      await f.start('api-2', { readinessTenant: B });
      assert.equal((await operator(({ restore }) => restore.withRestore(A, { artifactDigest: DIGEST }, probe('after-process-loss')))).state, 'activated');
      assert.equal((await call('api-1', A, 'GET', '/api/v3/entries/resume-held-committed', a)).status, 200);
      await bWrites('after-process-loss');
    });

    it('no write of the other tenant was lost, and A kept its own', async function () {
      const stored = await admin(async client => (await client.query("SELECT tenant_id::text AS tenant,doc->>'identifier' AS identifier FROM preview_data.entries WHERE doc->>'identifier' LIKE 'resume-%'")).rows);
      const mine = stored.filter(row => row.tenant === B).map(row => row.identifier).sort();
      assert.deepEqual(mine, [...written].sort(), 'OTHER_TENANT_WRITES every B write made before, during and after each closure is stored');
      assert(stored.some(row => row.tenant === A && row.identifier === 'resume-a-before'));
      process.stdout.write('RESTORE_RESUME_OTHER_TENANT ' + JSON.stringify({ writes: written.length, stored: mine.length }) + '\n');
    });
  });
