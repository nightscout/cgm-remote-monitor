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
const { SQL, identity } = require('../../storage/postgres-datastore');

const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function create ({ options, timeoutMs = 5000, Driver = Client } = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('Datastore probe requires connection options');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('Datastore probe requires a bounded timeout');
  // Credentials can be non-enumerable (pg-pool style); copy descriptors, not values.
  const descriptors = Object.getOwnPropertyDescriptors(options);
  for (const key of ['max', 'idleTimeoutMillis', 'application_name', 'connectionTimeoutMillis', 'statement_timeout', 'query_timeout']) delete descriptors[key];
  const Probe = connectionAdmission.wrapClient(Driver, 'datastore-probe');
  let admitted = null, closed = false;
  async function observe () {
    if (closed) throw fail('DATASTORE_PROBE_CLOSED');
    const settings = Object.defineProperties({}, descriptors);
    Object.assign(settings, { application_name: 'nightscout-datastore-probe', connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs, query_timeout: timeoutMs });
    const client = new Probe(settings);
    client.on('error', () => {});
    try {
      await client.connect();
      return identity((await client.query('SELECT ' + SQL)).rows[0]);
    } finally { await client.end().catch(() => {}); }
  }
  return Object.freeze({
    // Serving check: the first answer is the admitted datastore.
    async probe () {
      const current = await observe();
      if (admitted === null) admitted = current;
      else if (!same(current, admitted)) throw fail('DATASTORE_PROBE_RESTARTED');
      return current;
    },
    // Recovery: report whether the reachable datastore is a new postmaster.
    async readmit () {
      const current = await observe();
      return { current, restarted: admitted !== null && !same(current, admitted) };
    },
    adopt (current) { admitted = identity(current); },
    get admitted () { return admitted; },
    close () { closed = true; }
  });
}

module.exports = { create };
