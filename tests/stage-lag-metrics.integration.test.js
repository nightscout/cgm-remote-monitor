'use strict';
// The completion delay control on actual PostgreSQL (alignment lane
// mt-plannable-scale-20261121, E3): the actual evaluator runtime completing
// through the actual typed checkpoint store. The writer's durable mark
// (work_pending_at) reaches M1 through complete()'s coveredAt; the injected
// delay must show in M1 and hold M2 up while it lasts; off, M1 stays small.
const assert = require('node:assert/strict');
const { optInSuite } = require('./support/opt-in');
const { create, WORK_COLUMNS } = require('../lib/pgstream/checkpoint');
const { run } = require('../lib/migrations/postgres');
const scope = require('../lib/storage/tenant-scope');
const metrics = require('../lib/metrics');
const startRuntime = require('../lib/server/serve/evaluator-runtime');
const delay = require('../lib/diagnostics/completion-delay');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI, 'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')(
  'stage lag (M1/M2) with the completion delay control on actual PostgreSQL', function () {
    this.timeout(60000);
    const lab = require('./fixtures/tenant-projection-evaluator')();
    let store, table;
    before(async () => {
      await lab.open(); table = '"' + lab.replayNamespace + '".tenant_consumer_checkpoint';
      await run('up', { direct: true, connectionString: process.env.NS_TEST_POSTGRES_ADMIN_URI, namespace: lab.replayNamespace, catalogue: require('../migrations/candidates/postgres-evaluator-work-v2.json') });
      await lab.admin.query('GRANT UPDATE(' + WORK_COLUMNS.join(',') + ') ON ' + table + ' TO "' + lab.readerRole + '"');
      await lab.admin.query('CREATE POLICY typed_receipts ON ' + table + ' TO "' + lab.readerRole + '" USING (consumer=\'evaluator-typed-completed\') WITH CHECK (consumer=\'evaluator-typed-completed\')');
    });
    beforeEach(async () => {
      await lab.reset();
      store = create({ connection: lab.reader, namespace: lab.replayNamespace, consumer: 'evaluator-typed', maxBytes: 4194304, timeIntervalMs: 60000, typed: true });
      await lab.provision(store.consumer, lab.A, null, 0, store.digest);
      await store.own(() => {}); await store.admit([lab.A]);
      metrics.configure(['evaluator'], { NS_METRICS: 'true' });
    });
    afterEach(async () => { metrics.reset(); await store?.close(); });
    after(() => lab.close());

    let checkpoint = 0;
    const result = () => ({ checkpoint: ++checkpoint, trigger: 'acquisition', properties: { bgnow: 100 + checkpoint }, emitted: [], requested: [], rows: [],
      frame: { sgvs: [{ mgdl: 100 + checkpoint }], lastUpdated: Date.now() }, due: { dueAt: Date.now() + 60000, slow: [] } });
    const runtime = env => startRuntime({ tenants: [lab.A], externalRecovery: true, recoveryIntervalMs: 60000, timeIntervalMs: 60000,
      completionDelayMs: delay.fromEnvironment(env),
      readCurrent: async tenant => ({ tenant, identity: 'a'.repeat(64) }),
      create: async () => ({ async evaluate () { return result(); }, async evaluateTime () { return result(); }, close () {} }),
      schedule: () => ({}), cancel () {},
      durable: { pendingMs: 600000,
        begin: tenant => scope.withTenant(tenant, () => store.begin(tenant)),
        complete: (tenant, value) => scope.withTenant(tenant, () => store.complete(tenant, value)) } });
    const lag = async () => {
      const text = await metrics.current.text();
      const read = suffix => Number((text.match(new RegExp('^nightscout_evaluator_completion_lag_seconds_' + suffix + '\\{[^}]*\\} (\\S+)$', 'm')) || [])[1] || 0);
      return { count: read('count'), sum: read('sum') };
    };
    // A write: the writer's durable observation (sets work_pending_at), then the hint the runtime receives.
    async function write (service, version) {
      await store.observe(lab.A, 'clock', String(version));
      service.markPending(lab.A, Date.now());
    }

    for (const [name, ms] of [['off', ''], ['on', '1500']]) it('delay ' + name + ': M1 ' + (ms ? 'shows' : 'stays below') + ' the delay; M2 ' + (ms ? 'rises' : 'clears'), async function () {
      const service = await runtime({ [delay.KEY]: ms });
      try {
        await write(service, 1);
        const cycle = service.acquire(lab.A);
        if (ms) {
          await sleep(700);
          const during = service.pendingSummary();
          assert.equal(during.pending, 1, 'M2_PENDING_DURING_DELAY');
          assert.ok(during.oldestAgeMs >= 600, 'M2_AGE ' + during.oldestAgeMs);
        }
        await cycle;
        const observed = await lag();
        const row = (await lab.admin.query('SELECT work_pending_at, work_completed_at, lag_count::int AS count, lag_sum_ms::int AS sum, lag_buckets::int[] AS buckets FROM ' + table + ' WHERE consumer=$1 AND tenant_id=$2', [store.consumer, lab.A])).rows[0];
        console.log('    ' + JSON.stringify({ delayMs: Number(ms || 0), m1: observed, after: service.pendingSummary(), workPendingAt: row.work_pending_at, durable: { count: row.count, sumMs: row.sum, buckets: row.buckets } }));
        // Durable M1 on the row (work catalogue 0010): the same count as the
        // Prometheus M1, and the delay moves it to the 1-2 s bucket.
        assert.equal(row.count, observed.count, 'DURABLE_COUNT_EQUALS_PROMETHEUS');
        assert.ok(Math.abs(row.sum / 1000 - observed.sum) < 0.25, 'DURABLE_SUM_NEAR_PROMETHEUS ' + row.sum + ' ' + observed.sum);
        if (ms) assert.equal(row.buckets[3], 1, 'DELAY_MOVES_DURABLE_BUCKET ' + row.buckets);
        else assert.equal(row.buckets[0] + row.buckets[1] + row.buckets[2], 1, 'NO_DELAY_DURABLE_BELOW_1S ' + row.buckets);
        assert.equal(observed.count, 1, 'ONE_COVERING_COMPLETION');
        assert.equal(row.work_pending_at, null, 'DURABLE_INPUT_COVERED');
        if (ms) assert.ok(observed.sum >= 1.45 && observed.sum < 5, 'M1_SHOWS_DELAY ' + observed.sum);
        else assert.ok(observed.sum < 1, 'M1_WITHOUT_DELAY ' + observed.sum);
        assert.equal(service.pendingSummary().pending, 0);
      } finally { await service.close(); }
    });
  });
