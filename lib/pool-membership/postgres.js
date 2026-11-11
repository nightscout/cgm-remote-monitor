'use strict';

// One member of one pool kind, backed by the tables of
// lib/pool-membership/postgres-candidate.json:
//   pool_membership  one heartbeat row per member, keyed by pool kind, ordinal
//                    and member incarnation, so two processes claiming one
//                    ordinal are two visible rows (a conflict), not one
//                    overwritten row. Lease times are the database clock's.
//   pool_desired     one row per pool kind: the operator-set member count, the
//                    count it replaced, the slice rule and a revision. Pods
//                    carry only their ordinal (lib/pool-membership/assess.js).
//
// Capabilities, each a separate database identity:
//   member     pool_membership: SELECT; INSERT; UPDATE (heartbeat_at,
//              lease_expires_at, applied_members) only; DELETE (its own row on
//              close, its ordinal's expired rows on register). pool_desired: SELECT.
//   inspector  SELECT on both (operational reads; never writes, never alerts)
//   operator   pool_membership: SELECT. pool_desired: SELECT; INSERT; UPDATE
//              (members, previous_members, slice_rule, revision, updated_at).
//              The only writer of the member count (lib/pool-membership/operator.js).
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { run } = require('../migrations/postgres');
const { RULE, predicate, MAX_MEMBERS } = require('./slice');
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
const DESIRED_UPDATES = Object.freeze(['members', 'previous_members', 'revision', 'slice_rule', 'updated_at']);

function grants ({ namespace, member, inspector, operator }) {
  const table = q(checkNamespace(namespace)) + '.pool_membership', desired = q(namespace) + '.pool_desired';
  const statements = [];
  for (const role of [member, inspector, operator].filter(Boolean)) {
    if (!NAME.test(role)) throw new TypeError('Explicit pool role required');
    statements.push('GRANT USAGE ON SCHEMA ' + q(namespace) + ' TO ' + q(role),
      'GRANT SELECT ON ' + q(namespace) + '.schema_migrations TO ' + q(role),
      'GRANT SELECT ON ' + table + ' TO ' + q(role), 'GRANT SELECT ON ' + desired + ' TO ' + q(role));
  }
  if (member) statements.push('GRANT INSERT, DELETE, UPDATE (applied_members, heartbeat_at, lease_expires_at) ON ' + table + ' TO ' + q(member));
  if (operator) statements.push('GRANT INSERT, UPDATE (' + DESIRED_UPDATES.join(', ') + ') ON ' + desired + ' TO ' + q(operator));
  return Object.freeze(statements);
}

// Per table: [inserts, deletes, updatable columns]. Anything else refuses at boot.
const EXPECTED = Object.freeze({
  member: { pool_membership: [true, true, ['applied_members', 'heartbeat_at', 'lease_expires_at']], pool_desired: [false, false, []] },
  inspector: { pool_membership: [false, false, []], pool_desired: [false, false, []] },
  operator: { pool_membership: [false, false, []], pool_desired: [true, false, [...DESIRED_UPDATES]] }
});

const SNAPSHOT = `SELECT
  (SELECT json_build_object('members', d.members, 'previousMembers', d.previous_members, 'rule', d.slice_rule, 'revision', d.revision::text)
     FROM DESIRED d WHERE d.pool_kind = $1) AS desired,
  (SELECT coalesce(json_agg(json_build_object('ordinal', m.ordinal, 'memberId', m.member_id::text, 'rule', m.slice_rule, 'appliedMembers', m.applied_members,
     'live', m.lease_expires_at > now(),
     'leaseRemainingMs', floor(extract(epoch FROM (m.lease_expires_at - now())) * 1000)::bigint,
     'heartbeatAgeMs', floor(extract(epoch FROM (now() - m.heartbeat_at)) * 1000)::bigint) ORDER BY m.ordinal, m.member_id), '[]'::json)
     FROM TABLE m WHERE m.pool_kind = $1) AS rows`;

// Open a pool on a checked identity: schema current, privileges exactly the capability's.
async function connect ({ kind, connectionString, namespace, capability, applicationName }) {
  checkKind(kind); checkNamespace(namespace);
  if (!Object.hasOwn(EXPECTED, capability)) throw new TypeError('Pool capability must be member, inspector or operator');
  await run('check', { direct: true, connectionString, namespace, catalogue, statementTimeoutMs: 5000 });
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
    application_name: applicationName || 'nightscout-pool-' + kind });
  try {
    for (const [name, [inserts, deletes, updates]] of Object.entries(EXPECTED[capability])) {
      const row = (await pool.query(`SELECT pg_has_role(current_user, c.relowner, 'MEMBER') AS owns,
          has_table_privilege(c.oid, 'SELECT') AS reads, has_table_privilege(c.oid, 'INSERT') AS inserts,
          has_table_privilege(c.oid, 'DELETE') AS deletes, has_table_privilege(c.oid, 'TRUNCATE,TRIGGER,REFERENCES') AS destroys,
          ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege(c.oid, a.attnum, 'UPDATE') ORDER BY a.attname) AS updates
        FROM pg_class c WHERE c.oid = to_regclass($1)`, [q(namespace) + '.' + name])).rows[0];
      if (!row || row.owns || row.destroys || !row.reads || row.inserts !== inserts || row.deletes !== deletes ||
          JSON.stringify(row.updates) !== JSON.stringify(updates)) throw refuse('POOL_STORE_UNSAFE');
    }
  } catch (error) {
    await pool.end();
    throw error.code === 'POOL_STORE_UNSAFE' ? error : refuse('POOL_STORE_UNAVAILABLE');
  }
  const table = q(namespace) + '.pool_membership', desired = q(namespace) + '.pool_desired';
  async function snapshot (client = pool, which = kind) {
    const row = (await client.query(SNAPSHOT.replace('DESIRED', desired).replace('TABLE', table), [checkKind(which)])).rows[0];
    const d = row.desired;
    return { desired: d ? Object.freeze({ members: d.members, previousMembers: d.previousMembers, rule: d.rule, revision: Number(d.revision) }) : null,
      rows: row.rows.map(r => Object.freeze({ ...r, leaseRemainingMs: Number(r.leaseRemainingMs), heartbeatAgeMs: Number(r.heartbeatAgeMs) })) };
  }
  return { pool, table, desired, snapshot };
}

async function create ({ kind, ordinal, leaseMs, connectionString, namespace, capability = 'member',
  onAlert = event => console.error('Pool membership alert:', JSON.stringify(event)), applicationName } = {}) {
  checkKind(kind); checkNamespace(namespace);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_MEMBERS) throw new TypeError('Pool ordinal must be 0..' + (MAX_MEMBERS - 1));
  if (!['member', 'inspector'].includes(capability)) throw new TypeError('Pool capability must be member or inspector');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 600000) throw new TypeError('Pool lease must be 100..600000 ms');
  if (typeof onAlert !== 'function') throw new TypeError('Pool alert sink must be a function');
  // The reviewed schema must be current before any membership statement.
  const { pool, table, snapshot } = await connect({ kind, connectionString, namespace, capability, applicationName });

  const memberId = randomUUID();
  const self = Object.freeze({ memberId, ordinal, rule: RULE });
  const predicates = new Map();
  const none = Object.freeze(() => false);
  const sliceOf = members => {
    if (ordinal >= members) return none;
    if (!predicates.has(members)) predicates.set(members, predicate(members, ordinal));
    return predicates.get(members);
  };
  let registered = false, closed = false, alerted = null, applied = null;
  const ownRow = [kind, ordinal, memberId];
  // Configured: what this process was started with. The member count is not
  // configuration; it is observed from the desired row.
  const configured = Object.freeze({ mode: 'partitioned', ordinal, rule: RULE, leaseMs, memberId });

  async function observe () {
    const { desired, rows } = await snapshot();
    return { desired, rows: rows.map(row => Object.freeze({ ...row, self: row.memberId === memberId })) };
  }
  function signal (reason, detail) {
    if (reason === alerted) return;
    const previous = alerted; alerted = reason;
    try {
      if (reason) onAlert({ kind, ordinal, state: 'refused', reason, ...detail });
      else if (previous) onAlert({ kind, ordinal, state: 'recovered', previous });
    } catch { /* an alert sink never changes the verdict */ }
  }
  async function renew () {
    await pool.query(`INSERT INTO ${table} (pool_kind, ordinal, member_id, slice_rule, applied_members, registered_at, heartbeat_at, lease_expires_at)
      VALUES ($1, $2, $3, $4, $5, now(), now(), now() + $6 * interval '1 millisecond')
      ON CONFLICT (pool_kind, ordinal, member_id) DO UPDATE SET heartbeat_at = now(), lease_expires_at = EXCLUDED.lease_expires_at,
        applied_members = EXCLUDED.applied_members`,
    [...ownRow, RULE, applied, leaseMs]);
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
    // each change of reason; recovery is signalled once. The slice follows the
    // effective member count of this read, so it changes in-process when the
    // operator's count takes effect.
    async slice () {
      if (!writer) throw refuse('POOL_FORBIDDEN');
      if (closed || !registered) return Object.freeze({ eligible: false, reason: closed ? 'POOL_CLOSED' : 'POOL_NOT_REGISTERED', conflicts: [] });
      let verdict;
      try { const seen = await observe(); verdict = assess(self, seen.rows, seen.desired); } catch {
        signal('POOL_UNAVAILABLE', {});
        return Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] });
      }
      if (!verdict.eligible) {
        signal(verdict.reason, { conflicts: verdict.conflicts });
        return Object.freeze({ eligible: false, reason: verdict.reason, conflicts: verdict.conflicts });
      }
      signal(null);
      // Record the count this member now works, at once, so that peers stop
      // falling back to the previous count after this member has switched.
      if (verdict.members !== applied) {
        applied = verdict.members;
        try { await renew(); } catch { return Object.freeze({ eligible: false, reason: 'POOL_UNAVAILABLE', conflicts: [] }); }
      }
      return Object.freeze({ eligible: true, includes: sliceOf(verdict.members), members: verdict.members, ordinal, rule: RULE,
        desiredMembers: verdict.desiredMembers, revision: verdict.revision, switching: verdict.switching, outside: verdict.outside,
        missingOrdinals: verdict.missingOrdinals });
    },
    // Read-only: configured values beside observed membership. Never writes,
    // renews, alerts or changes eligibility.
    async inspect () {
      let observed;
      try {
        const seen = await observe();
        const verdict = assess(self, seen.rows, seen.desired);
        observed = { rows: seen.rows, desired: seen.desired, members: verdict.members, switching: verdict.switching, outside: verdict.outside,
          liveOrdinals: verdict.liveOrdinals, missingOrdinals: verdict.missingOrdinals,
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

module.exports = { create, connect, grants, catalogue, checkNamespace };
