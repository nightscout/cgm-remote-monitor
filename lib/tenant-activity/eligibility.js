'use strict';

// Eligibility for background workers. A worker builds its work list from
// tenants eligible under the CURRENT durable activity state, not from
// configured presence: an ineligible tenant gets no acquisition, provider
// call, timer work or output. An unreadable or unprovisioned state is not
// eligible and is reported with its own code, never as intentional pause.
const policy = require('./policy');

function create ({ read } = {}) {
  if (typeof read !== 'function') throw new TypeError('Activity reader required');
  async function check (operation, tenant) {
    let row;
    try { row = await read(tenant); } catch { return Object.freeze({ tenant, eligible: false, state: null, code: 'ACTIVITY_UNAVAILABLE' }); }
    if (!row) return Object.freeze({ tenant, eligible: false, state: null, code: 'ACTIVITY_NOT_PROVISIONED' });
    const state = row.state;
    const eligible = policy.eligible(operation, state);
    return Object.freeze({ tenant, eligible, state, code: eligible ? null : 'TENANT_' + state.toUpperCase() });
  }
  // One read per tenant: tenant RLS binds each read to its own tenant.
  async function workList (operation, tenants) {
    const checked = await Promise.all([...tenants].map(tenant => check(operation, tenant)));
    return Object.freeze({ eligible: Object.freeze(checked.filter(row => row.eligible).map(row => row.tenant)),
      skipped: Object.freeze(checked.filter(row => !row.eligible)) });
  }
  return Object.freeze({ check, workList,
    // Hook for the future connector (vcpool) runtime: poll only these tenants.
    // Paused tenants keep polling; suspended tenants do not.
    connectorWorkList: tenants => workList('connector', tenants) });
}

module.exports = { create };
