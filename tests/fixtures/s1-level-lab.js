'use strict';

// Spike S1 lab: api and evaluator in one process, no stream. The api write
// marks the tenant pending in its own transaction and hints the evaluator after
// COMMIT; the evaluator recomputes the tenant from its current window on a hint
// or a sweep over pending rows, and completes through the generation fence.
// Synthetic data only, on a disposable database selected by
// NS_TEST_POSTGRES_ADMIN_URI (its name must contain "test").
const crypto = require('node:crypto');
const evaluatorLab = require('./tenant-projection-evaluator');
const connect = require('../../lib/storage/postgres-connection');
const decorate = require('../../lib/storage/postgres-write-clock');
const durableReplay = require('../../lib/storage/postgres-durable-replay');
const projectionEvaluator = require('../../lib/data/tenant-projection-evaluator');
const typedCheckpoint = require('../../lib/pgstream/typed-checkpoint');
const scheduler = require('../../lib/pgstream/activity-scheduler');
const { encodeDocument } = require('../../lib/storage/postgres-identity');
const { run: migrate } = require('../../lib/migrations/postgres');
const scope = require('../../lib/storage/tenant-scope');
const dates = require('../../lib/server/srv-dates');

const CONSUMER = 'evaluator-s1';
const COMPLETED = CONSUMER + '-completed';
const IDENTITY = 'synthetic-s1-identity';
const NULLS = '{NULL,NULL,NULL,NULL,NULL,NULL}';
const EXTRA = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];

module.exports = function s1Lab ({ tenants: tenantCount = 2, pageSize = 100, audit = false } = {}) {
  const base = evaluatorLab();
  const lab = { base, CONSUMER, COMPLETED, IDENTITY, pageSize };
  const workNs = base.name + '_work', controlNs = base.name + '_control';
  lab.workTable = '"' + workNs + '".tenant_consumer_checkpoint';
  lab.lifecycleTable = '"' + controlNs + '".tenant_lifecycle_windows';
  let owned = false;
  lab.api = { hints: true, drop: new Set(), generations: new Map(), sent: 0, dropped: 0 };

  lab.open = async () => {
    await base.open();
    lab.tenants = [base.A, base.B, ...EXTRA].slice(0, tenantCount);
    const admin = lab.admin = base.admin;
    const uri = process.env.NS_TEST_POSTGRES_ADMIN_URI;
    await admin.query('CREATE SCHEMA "' + workNs + '"'); await admin.query('CREATE SCHEMA "' + controlNs + '"'); owned = true;
    await migrate('up', { direct: true, connectionString: uri, namespace: workNs,
      catalogue: require('../../migrations/candidates/postgres-evaluator-work-v2.json') });
    // Stand-in for the lifecycle row (the real one has FORCE RLS on the tenant).
    await admin.query('CREATE TABLE ' + lab.lifecycleTable + ' (tenant_id uuid PRIMARY KEY, generation bigint NOT NULL, phase text NOT NULL)');
    const reader = base.readerRole, writer = base.role;
    for (const ns of [workNs, controlNs]) await admin.query(`GRANT USAGE ON SCHEMA "${ns}" TO "${reader}"`);
    await admin.query(`GRANT USAGE ON SCHEMA "${workNs}" TO "${writer}"`);
    await admin.query(`GRANT SELECT, UPDATE ON ${lab.workTable} TO "${reader}"`);
    // The evaluator's cross-tenant work reads (begin, sweep) have no tenant
    // binding; the deployment grants give the evaluator role this read.
    await admin.query(`CREATE POLICY s1_evaluator_work_read ON ${lab.workTable} FOR SELECT TO "${reader}" USING (consumer='${COMPLETED}')`);
    // The api marks pending: a column grant on the evaluator's work row.
    await admin.query(`GRANT SELECT(tenant_id,consumer,work_version,work_observed,work_pending_at), UPDATE(work_observed,work_observed_at,work_pending_at) ON ${lab.workTable} TO "${writer}"`);
    // FOR SHARE needs an UPDATE privilege on some column.
    await admin.query(`GRANT SELECT, UPDATE(phase) ON ${lab.lifecycleTable} TO "${reader}"`);
    const password = crypto.randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE "${reader}" PASSWORD '${password}'`);
    const url = new URL(uri); url.username = reader; url.password = password;
    lab.evaluatorURI = url.toString();
    for (const tenant of EXTRA) await admin.query(`INSERT INTO "${base.namespaces.clock}".tenant_write_clock VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant, base.initial]);
    lab.writer = decorate(base.raw[0], base.namespaces.clock, { pending: { table: lab.workTable, consumer: COMPLETED,
      hint: (tenant, stamp) => {
        if (!lab.api.hints || lab.api.drop.has(tenant)) { lab.api.dropped++; return; }
        lab.api.sent++;
        // Single process: the hint is a function call; the generation is the
        // api's operation-window view (no statement).
        return lab.evaluator?.hint({ tenant, generation: lab.api.generations.get(tenant), stamp });
      } } });
    if (audit) {
      // Test-only oracle: every committed output revision, with its generation.
      await admin.query('CREATE TABLE "' + controlNs + '".output_audit (id bigserial PRIMARY KEY, tenant_id uuid, revision bigint, generation bigint, at timestamptz DEFAULT clock_timestamp())');
      await admin.query('CREATE FUNCTION "' + controlNs + '".s1_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN IF NEW.output_revision IS DISTINCT FROM OLD.output_revision OR NEW.output_restore_generation IS DISTINCT FROM OLD.output_restore_generation THEN INSERT INTO "' + controlNs + '".output_audit(tenant_id,revision,generation) VALUES (NEW.tenant_id,NEW.output_revision,NEW.output_restore_generation); END IF; RETURN NEW; END $$');
      await admin.query('CREATE TRIGGER s1_audit AFTER UPDATE ON ' + lab.workTable + ' FOR EACH ROW EXECUTE FUNCTION "' + controlNs + '".s1_audit()');
    }
    await lab.reset();
  };
  lab.auditMark = async () => (await lab.admin.query('SELECT COALESCE(max(id),0)::text AS id FROM "' + controlNs + '".output_audit')).rows[0].id;
  lab.audit = async (tenant, afterId) => (await lab.admin.query('SELECT id::text,revision::text,generation::text FROM "' + controlNs + '".output_audit WHERE tenant_id=$1 AND id>$2 ORDER BY id', [tenant, afterId])).rows;

  lab.reset = async () => {
    await lab.evaluator?.close(); lab.evaluator = null;
    await base.reset();
    for (const tenant of EXTRA) await lab.admin.query(`INSERT INTO "${base.namespaces.clock}".tenant_write_clock VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant, base.initial]);
    await lab.admin.query('DELETE FROM ' + lab.workTable);
    await lab.admin.query('DELETE FROM ' + lab.lifecycleTable);
    if (audit) await lab.admin.query('DELETE FROM "' + controlNs + '".output_audit');
    const digest = crypto.createHash('sha256').update(require('../../lib/server/serve/evaluator-runtime').canonical(['evaluator-work-v2', workNs, CONSUMER])).digest('hex');
    for (const tenant of lab.tenants) {
      await lab.admin.query(`INSERT INTO ${lab.workTable} (tenant_id,consumer,contract_digest,checkpoint,projection,work_version,work_observed,work_completed,work_observed_at)
        VALUES ($1,$2,$3,0,'[{"kind":"evaluator-work-v2","output":null}]'::jsonb,2,'${NULLS}','${NULLS}','${NULLS}')`, [tenant, COMPLETED, digest]);
      await lab.admin.query('INSERT INTO ' + lab.lifecycleTable + " VALUES ($1,1,'active')", [tenant]);
      lab.api.generations.set(tenant, '1');
    }
    lab.api.hints = true; lab.api.drop.clear(); lab.api.sent = 0; lab.api.dropped = 0;
  };

  // ---- api writes (the real write clock; one transaction per accepted write)
  lab.writeDocs = (tenant, logical, documents) => scope.withTenant(tenant, () => lab.writer.transaction(async () => {
    const modified = dates.next();
    for (const input of documents) {
      const row = encodeDocument({ ...input, srvModified: modified, srvCreated: modified });
      await base.raw[0].query(`INSERT INTO "${base.namespaces[logical]}"."${logical}"(tenant_id,id_kind,doc) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(tenant_id,id_kind,"_id") DO UPDATE SET doc=excluded.doc`, [tenant, row.id_kind, JSON.stringify(row.doc)]);
    }
    return modified;
  }));
  lab.sgv = (id, sgv, date) => ({ _id: id, type: 'sgv', sgv, date, dateString: new Date(date).toISOString(), direction: 'Flat', device: 'synthetic-cgm', noise: 1 });
  // A hard delete takes no clock stamp (history:false) and still marks.
  lab.hardDelete = (tenant, logical, id) => scope.withTenant(tenant, () => lab.writer.transaction(() =>
    base.raw[0].query(`DELETE FROM "${base.namespaces[logical]}"."${logical}" WHERE tenant_id=$1 AND "_id"=$2`, [tenant, id]), { history: false }));

  // ---- a fenced platform operation (class c): restore ends with a re-sweep
  lab.restore = async (tenant, { removeEntriesAfter } = {}) => {
    const admin = lab.admin;
    await admin.query('BEGIN');
    try {
      const row = (await admin.query('SELECT generation FROM ' + lab.lifecycleTable + ' WHERE tenant_id=$1 FOR UPDATE', [tenant])).rows[0];
      const next = String(BigInt(row.generation) + 1n);
      await admin.query('UPDATE ' + lab.lifecycleTable + ' SET generation=$2 WHERE tenant_id=$1', [tenant, next]);
      if (removeEntriesAfter !== undefined) await admin.query(`DELETE FROM "${base.namespaces.entries}".entries WHERE tenant_id=$1 AND (doc->>'date')::bigint > $2`, [tenant, removeEntriesAfter]);
      await admin.query(`UPDATE ${lab.workTable} SET work_observed[5]=$3::bigint,work_observed_at[5]=$4::bigint,work_pending_at=COALESCE(work_pending_at,$4::bigint) WHERE tenant_id=$1 AND consumer=$2`, [tenant, COMPLETED, next, Date.now()]);
      await admin.query('COMMIT');
      lab.api.generations.set(tenant, next);
      return next;
    } catch (error) { await admin.query('ROLLBACK'); throw error; }
  };

  // ---- the evaluator, in process
  lab.startEvaluator = async ({ sweepMs = 10000, hints = true, gate, startupSweep = true, concurrency = 2, retryMs = 1000 } = {}) => {
    const connection = await connect({ connectionString: lab.evaluatorURI, max: concurrency + 3, statement_timeout: 10000, application_name: 's1-evaluator' });
    const store = typedCheckpoint.create({ connection, namespace: workNs, consumer: CONSUMER, maxBytes: 16777216, timeIntervalMs: 60000,
      generationFence: { table: lab.lifecycleTable } });
    await store.own(() => {});
    const replay = durableReplay({ connection, checkpointTable: base.replayNamespace + '.tenant_consumer_checkpoint',
      clockTable: base.namespaces.clock + '.tenant_write_clock', domains: base.tables, consumer: 'clinical-level',
      projectionVersion: 'clinical-current-rows-v1', pageSize, maxRows: 10000, level: { lifecycleTable: controlNs + '.tenant_lifecycle_windows' } });
    const evaluators = new Map(), known = new Map();
    const stats = { hints: 0, staleHints: 0, runs: 0, refused: 0, completed: 0, errors: [], cycleCpuUs: 0 };
    const evaluatorOf = tenant => {
      if (!evaluators.has(tenant)) evaluators.set(tenant, projectionEvaluator({ tenant, replay, connection, env: base.env, language: base.language,
        dbstats: base.stats, maxRows: 10000, maxBytes: 8388608, includeFrame: true }));
      return evaluators.get(tenant);
    };
    let work;
    async function runTenant (tenant) {
      stats.runs++;
      const cpu = process.cpuUsage();
      const observed = await store.begin(tenant);
      const result = await evaluatorOf(tenant).evaluate({ at: Date.now() });
      if (gate) await gate(tenant, result);
      let completed;
      try {
        completed = await store.complete(tenant, { observed, identity: IDENTITY, result, restoreGeneration: result.generation });
      } catch (error) {
        if (error.code === 'EVALUATOR_COMPLETION_RESTORE_REFUSED') stats.refused++;
        else stats.errors.push(error.code || error.message);
        throw error;
      } finally { const used = process.cpuUsage(cpu); stats.cycleCpuUs += used.user + used.system; }
      known.set(tenant, result.generation);
      stats.completed++;
      // Level-triggered: input newer than this cycle's begin stays pending.
      if (Number.isSafeInteger(completed.pendingAt)) work.wake(tenant, 'recovery');
      return completed;
    }
    work = scheduler.start({ store, scan: async () => {}, run: runTenant, concurrency, retryMs, sweepMs });
    lab.api.hints = hints;
    const entry = {
      store, connection, stats, known,
      // The hint entry: tenant and generation only. Older than the generation
      // this process last completed means a restore already passed it.
      hint ({ tenant, generation }) {
        stats.hints++;
        const seen = known.get(tenant);
        if (seen !== undefined && generation !== undefined && BigInt(generation) < BigInt(seen)) { stats.staleHints++; return; }
        work.wake(tenant, 'clock');
      },
      sweep: () => work.sweep(), sweepStats: () => work.sweepStats(), scheduler: work,
      async close () { await work.close(); await store.close(); await connection.end(); for (const e of evaluators.values()) e.close(); }
    };
    lab.evaluator = entry;
    if (startupSweep) await work.sweep();
    return entry;
  };

  // ---- oracle: the durable completed output, read independently (admin)
  lab.outputs = async () => (await lab.admin.query(`SELECT tenant_id::text AS tenant, output_revision::text AS revision,
      output_restore_generation::text AS generation, work_pending_at::text AS pending,
      (projection->0->'output'->'result'->'properties'->'bgnow'->>'mills')::bigint AS last
    FROM ${lab.workTable} WHERE consumer=$1`, [COMPLETED])).rows;

  lab.close = async () => {
    await lab.evaluator?.close().catch(() => {});
    if (owned && lab.admin) { await lab.admin.query(`DROP SCHEMA IF EXISTS "${workNs}" CASCADE`); await lab.admin.query(`DROP SCHEMA IF EXISTS "${controlNs}" CASCADE`); }
    await base.close();
  };
  return lab;
};
module.exports.CONSUMER = CONSUMER;
