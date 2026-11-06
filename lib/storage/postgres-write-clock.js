'use strict';

// Explicit opt-in data-transaction decorator. This is not an authorization
// boundary, a raw-import protocol, or a durable event/outbox implementation.
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

module.exports = function writeClock (connection, namespace) {
  if (typeof namespace !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) ||
      namespace === 'public' || namespace.startsWith('pg_') || namespace === 'information_schema') {
    throw new TypeError('Explicit non-system write clock namespace required');
  }
  const table = '"' + namespace + '".tenant_write_clock';
  const transactions = new AsyncLocalStorage();
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
    async transaction (fn) {
      const outer = current();
      if (outer) return fn();
      const tenant = scope.requireTenant('tenant write clock');
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
        throw new TypeError('Tenant write clock requires a UUID binding');
      }
      const state = { tenant, active: true, events: [] };
      let result;
      try {
        result = await connection.transaction(async () => {
          const locked = await connection.query('SELECT last_stamp FROM ' + table +
            ' WHERE tenant_id = $1 FOR UPDATE', [tenant]);
          if (locked.rows.length !== 1) throw new Error('Tenant write clock is not provisioned');
          const initial = stamp(locked.rows[0].last_stamp);
          let floor = initial;
          state.next = requested => {
            if (!state.active) throw new Error('Tenant write clock transaction is closed');
            floor = stamp(Math.max(stamp(requested), floor + 1));
            state.stamp = floor;
            return floor;
          };
          return transactions.run(state, () => dates.withAllocator(state, async () => {
            let written;
            try { written = await fn(); } finally { state.active = false; }
            if (floor !== initial) {
              const updated = await connection.query('UPDATE ' + table +
                ' SET last_stamp = $1 WHERE tenant_id = $2 AND last_stamp = $3', [floor, tenant, initial]);
              if (updated.rowCount !== 1) throw new Error('Tenant write clock floor was not updated');
            }
            return written;
          }));
        });
      } finally { state.active = false; }
      // The underlying transaction has acknowledged COMMIT before publication.
      // Each queued function receives the transaction's final floor (its
      // commit stamp), or null when it allocated nothing.
      const committed = state.stamp === undefined ? null : state.stamp;
      state.events.forEach(publish => publish(committed));
      return result;
    }
  });
};
