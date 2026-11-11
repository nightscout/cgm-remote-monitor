'use strict';

// The operator's control of a pool kind's member count: the only writer of
// pool_desired. Pods carry only their ordinal; scaling is "set the count, add
// or remove pods", and members switch slices together once every ordinal of
// the new count is live (lib/pool-membership/assess.js). Composed on the admin
// role as the pool-operations service (lib/server/serve/admin-preview.js).
const { RULE, MAX_MEMBERS } = require('./slice');
const { assess, effective } = require('./assess');
const { connect } = require('./postgres');
const { checkKind } = require('./config');

const refuse = code => Object.assign(new Error(code), { code });

async function create ({ connectionString, namespace, kinds, applicationName = 'nightscout-pool-operator' }) {
  if (!Array.isArray(kinds) || !kinds.length || new Set(kinds).size !== kinds.length) throw new TypeError('Explicit pool kinds required');
  kinds.forEach(checkKind);
  const { pool, desired: desiredTable, snapshot } = await connect({ kind: kinds[0], connectionString, namespace, capability: 'operator', applicationName });
  const allowed = new Set(kinds);
  const admit = kind => { if (typeof kind !== 'string' || !allowed.has(kind)) throw refuse('POOL_KIND_UNKNOWN'); return kind; };
  function view (kind, seen) {
    const verdict = assess({ memberId: null, ordinal: MAX_MEMBERS, rule: RULE }, seen.rows, seen.desired);
    return { kind, desired: seen.desired ? { ...seen.desired } : null, effectiveMembers: verdict.members, switching: verdict.switching,
      liveOrdinals: verdict.liveOrdinals, missingOrdinals: verdict.missingOrdinals,
      conflicts: verdict.conflicts.filter(conflict => conflict.reason !== 'POOL_SELF_NOT_LIVE').map(conflict => ({ ...conflict })),
      members: seen.rows.map(row => ({ ordinal: row.ordinal, live: row.live, appliedMembers: row.appliedMembers ?? null, heartbeatAgeMs: row.heartbeatAgeMs, leaseRemainingMs: row.leaseRemainingMs })) };
  }
  return Object.freeze({
    kinds: Object.freeze(kinds.slice()),
    async get (kind) { return view(admit(kind), await snapshot(pool, kind)); },
    // Sets the desired count. The count it replaces is recorded as the count
    // currently in effect, so the members keep their slices until the new
    // count is complete. Setting the current count changes nothing.
    async setMembers (kind, members) {
      admit(kind);
      if (!Number.isSafeInteger(members) || members < 1 || members > MAX_MEMBERS) throw refuse('POOL_MEMBERS_INVALID');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query(`INSERT INTO ${desiredTable} (pool_kind, members, previous_members, slice_rule, revision, updated_at)
          VALUES ($1, $2, NULL, $3, 1, now()) ON CONFLICT (pool_kind) DO NOTHING RETURNING pool_kind`, [kind, members, RULE]);
        const current = (await client.query(`SELECT members FROM ${desiredTable} WHERE pool_kind = $1 FOR UPDATE`, [kind])).rows[0];
        let outcome = inserted.rowCount === 1 ? 'applied' : 'unchanged';
        if (current.members !== members) {
          const seen = await snapshot(client, kind);
          const inEffect = effective(seen.rows.filter(row => row.live), seen.desired).members;
          await client.query(`UPDATE ${desiredTable} SET members = $2, previous_members = $3, slice_rule = $4, revision = revision + 1, updated_at = now()
            WHERE pool_kind = $1`, [kind, members, inEffect, RULE]);
          outcome = 'applied';
        }
        const after = await snapshot(client, kind);
        await client.query('COMMIT');
        return { outcome, ...view(kind, after) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error.code === 'POOL_MEMBERS_INVALID' || error.code === 'POOL_KIND_UNKNOWN' ? error : refuse('POOL_UNAVAILABLE');
      } finally { client.release(); }
    },
    close: () => pool.end()
  });
}

module.exports = { create };
