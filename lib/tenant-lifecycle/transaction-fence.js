'use strict';

// The bigint lock excludes data replacement for the entire tenant transaction.
// The two-int lock orders the final generation read and COMMIT with suspension.
// PostgreSQL keeps these two advisory-key spaces separate.
async function tryGenerationLock (client, key, exclusive) {
  const number = BigInt(key);
  const high = Number(BigInt.asIntN(32, number >> 32n));
  const low = Number(BigInt.asIntN(32, number));
  const sql = exclusive
    ? 'SELECT /* suspension-generation-lock */ pg_try_advisory_xact_lock($1::int,$2::int) AS held'
    : 'SELECT /* commit-generation-lock */ pg_try_advisory_xact_lock_shared($1::int,$2::int) AS held';
  const result = await client.query(sql, [high, low]);
  return result.rows[0]?.held === true;
}

module.exports = { tryGenerationLock };
