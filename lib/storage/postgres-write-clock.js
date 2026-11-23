'use strict';

// Commit-safe public history dates. Only writes that issue srvModified need
// this tenant lock. Native complete-transaction intake and raw delivery observe
// canonical WAL commits independently; they do not require a clock seal event.
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = require('./tenant-scope');
const dates = require('../server/srv-dates');
const LIMIT = 8640000000000000;

function stamp (value) {
  const number = Number(value);
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) ||
      !Number.isSafeInteger(number) || number < 0 || number >= LIMIT) {
    throw new RangeError('Invalid tenant write clock floor');
  }
  return number;
}

// Writer-driven transport (lib/writer-driven): an optional pending binding.
// pending.table/consumer name the evaluator's completed-work row; every write
// transaction through this clock (history or not) marks that tenant pending in
// the same transaction, and after COMMIT a disposable hint goes to
// pending.hint(tenant, stamp). The hint is never awaited and never the
// guarantee: the durable mark and the evaluator's sweep are.
const writerDriven = require('../writer-driven');
const windowMark = require('../writer-driven/window-mark');
const lateStamp = require('./late-stamp');
function pendingBinding (pending) {
  if (pending === undefined) return null;
  if (!pending || !/^"[a-z][a-z0-9_]{0,62}"\.tenant_consumer_checkpoint$/.test(pending.table) ||
      !/^evaluator-[A-Za-z0-9_-]{1,112}$/.test(pending.consumer) ||
      (pending.hint !== undefined && typeof pending.hint !== 'function')) throw new TypeError('Explicit evaluator pending binding required');
  return pending;
}

module.exports = function writeClock (connection, namespace, { pending: pendingOption } = {}) {
  const pending = pendingBinding(pendingOption);
  const mark = (tenant, floor, window) => writerDriven.mark((text, values) => connection.query(text, values), pending, tenant, { source: 'clock', floor: Number(floor), window });
  // Resident window switch (lib/writer-driven/window-mark.js): the storage
  // writer notes what this transaction changes in the clinical window, and
  // the mark carries it. Off: fn runs as it always did.
  const collectNotes = !!pending && windowMark.enabled();
  function hint (tenant, stamp) {
    if (!pending?.hint) return;
    try { Promise.resolve(pending.hint(tenant, stamp)).catch(() => {}); } catch { /* the sweep recovers a lost hint */ }
  }
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Explicit non-system write clock namespace required');
  }
  const table = '"' + namespace + '".tenant_write_clock';
  const transactions = new AsyncLocalStorage();

  // Under the clock: has any row committed since S0 overlapped a read? One
  // statement over every table read; the match is postgres-filter's own
  // semantics (projection-memory-read's matcher). A filter the matcher cannot
  // evaluate overlaps every newer row.
  async function overlapped (reads, floor0) {
    const tables = [...reads.keys()];
    if (!tables.length) return false;
    const { matcher } = require('./projection-memory-read');
    const text = tables.map((name, index) => {
      if (!/^"[a-z_][a-z0-9_]*"(?:\."[a-z_][a-z0-9_]*")?$/.test(name)) throw new TypeError('Late-stamp read of an unexpected table');
      const newer = /"(entries|treatments|devicestatus)"$/.test(name) ? '"srvModified" > $1::numeric'
        : "jsonb_typeof(doc->'srvModified') = 'number' AND (doc->>'srvModified')::numeric > $1::numeric";
      return `SELECT ${index}::int AS t, id_kind, doc FROM ${name} WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid AND ${newer}`;
    }).join(' UNION ALL ');
    const { rows } = await connection.query(text, [String(floor0)]);
    if (!rows.length) return false;
    const tests = tables.map(name => {
      const entry = reads.get(name);
      return { ids: entry.ids, predicates: entry.asts.map(ast => { try { return matcher(ast); } catch { return () => true; } }) };
    });
    return rows.some(row => {
      const test = tests[row.t];
      return test.ids.has(row.id_kind + ':' + String(row.doc._id)) || test.predicates.some(match => match(row));
    });
  }

  // NS_CLOCK_LATE_STAMP: reads first without the clock row; then the clock
  // row (reserving every stamp handed out), the read validation, the deferred
  // writes and COMMIT (late-stamp.js).
  async function lateTransaction (tenant, fn, { roots = [] } = {}) {
    const state = { tenant, active: true, events: [] };
    const ctx = { locked: false, overlapped: false, reads: new Map(), translate: null, lock: null };
    let result, translate = null;
    try {
      result = await connection.transaction(async () => {
        const observed = await connection.query('SELECT last_stamp FROM ' + table + ' WHERE tenant_id = $1', [tenant]);
        if (observed.rows.length !== 1) throw new Error('Tenant write clock is not provisioned');
        const floor0 = stamp(observed.rows[0].last_stamp);
        let provisional = lateStamp.PROVISIONAL - 1, initial, floor, locking = null;
        state.next = requested => {
          if (!state.active) throw new Error('Tenant write clock transaction is closed');
          if (!ctx.locked) {
            provisional = lateStamp.isProvisional(requested) ? Math.max(requested, provisional + 1) : provisional + 1;
            if (!lateStamp.isProvisional(provisional)) throw new RangeError('Late-stamp provisional range exhausted');
            state.stamp = provisional;
            return provisional;
          }
          floor = stamp(Math.max(stamp(lateStamp.isProvisional(requested) ? ctx.translate(requested) : requested), floor + 1));
          state.stamp = floor;
          return floor;
        };
        ctx.lock = () => locking || (locking = (async () => {
          const count = provisional - lateStamp.PROVISIONAL + 1;
          let base = 0;
          if (count > 0) {
            const reserved = await connection.query('UPDATE ' + table +
              ' SET last_stamp = GREATEST(last_stamp + $2::bigint, $3::bigint + $2::bigint - 1) WHERE tenant_id = $1 RETURNING last_stamp',
            [tenant, count, stamp(Date.now())]);
            if (reserved.rows.length !== 1) throw new Error('Tenant write clock is not provisioned');
            initial = floor = stamp(reserved.rows[0].last_stamp);
            base = floor - count + 1;
          } else {
            const held = await connection.query('SELECT last_stamp FROM ' + table + ' WHERE tenant_id = $1 FOR UPDATE', [tenant]);
            if (held.rows.length !== 1) throw new Error('Tenant write clock is not provisioned');
            initial = floor = stamp(held.rows[0].last_stamp);
          }
          translate = ctx.translate = value => {
            if (!lateStamp.isProvisional(value)) return value;
            if (value > provisional) throw new RangeError('Unreserved provisional stamp');
            return base + (value - lateStamp.PROVISIONAL);
          };
          ctx.locked = true;
          if (state.stamp !== undefined) state.stamp = translate(state.stamp);
          ctx.overlapped = await overlapped(ctx.reads, floor0);
          return ctx.overlapped;
        })());
        return transactions.run(state, () => dates.withAllocator(state, () => lateStamp.run(ctx, async () => {
          let written, window;
          const body = async () => { const value = await fn(); await ctx.lock(); return value; };
          try {
            if (collectNotes) ({ value: written, window } = await windowMark.collect(body));
            else written = await body();
          } finally { state.active = false; }
          if (floor !== initial) {
            const updated = await connection.query('UPDATE ' + table +
              ' SET last_stamp = $1 WHERE tenant_id = $2 AND last_stamp = $3', [floor, tenant, initial]);
            if (updated.rowCount !== 1) throw new Error('Tenant write clock floor was not updated');
          }
          if (pending) await mark(tenant, floor, window);
          return written;
        })));
      });
    } finally { state.active = false; }
    // The caller's documents and reply carry reserved stamps, never provisional ones.
    if (translate) [result, ...roots].forEach(root => lateStamp.translateDeep(root, translate));
    const committed = state.stamp === undefined ? null : state.stamp;
    state.events.forEach(publish => publish(committed));
    if (pending) hint(tenant, committed);
    return result;
  }
  function current () {
    const active = transactions.getStore();
    if (active && (!active.active || active.tenant !== scope.requireTenant('tenant write clock'))) {
      throw new Error('Tenant write clock transaction is closed or belongs to another tenant');
    }
    return active;
  }
  return Object.assign({}, connection, {
    afterCommit (fn) {
      const active = current();
      if (active) active.events.push(fn);
      else fn();
    },
    // The floor the active transaction has allocated so far, or null when
    // nothing has been allocated or no clock transaction is active. The final
    // floor is what the queued afterCommit functions receive; this is the
    // in-transaction view. A closed or foreign-tenant context throws as
    // afterCommit does.
    currentStamp () {
      const active = current();
      return active && active.stamp !== undefined ? active.stamp : null;
    },
    async transaction (fn, { history = true, reserveFirst = false, settleBeforeLock, late } = {}) {
      const outer = current();
      if (outer) return fn();
      if (!history) {
        if (!pending) return connection.transaction(fn);
        // Activity, prune and hard delete take no clock stamp; they still mark.
        const unstamped = scope.requireTenant('tenant write clock');
        const value = await connection.transaction(collectNotes
          ? async () => { const result = await windowMark.collect(fn); await mark(unstamped, 0, result.window); return result.value; }
          : async () => { const result = await fn(); await mark(unstamped, 0); return result; });
        hint(unstamped, null);
        return value;
      }
      const tenant = scope.requireTenant('tenant write clock');
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
        throw new TypeError('Tenant write clock requires a UUID binding');
      }
      // NS_CLOCK_LATE_STAMP (late-stamp.js): only for callers that ask for it,
      // never with a reserved first stamp or a read-only resend probe.
      if (late && !reserveFirst && !settleBeforeLock && lateStamp.enabled()) return lateTransaction(tenant, fn, late);
      const state = { tenant, active: true, events: [] };
      let result;
      try {
        result = await connection.transaction(async () => {
          // A read-only resend is decided by one ordinary snapshot. It still
          // requires a provisioned clock, but cannot acquire a canonical lock.
          if (settleBeforeLock && await settleBeforeLock()) {
            const row = await connection.query('SELECT last_stamp FROM ' + table + ' WHERE tenant_id = $1', [tenant]);
            if (!row.rows.length) throw new Error('Tenant write clock is not provisioned');
            return fn();
          }
          // Known timestamp-producing writes consume this first value in the
          // same transaction as their data. Nested and bulk writes can still
          // allocate more and persist their final floor below.
          const locked = reserveFirst
            ? await connection.query('UPDATE ' + table +
              ' SET last_stamp = GREATEST(last_stamp + 1, $2::bigint) WHERE tenant_id = $1 RETURNING last_stamp',
            [tenant, stamp(Date.now())])
            : await connection.query('SELECT last_stamp FROM ' + table + ' WHERE tenant_id = $1 FOR UPDATE', [tenant]);
          if (locked.rows.length !== 1) throw new Error('Tenant write clock is not provisioned');
          const initial = stamp(locked.rows[0].last_stamp);
          let floor = initial;
          state.next = requested => {
            if (!state.active) throw new Error('Tenant write clock transaction is closed');
            floor = reserveFirst && state.stamp === undefined ? initial : stamp(Math.max(stamp(requested), floor + 1));
            state.stamp = floor;
            return floor;
          };
          return transactions.run(state, () => dates.withAllocator(state, async () => {
            let written, window;
            try {
              if (collectNotes) ({ value: written, window } = await windowMark.collect(fn));
              else written = await fn();
            } finally { state.active = false; }
            if (reserveFirst && state.stamp === undefined) throw new Error('Reserved history stamp was not consumed');
            if (floor !== initial) {
              const updated = await connection.query('UPDATE ' + table +
                ' SET last_stamp = $1' +
                ' WHERE tenant_id = $2 AND last_stamp = $3', [floor, tenant, initial]);
              if (updated.rowCount !== 1) throw new Error('Tenant write clock floor was not updated');
            }
            if (pending) await mark(tenant, floor, window);
            return written;
          }));
        });
      } finally { state.active = false; }
      // The underlying transaction has acknowledged COMMIT before publication.
      // Each queued function receives the transaction's final floor (its
      // commit stamp), or null when it allocated nothing.
      const committed = state.stamp === undefined ? null : state.stamp;
      state.events.forEach(publish => publish(committed));
      if (pending) hint(tenant, committed);
      return result;
    }
  });
};
