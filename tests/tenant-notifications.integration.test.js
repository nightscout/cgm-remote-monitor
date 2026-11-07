'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const scope = require('../lib/storage/tenant-scope');
const createLab = require('./fixtures/tenant-notifications-native');
const { notification } = createLab;
const { optInSuite } = require('./support/opt-in');

optInSuite(process.env.NS_TENANT_NOTIFICATIONS_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_TENANT_NOTIFICATIONS_TEST=1 with disposable PostgreSQL')('durable tenant notification actual PostgreSQL', function () {
  this.timeout(30000);
  const lab = createLab();
  before(() => lab.open()); beforeEach(() => lab.reset()); after(() => lab.close());

  it('commits request and attempt before fake consumer entry and preserves admission/rearm across handles', async function () {
    lab.cycle(); const seen = [];
    const adapter = { id: 'synthetic', send (row, callback) {
      lab.rows().then(rows => { seen.push({ id: row.id, rows }); callback(null, { accepted: true, receipt: 'synthetic-receipt' }); }, callback);
    } };
    const first = lab.component({ adapter }); await first.run(lab.A);
    const saved = await lab.rows();
    lab.trace('commit-before-dispatch', { seen, saved, heads: await lab.heads() });
    assert.equal(seen[0].rows.length, 1, 'NOTIFICATION_NATIVE_DURABLE_REQUEST'); assert.equal(seen.length, 1);
    assert.equal(seen[0].rows[0].state, 'attempting', 'NOTIFICATION_NATIVE_COMMITTED_ATTEMPT');
    assert.equal(saved[0].state, 'accepted'); await first.close();
    lab.cycle(); await lab.component({ adapter }).run(lab.A); assert.equal(seen.length, 1);
    lab.now += 900001; lab.cycle(); await lab.component({ adapter }).run(lab.A);
    assert.equal(seen.length, 2); assert.notEqual(seen[1].id, seen[0].id, 'legitimate new alarm rearmed');
  });

  it('retries same durable identity after actual child death following fake acceptance without completion', async function () {
    const child = fork(path.join(__dirname, 'fixtures/tenant-notification-attempt-child.js'), [], {
      silent: true, env: { ...process.env, NS_NOTIFICATION_CHILD: JSON.stringify(lab.childConfig) }
    });
    let timer;
    const stopped = new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
      const accepted = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('NATIVE_NOTIFICATION_CHILD_BOUNDARY_TIMEOUT')), 15000);
        child.once('message', resolve); child.once('error', reject);
      }); clearTimeout(timer);
      const before = await lab.rows();
      assert.equal(accepted.phase, 'synthetic-acceptance-no-completion');
      assert.equal(before.length, 1); assert.equal(before[0].state, 'attempting');
      child.kill('SIGKILL'); const died = await stopped; assert.equal(died.signal, 'SIGKILL');
      lab.now = Math.max(Number(before[0].attempt_until), Number(before[0].created_at) + 30000) + 1; lab.cycle(); const retried = [];
      await lab.component({ adapter: { id: 'synthetic', send (row, callback) { retried.push(row); callback(null, { accepted: true }); } } }).run(lab.A);
      const after = await lab.rows(); lab.trace('child-death-uncertain-retry', { accepted, before, died, retried: retried.map(row => ({ id: row.id, attempt: row.attempt })), after });
      assert.equal(retried.length, 1); assert.equal(retried[0].id, accepted.id, 'NOTIFICATION_NATIVE_RETRY_IDENTITY');
      assert.equal(after.length, 1); assert.equal(after[0].state, 'accepted'); assert.equal(after[0].attempt, 2);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await stopped; }
  });

  it('rolls back inserted intent before failed transaction completion and persists uncertain callback instead of acceptance', async function () {
    lab.cycle(); let visibleDuringInsert;
    const observed = { ...lab.connection, transaction: fn => lab.connection.transaction(async () => {
      await fn(); visibleDuringInsert = await lab.rows(); throw new Error('SYNTHETIC_TRANSACTION_ABORT');
    }) };
    const failedStore = require('../lib/tenant-notifications/postgres')({ connection: observed, namespace: lab.name, maxRows: 10, maxBytes: 65536 });
    let attempts = 0;
    const adapter = { id: 'synthetic', send (row, callback) { attempts++; callback(new Error('synthetic uncertain callback')); } };
    await assert.rejects(lab.component({ store: failedStore, adapter }).run(lab.A), /SYNTHETIC_TRANSACTION_ABORT/);
    assert.deepEqual(visibleDuringInsert, []); assert.deepEqual(await lab.rows(), []);
    assert.equal(attempts, 0, 'NOTIFICATION_NATIVE_FAILED_COMMIT_NO_EFFECT');
    await lab.component({ adapter }).run(lab.A); const uncertain = await lab.rows();
    lab.trace('transaction-abort-and-uncertain-callback', { visibleDuringInsert, uncertain, attempts });
    assert.equal(uncertain.length, 1); assert.equal(uncertain[0].state, 'uncertain', 'NOTIFICATION_NATIVE_FAILED_SEND_NOT_ACCEPTED');
  });

  it('refuses new suppression and cleared condition on queued retry while foreign tenant is unchanged', async function () {
    lab.cycle(undefined, lab.B); await lab.component().run(lab.B); const foreign = await lab.rows(lab.B);
    lab.cycle(); let attempts = 0;
    const component = lab.component({ adapter: { id: 'synthetic', send (row, callback) { attempts++; callback(new Error('synthetic uncertain')); } } });
    await component.run(lab.A); const pending = await lab.rows(); lab.now += 30001; lab.suppressed = true;
    await component.retry(lab.A); const suppressed = await lab.rows();
    lab.trace('queued-suppression', { pending, suppressed, attempts, foreign, foreignAfter: await lab.rows(lab.B) });
    assert.equal(attempts, 1, 'NOTIFICATION_NATIVE_SUPPRESSION_NO_DISPATCH'); assert.equal(suppressed[0].state, 'cancelled');
    assert.deepEqual(await lab.rows(lab.B), foreign);
    lab.suppressed = false; lab.cycle([notification({ level: 2 })]);
    // Explicitly create another normal request, then make the current condition disappear.
    lab.current.result.emitted[0].level = 2; await component.run(lab.A); lab.now += 30001; lab.cycle([]);
    await component.retry(lab.A); assert.equal(attempts, 2, 'NOTIFICATION_NATIVE_NO_STALE_CONDITION');
  });

  it('enforces forced RLS and narrow SQL authority with actual denied writes', async function () {
    lab.cycle(); await lab.component().run(lab.A); const a = await lab.rows();
    lab.cycle(undefined, lab.B); await lab.component().run(lab.B); const b = await lab.rows(lab.B);
    const observed = await scope.withTenant(lab.A, () => lab.connection.query(`SELECT tenant_id FROM "${lab.name}".tenant_notification_requests`));
    assert.deepEqual(observed.rows.map(row => row.tenant_id), [lab.A], 'NOTIFICATION_NATIVE_RLS_FOREIGN_READ');
    await assert.rejects(scope.withTenant(lab.A, () => lab.connection.query(`INSERT INTO "${lab.name}".tenant_notification_heads (tenant_id,consumer,dedup_key,blocked_until) VALUES($1,'foreign','foreign',0)`, [lab.B])), { code: '42501' });
    await assert.rejects(scope.withTenant(lab.A, () => lab.connection.query(`INSERT INTO "${lab.name}".forbidden_clinical VALUES($1,'synthetic')`, [lab.A])), { code: '42501' });
    await assert.rejects(scope.withTenant(lab.A, () => lab.connection.query(`CREATE TABLE "${lab.name}".forbidden_schema (value text)`)), { code: '42501' });
    const roles = (await lab.admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [lab.role])).rows;
    lab.trace('restricted-role-rls', { a, b, observed: observed.rows, roles, foreignAfter: await lab.rows(lab.B) });
    assert.deepEqual(roles, [{ rolsuper: false, rolbypassrls: false }]); assert.deepEqual(await lab.rows(lab.B), b);
  });

  it('refuses unsafe RLS schema or inherited table authority before any consumed request effect', async function () {
    lab.cycle(); let effects = 0;
    const component = lab.component({ adapter: { id: 'synthetic', send (row, callback) { effects++; callback(null, { accepted: true }); } } });
    const cases = [
      { name: 'rls-disabled', up: `ALTER TABLE "${lab.name}".tenant_notification_heads DISABLE ROW LEVEL SECURITY`, down: `ALTER TABLE "${lab.name}".tenant_notification_heads ENABLE ROW LEVEL SECURITY` },
      { name: 'broad-table-update', up: `GRANT UPDATE ON "${lab.name}".tenant_notification_requests TO "${lab.role}"`, down: `REVOKE UPDATE ON "${lab.name}".tenant_notification_requests FROM "${lab.role}"` },
      { name: 'schema-create', up: `GRANT CREATE ON SCHEMA "${lab.name}" TO "${lab.role}"`, down: `REVOKE CREATE ON SCHEMA "${lab.name}" FROM "${lab.role}"` },
      { name: 'foreign-clinical-write', up: `GRANT INSERT ON "${lab.name}".forbidden_clinical TO "${lab.role}"`, down: `REVOKE INSERT ON "${lab.name}".forbidden_clinical FROM "${lab.role}"` }
    ];
    for (const scenario of cases) {
      await lab.admin.query(scenario.up);
      try {
        let error;
        try { await component.run(lab.A); } catch (caught) { error = { name: caught.name, message: caught.message }; }
        const physical = await lab.rows(); lab.trace('unsafe-readiness-' + scenario.name, { scenario: scenario.name, error, effects, physical });
        assert.equal(effects, 0, 'NOTIFICATION_NATIVE_UNSAFE_NO_EFFECT');
        assert.equal(error?.message, 'NOTIFICATION_SCHEMA_UNSAFE', 'NOTIFICATION_NATIVE_UNSAFE_REFUSAL');
        assert.deepEqual(physical, []);
      } finally { await lab.admin.query(scenario.down); }
    }
    await component.run(lab.A); assert.equal(effects, 1, 'restored leastprivilege path recovers');
  });

  it('persists selected consumer receipts and clears only explicitly acknowledged references without alarm fields', async function () {
    lab.cycle(); let clears = [];
    const component = lab.component({ adapter: { id: 'synthetic', send (row, callback) {
      if (row.notification.clear) clears = row.receipts;
      callback(null, { accepted: true, receipt: row.notification.clear ? null : 'native-synthetic-receipt',
        clearedRequestIds: row.notification.clear ? row.receipts.map(item => item.request_id) : [] });
    } } });
    await component.run(lab.A); const alarm = (await lab.rows())[0];
    lab.cycle([{ clear: true, title: 'All Clear', message: 'Synthetic clear' }]); await component.run(lab.A);
    const after = await lab.rows(); lab.trace('durable-receipt-clear', { alarm, clears, after });
    assert.deepEqual(clears, [{ request_id: alarm.request_id, receipt: 'native-synthetic-receipt' }]);
    assert.equal(Number(after.find(row => row.request_id === alarm.request_id).cleared_at), lab.now);
    assert.equal(after.find(row => row.payload.clear).state, 'accepted');
  });
});
