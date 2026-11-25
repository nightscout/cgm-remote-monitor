'use strict';

// Writer-driven input transport (decision writer-driven-transport-direction),
// the only multitenant input transport.
//
// Correctness comes from two durable facts, never from a hint:
//   - the pending mark, written in the writer's own transaction on the
//     evaluator's completed-work row (work_observed[source] advances and
//     work_pending_at is set);
//   - the evaluator's sweep over pending rows (at startup and every sweepMs),
//     which recomputes each tenant from its current window.
// After COMMIT the writer sends a disposable `changed` hint to the owning
// evaluator slice (lib/internal-hints), which only shortens the wait.
const work = require('../pgstream/work-state');
const internal = require('../internal-hints');
const windowMark = require('./window-mark');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const CONSUMER = /^evaluator-[A-Za-z0-9_-]{1,112}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_MS = 5000;

// The periodic sweep interval: NS_EVALUATOR_SWEEP_MS, 100..600000, default 5000.
function sweepMs (source = process.env) {
  const raw = source?.NS_EVALUATOR_SWEEP_MS;
  if (raw === undefined || raw === '') return SWEEP_MS;
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) < 100 || Number(raw) > 600000) throw new TypeError('invalid NS_EVALUATOR_SWEEP_MS: a whole number from 100 to 600000 is required');
  return Number(raw);
}

// {namespace, consumer} of the evaluator's completed-work row ("<evaluator consumer>-completed").
function binding (value) {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'consumer,namespace' ||
      !NAME.test(value.namespace || '') || value.namespace === 'public' || value.namespace.startsWith('pg_') ||
      !CONSUMER.test(value.consumer || '') || !value.consumer.endsWith('-completed')) {
    throw new TypeError('Explicit evaluator pending binding required');
  }
  return Object.freeze({ namespace: value.namespace, consumer: value.consumer, table: '"' + value.namespace + '".tenant_consumer_checkpoint' });
}

// One UPDATE in the writer's transaction. The row's RLS tenant binding is the
// writer's own (app.current_tenant_id); a writer bound to another tenant
// updates nothing and is refused. `floor` is the write clock's committed floor
// for clock writes (the observed clock version never runs behind the clock).
const SQL = new Map(work.SOURCES.map((source, i) => [source, table =>
  'UPDATE ' + table + ' SET /* writer-pending-mark */ work_observed[' + (i + 1) + ']=GREATEST(COALESCE(work_observed[' + (i + 1) + '],0)+1,$3::bigint),' +
  'work_observed_at[' + (i + 1) + ']=$4::bigint,work_pending_at=COALESCE(work_pending_at,$4::bigint)' +
  ' WHERE tenant_id=$1 AND consumer=$2 AND work_version=2']));
// With the resident window switch (./window-mark.js) the same UPDATE also
// records what the transaction changed in the clinical window. `window` is the
// writer's collected notes; a mark without them (settings, lifecycle, any
// caller that does not know) is unbounded: the evaluator reads in full.
const WINDOW_SQL = new Map(work.SOURCES.map((source, i) => [source, table => {
  const base = SQL.get(source)(table), at = base.lastIndexOf(' WHERE tenant_id=$1');
  return base.slice(0, at) + windowMark.assignments(i + 1) + base.slice(at);
}]));
async function mark (query, selected, tenant, { source = 'clock', floor = 0, at = Date.now(), window } = {}) {
  if (typeof query !== 'function' || !selected?.table || !SQL.has(source) || !UUID.test(tenant || '') ||
      !Number.isSafeInteger(floor) || floor < 0 || !Number.isSafeInteger(at) || at < 0) throw new TypeError('Explicit evaluator pending mark required');
  const marked = windowMark.enabled()
    ? await query(WINDOW_SQL.get(source)(selected.table), [tenant, selected.consumer, floor, at, ...windowMark.values(source === 'clock' ? window : undefined)])
    : await query(SQL.get(source)(selected.table), [tenant, selected.consumer, floor, at]);
  if (marked.rowCount !== 1) throw Object.assign(new Error('EVALUATOR_PENDING_MARK_NOT_PROVISIONED'), { code: 'EVALUATOR_PENDING_MARK_NOT_PROVISIONED' });
}

// The provisioning transaction's mark: the completed-work row is created typed
// and pending (source bootstrap), so the first write's mark finds it and the
// evaluator's sweep finds the new tenant without a hint (admin has no private
// listener; decision S3 §7 question 4).
function provisionedRow (at = Date.now()) {
  const nulls = work.array({});
  const observed = work.array({ bootstrap: '1' }), observedAt = work.SOURCES.map(source => source === 'bootstrap' ? at : null);
  return { columns: 'work_version,work_observed,work_completed,work_observed_at,work_pending_at,projection',
    values: [2, observed, nulls, observedAt, at, JSON.stringify([{ kind: 'evaluator-work-v2', output: null }])] };
}

// The post-commit `changed` sender for a writer process. `local` is the
// evaluator's handler when this process serves the evaluator role.
function changedSender (source = process.env, { local, ordinal, maxInFlight } = {}) {
  const targets = internal.targets.fromEnvironment(source, { local: local ? { evaluator: local } : {}, ordinal: ordinal === undefined ? {} : { evaluator: ordinal } });
  const sender = internal.sender.create({ targets: { evaluator: targets.evaluator }, ...(maxInFlight ? { maxInFlight } : {}) });
  return Object.freeze({
    // Never throws, never awaited: the mark and the sweep are the guarantee.
    changed (tenant, { stamp, generation, domains, source: writer } = {}) {
      const fields = {};
      if (Number.isSafeInteger(stamp) && stamp >= 0) fields.stamp = stamp;
      if (generation !== undefined && generation !== null) fields.generation = String(generation);
      if (Array.isArray(domains)) fields.domains = domains;
      if (typeof writer === 'string') fields.source = writer;
      sender.changed(tenant, fields);
    },
    stats: sender.stats,
    close: sender.close
  });
}

// The pending writers' privileges on the evaluator's completed-work table: the
// columns the mark reads and writes, nothing else. Row-level security (the
// table's tenant isolation policy, decided by the writer's own tenant binding)
// limits each to its own tenant's row; the evaluator's own cross-tenant work
// reads keep their existing metadata policy.
// The window mark columns (./window-mark.js; work catalogue migration 0009)
// are granted whether or not the switch is on: the switch is a process
// setting, the grant a deployment one. The mark reads work_completed to tell
// whether earlier marks were consumed.
const MARK_COLUMNS = Object.freeze({ select: ['tenant_id', 'consumer', 'work_version', 'work_observed', 'work_pending_at', 'work_completed', ...windowMark.COLUMNS],
  update: ['work_observed', 'work_observed_at', 'work_pending_at', ...windowMark.COLUMNS] });
function grants ({ namespace, roles }) {
  const quote = name => { if (!NAME.test(name || '') || name.startsWith('pg_')) throw new TypeError('Explicit SQL identifier required'); return '"' + name + '"'; };
  if (!Array.isArray(roles) || !roles.length) throw new TypeError('Explicit pending writer roles required');
  const table = quote(namespace) + '.tenant_consumer_checkpoint';
  return roles.flatMap(role => ['GRANT USAGE ON SCHEMA ' + quote(namespace) + ' TO ' + quote(role),
    'GRANT SELECT(' + MARK_COLUMNS.select.join(',') + '), UPDATE(' + MARK_COLUMNS.update.join(',') + ') ON ' + table + ' TO ' + quote(role)]);
}

module.exports = { SWEEP_MS, MARK_COLUMNS, sweepMs, binding, mark, provisionedRow, changedSender, grants };
