'use strict';

// One member of one pool kind, backed by the pool_membership table of
// lib/pool-membership/postgres-candidate.json. Rows are keyed by pool kind,
// ordinal and member incarnation, so two processes claiming one ordinal are
// two visible rows (a conflict), not one overwritten row. Lease times are the
// database clock's, never this process's.
//
// Capabilities, each a separate database identity:
//   member     SELECT; INSERT; UPDATE (heartbeat_at, lease_expires_at) only;
//              DELETE (its own row on close, its ordinal's expired rows on register)
//   inspector  SELECT only (operational reads; never writes, never alerts)
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { run } = require('../migrations/postgres');
const { RULE, predicate, shape } = require('./slice');
const { assess } = require('./assess');
const { checkKind } = require('./config');

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const catalogue = require('./postgres-candidate.json');
const refuse = code => Object.assign(new Error(code), { code });
const q = name => '"' + name + '"';
function checkNamespace (namespace) {
  if (typeof namespace !== 'string' || !NAME.test(namespace) || ['public', 'information_schema'].includes(namespace) ||
      namespace.startsWith('pg_')) throw new TypeError('Explicit pool namespace required');
  return namespace;
}

function grants ({ namespace, member, inspector }) {
  const table = q(checkNamespace(namespace)) + '.pool_membership';
  const statements = [];
  for (const role of [member, inspector].filter(Boolean)) {
    if (!NAME.test(role)) throw new TypeError('Explicit pool role required');
    statements.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role),
      'GRANT SELECT ON ' + q(namespace) + '.schema_migrations TO ' + q(role),
      'GRANT SELECT ON ' + table + ' TO ' + q(role));
  }
  if (member) statements.push('GRANT INSERT, DELETE, UPDATE (heartbeat_at, lease_expires_at) ON ' + table + ' TO ' + q(member));
  return Object.freeze(statements);
}

const EXPECTED = Object.freeze({
  member: { inserts: true, deletes: true, updates: ['heartbeat_at', 'lease_expires_at'] },
  inspector: { inserts: false, deletes: false, updates: [] }
});

const ROWS = `SELECT ordinal, member_id::text AS member_id, expected_members, slice_rule, lease_expires_at > now() AS live,
  floor(extract(epoch FROM (lease_expires_at - now())) * 1000)::bigint::text AS lease_remaining_ms,
  floor(extract(epoch FROM (now() - heartbeat_at)) * 1000)::bigint::text AS heartbeat_age_ms
  FROM TABLE WHERE pool_kind = $1 ORDER BY ordinal, member_id`;

async function create ({ kind, members, ordinal, leaseMs, connectionString, namespace, capability = 'member',
  onAlert = event => console.error('Pool membership alert:', JSON.stringify(event)), applicationName } = {}) {
  checkKind(kind); checkNamespace(namespace); shape(members, ordinal);
  if (!Object.hasOwn(EXPECTED, capability)) throw new TypeError('Pool capability must be member or inspector');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 600000) throw new TypeError('Pool lease must be 100..600000 ms');
  if (typeof onAlert !== 'function') throw new TypeError('Pool alert sink must be a function');
  // The reviewed schema must be current before any membership statement.
  await run('check', { direct: true, connectionString, namespace, catalogue, statementTimeoutMs: 5000 });
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: applicationName || 'nightscout-pool-' + kind });
  const table = q(namespace) + '.pool_membership';
  try {
    const row = (await pool.query(`SELECT pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
        has_table_privilege(c.oid, 'SELECT') AS reads, has_table_privilege(c.oid, 'INSERT') AS inserts,
        has_table_privilege(c.oid, 'DELETE') AS deletes, has_table_privilege(c.oid, 'TRUNCATE,TRIGGER,REFERENCES') AS destroys,
        ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege(c.oid, a.attnum, 'UPDATE') ORDER BY a.attname) AS updates
      FROM pg_class c WHERE c.oid = to_regclass($1)`, [table])).rows[0];
    const expected = EXPECTED[capability];
    if (!row || row.owns || row.destroys || !row.reads || row.inserts !== expected.inserts || row.deletes !== expected.deletes ||
        JSON.stringify(row.updates) !== JSON.stringify(expected.updates)) throw refuse('POOL_STORE_UNSAFE');
  } catch (error) {
    await pool.end();
    throw error.code === 'POOL_STORE_UNSAFE' ? error : refuse('POOL_STORE_UNAVAILABLE');
  }

  const memberId = randomUUID();
  const self = Object.freeze({ memberId, ordinal, members, rule: RULE });
  const includes = predicate(members, ordinal);
  let registered = false, closed = false, alerted = null;
  const ownRow = [kind, ordinal, memberId];
  const configured = Object.freeze({ mode: 'partitioned', members, ordinal, rule: RULE, leaseMs, memberId });

  async function rows () {
    return (await pool.query(ROWS.replace('TABLE', table), [kind])).rows.map(row => Object.freeze({
      ordinal: row.ordinal, memberId: row.member_id, expectedMembers: row.expected_members, rule: row.slice_rule, live: row.live,
      leaseRemainingMs: Number(row.lease_remaining_ms), heartbeatAgeMs: Number(row.heartbeat_age_ms), self: row.member_id === memberId }));
  }
  function signal (reason, detail) {
    if (reason === alerted) return;
    const previous = alerted; alerted = reason;
    try {
      if (reason) onAlert({ kind, ordinal, members, state: 'refused', reason, ...detail });
      else if (previous) onAlert({ kind, ordinal, members, state: 'recovered', previous });
    } catch { /* an alert sink never changes the verdict */ }
  }
  async function renew () {
    await pool.query(`INSERT INTO ${table} (pool_kind, ordinal, member_id, expected_members, slice_rule, registered_at, heartbeat_at, lease_expires_at)
      VALUES ($1, $2, $3, $4, $5, now(), now(), now() + $6 * interval '1 millisecond')
      ON CONFLICT (pool_kind, ordinal, member_id) DO UPDATE SET heartbeat_at = now(), lease_expires_at = EXCLUDED.lease_expires_at`,
    [...ownRow, members, RULE, leaseMs]);
  }
  const writer = capability === 'member';
  const member = {
    kind, capability, configured,
    async register () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed) throw refuse('POOL_CLOSED');
      if (registered) return { registered: true, memberId };
      try {
        // The predecessor incarnation of this ordinal, if its lease expired, is
        // removed; a live one stays and is reported as a duplicate ordinal.
        await pool.query(`DELETE FROM ${table} WHERE pool_kind = $1 AND ordinal = $2 AND lease_expires_at <= now()`, [kind, ordinal]);
        await renew();
      } catch { throw refuse('POOL_UNAVAILABLE'); }
      registered = true;
      return { registered: true, memberId };
    },
    async heartbeat () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || !registered) return { renewed: false, reason: closed ? 'POOL_CLOSED' : 'POOL_NOT_REGISTERED' };
      try { await renew(); return { renewed: true }; } catch { return { renewed: false, reason: 'POOL_UNAVAILABLE' }; }
    },
    // Read before each cycle. A refusal is fail-closed and raises the alert on
    // each change of reason; recovery is signalled once.
    async slice () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || !registered) return Object.freeze({ eligible: false, reason: closed ? 'POOL_CLOSED' : 'POOL_NOT_REGISTERED', conflicts: [] });
      let verdict;
      try { verdict = assess(self, await rows()); } catch {
        signal('POOL_UNAVAILABLE', {});
        return Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] });
      }
      if (!verdict.eligible) {
        signal(verdict.reason, { conflicts: verdict.conflicts });
        return Object.freeze({ eligible: false, reason: verdict.reason, conflicts: verdict.conflicts });
      }
      signal(null);
      return Object.freeze({ eligible: true, includes, members, ordinal, rule: RULE, missingOrdinals: verdict.missingOrdinals });
    },
    // Read-only: configured values beside observed membership. Never writes,
    // renews, alerts or changes eligibility.
    async inspect () {
      let observed;
      try {
        const all = await rows();
        const verdict = assess(self, all);
        observed = { rows: all, liveOrdinals: verdict.liveOrdinals, missingOrdinals: verdict.missingOrdinals,
          conflicts: verdict.conflicts, eligible: writer && registered && !closed && verdict.eligible,
          reason: !writer ? 'POOL_INSPECTOR' : !registered ? 'POOL_NOT_REGISTERED' : closed ? 'POOL_CLOSED' : verdict.reason };
      } catch { observed = { unavailable: true, eligible: false, reason: 'POOL_UNAVAILABLE' }; }
      return Object.freeze({ kind, configured, observed: Object.freeze(observed) });
    },
    async close () {
      if (closed) return;
      closed = true;
      try {
        if (registered) await pool.query(`DELETE FROM ${table} WHERE pool_kind = $1 AND ordinal = $2 AND member_id = $3`, ownRow);
      } finally { await pool.end(); }
    }
  };
  return Object.freeze(member);
}

module.exports = { create, grants, catalogue };
