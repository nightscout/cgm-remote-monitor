'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const POOL_MAX = 4;
// Decision trusted-worker-performance-boundary: the catalogue-wide integrity
// screen runs when a physical backend is admitted and at a bounded cadence,
// not on every tenant read. 0 restores a screen before every value read.
const SCREEN_INTERVAL_MS = 60000, SCREEN_INTERVAL_MAX_MS = 3600000;
// Binds a backend admission callback to the read whose checkout caused it.
const admissions = new AsyncLocalStorage();
const connect = require('../storage/postgres-connection');
const scope = require('../storage/tenant-scope');
const { options, inspect } = require('../migrations/postgres-check');
const { MigrationError } = require('../migrations/catalogue');
const readinessCheck = require('./readiness-check');
const { resolveEffectiveSettings } = require('./component');
const failure = code => Object.assign(new Error(code), { code });

// Presentation-only read capability: never supplies a storage/write environment,
// owner actor or credential authority. Both inputs come from one SQL snapshot.
module.exports = async function effectiveSettings ({ connectionString, namespaces: inputNamespaces, screenIntervalMs = SCREEN_INTERVAL_MS },
  { now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(screenIntervalMs) || screenIntervalMs < 0 || screenIntervalMs > SCREEN_INTERVAL_MAX_MS) throw new TypeError('Bounded settings screen interval required');
  if (typeof now !== 'function') throw new TypeError('Settings screen clock must be a function');
  const namespaces = inputNamespaces && Object.freeze({ ...inputNamespaces });
  const valid = name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    !['public', 'information_schema'].includes(name) && !name.startsWith('pg_');
  function validate () {
    if (scope.getTenancyMode() !== 'multi' || !namespaces || !valid(namespaces.settings) ||
        !valid(namespaces.operatorPolicy) || namespaces.settings === namespaces.operatorPolicy) throw new TypeError('Explicit settings read namespaces required');
  }
  validate();
  const catalogueInputs = () => Object.entries({ settings: require('./postgres-candidate.json'),
    operatorPolicy: require('../operator-policy/postgres-candidate.json') }).map(([kind, catalogue]) =>
    options({ direct: true, connectionString, namespace: namespaces[kind], catalogue, statementTimeoutMs: 5000 }));
  // The same explicit URL/SSL/PG-default contract as public migration checks.
  catalogueInputs();
  const settings = '"' + namespaces.settings + '".tenant_settings';
  const policy = '"' + namespaces.operatorPolicy + '".tenant_operator_policy';
  async function screen (query) {
    await readinessCheck(query);
    for (const opts of catalogueInputs()) {
      const state = await inspect(query, opts);
      if (!state.current) throw new MigrationError('MIG_STALE', 'schema is stale; an operator must run migrate up');
    }
    const rows = (await query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS secured,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owns, has_table_privilege(c.oid,'SELECT') AS reads,
      has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
        has_any_column_privilege(c.oid,'INSERT,UPDATE,REFERENCES') AS writes
      FROM pg_class c WHERE c.oid=ANY($1::regclass[])`, [[settings, policy]])).rows;
    if (rows.length !== 2 || rows.some(row => !row.secured || row.owns || !row.reads || row.writes)) throw failure('SETTINGS_STORE_UNSAFE');
  }
  // Fail closed across concurrent reads. Every read takes a ticket BEFORE its
  // snapshot begins. A failure refuses all reads until a screen whose snapshot
  // began after that failure was recorded passes; a pass ages out after the
  // interval, and the next read screens before its value SELECT.
  let issued = 0, refusedThrough = 0, passed = { ticket: 0, at: -Infinity };
  const due = ticket => ticket.admitted || passed.ticket <= refusedThrough || ticket.at - passed.at >= screenIntervalMs;
  async function screenFor (ticket, query) {
    if (!due(ticket)) return;
    try { await screen(query); }
    catch (error) { refusedThrough = issued; throw error; }
    if (ticket.id > passed.ticket) passed = { ticket: ticket.id, at: ticket.at };
  }
  const connection = await connect({ connectionString, direct: true, displaySettings: true,
    max: POOL_MAX, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: 'nightscout-display-settings',
    // Every new physical backend is screened before its first value read. A
    // read's backend is screened inside that read's own snapshot; any failed
    // read evicts its backend, so only a passed screen keeps it admitted.
    async admitBackend (client) {
      const ticket = admissions.getStore();
      if (ticket) { ticket.admitted = true; return; }
      // Pool construction admits its first backend outside any read.
      const own = { id: ++issued, at: now(), admitted: true };
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await screenFor(own, (text, values) => client.query(text, values));
      await client.query('ROLLBACK');
    } });
  return Object.freeze({
    // A due screen and the value share one owned READ ONLY snapshot.
    async read (tenant, { signal } = {}) {
      if (typeof tenant !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) throw new TypeError('Canonical settings tenant required');
      validate();
      signal?.throwIfAborted();
      const ticket = { id: ++issued, at: now(), admitted: false };
      return admissions.run(ticket, () => connection.readOnlySnapshot(tenant, async ({ query }) => {
        await screenFor(ticket, query);
        signal?.throwIfAborted();
        const row = (await query(`SELECT s.version,s.values,p.generation,p.policy FROM ${settings} s
          JOIN ${policy} p ON p.tenant_id=s.tenant_id WHERE s.tenant_id=$1`, [tenant])).rows[0];
        if (!row) throw failure('SETTINGS_POLICY_UNAVAILABLE');
        return resolveEffectiveSettings({ version: row.version, values: row.values }, { ...row.policy, generation: row.generation });
      }));
    },
    close () { return connection.end(); }
  });
};

module.exports.POOL_MAX = POOL_MAX;
module.exports.SCREEN_INTERVAL_MS = SCREEN_INTERVAL_MS;
