'use strict';

// Plain datastore connection probe (decision datastore-loss-before-window-retirement).
// Each probe opens one short-lived direct client, reads the datastore identity
// (database, OID, endpoint and postmaster start) and closes the client. It uses
// no tenant scope, operation window, lifetime session or pooled backend, so it
// keeps answering after those retire. A failed connection or a changed
// postmaster is a datastore loss; the recovery supervisor then reports the
// process unavailable until it re-admits the datastore.
const { Client } = require('pg');
const connectionAdmission = require('../../storage/connection-admission');
const { SQL, cluster, identity } = require('../../storage/postgres-datastore');

const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function create ({ options, timeoutMs = 5000, Driver = Client } = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('Datastore probe requires connection options');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Datastore probe requires a bounded timeout');
  // Credentials can be non-enumerable (pg-pool style); copy descriptors, not values.
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of ['max', 'idleTimeoutMillis', 'application_name', 'connectionTimeoutMillis', 'statement_timeout', 'query_timeout']) delete descriptors[key];
  const Probe = connectionAdmission.wrapClient(Driver, 'datastore-probe');
  let admitted = null, admittedCluster, closed = false;
  async function observe (checkLineage) {
    if (closed) throw fail('DATASTORE_PROBE_CLOSED');
    const settings = Object.defineProperties({}, descriptors);
    Object.assign(settings, { application_name: 'nightscout-datastore-probe', connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs, query_timeout: timeoutMs });
    const client = new Probe(settings);
    client.on('error', () => {});
    try {
      await client.connect();
      const current = identity((await client.query('SELECT ' + SQL)).rows[0]);
      if (checkLineage) {
        const system = await cluster(client);
        if (admitted && (system !== admittedCluster || admitted.database !== current.database || admitted.database_oid !== current.database_oid)) {
          throw fail('DATASTORE_PROBE_REPLACED');
        }
        if (!admitted) admittedCluster = system;
      }
      return current;
    } finally { await client.end().catch(() => {}); }
  }
  return Object.freeze({
    // Serving check: the first answer is the admitted datastore.
    async probe () {
      const current = await observe(admitted === null);
      if (admitted === null) admitted = current;
      else if (!same(current, admitted)) throw fail('DATASTORE_PROBE_RESTARTED');
      return current;
    },
    // Recovery: report whether the reachable datastore is a new postmaster.
    async readmit () {
      const current = await observe(true);
      return { current, restarted: admitted !== null && !same(current, admitted) };
    },
    adopt (current) { admitted = identity(current); },
    get admitted () { return admitted; },
    close () { closed = true; }
  });
}

// A composed process can serve roles with different database credentials or
// databases. Observe each through its own serving credential. Keep admission
// sequential so a probe cycle holds at most one transient connection.
function forRoles (options) {
  const byRole = { api: options.preview?.connectionString, evaluator: options.evaluatorPreview?.connectionString,
    realtime: options.realtimePreview?.connectionString, 'tenant-admin': options.ownerPreview?.accessConnectionString };
  const roles = Object.keys(byRole).filter(role => byRole[role]);
  const connections = [...new Set(roles.map(role => byRole[role]))];
  if (!connections.length) return null;
  const probes = connections.map(connectionString => create({ options: { connectionString } }));
  return {
    roles,
    get admitted () { return probes[0].admitted; },
    async probe () { for (const probe of probes) await probe.probe(); },
    async readmit () {
      const seen = [];
      for (const probe of probes) seen.push(await probe.readmit());
      return { restarted: seen.some(row => row.restarted), current: seen.map(row => row.current) };
    },
    adopt (current) { probes.forEach((probe, index) => probe.adopt(current[index])); }
  };
}

module.exports = { create, forRoles };
