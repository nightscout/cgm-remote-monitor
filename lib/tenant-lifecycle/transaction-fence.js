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

// The same shared commit lock as one statement with validated integer
// literals, for a simple-protocol query that carries several statements
// (the merged commit fence). The key is a decimal bigint string.
function sharedGenerationLockStatement (key) {
  if (typeof key !== 'string' || !/^-?[0-9]{1,19}$/.test(key)) throw new TypeError('Generation lock requires a bigint key');
  const number = BigInt(key);
  const high = Number(BigInt.asIntN(32, number >> 32n));
  const low = Number(BigInt.asIntN(32, number));
  return 'SELECT /* commit-generation-lock */ pg_try_advisory_xact_lock_shared(' + high + '::int,' + low + '::int) AS held';
}

module.exports = { tryGenerationLock, sharedGenerationLockStatement };
