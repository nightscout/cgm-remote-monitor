'use strict';

// The tenant replacement lock (decision restore-fence-generation, census B-01).
// Every tenant effect takes the transaction-scoped shared form on the tenant's
// bigint lifecycle lock key before it reads the lifecycle generation; restore
// takes the exclusive form before it replaces data. COMMIT or ROLLBACK
// releases it. The call never waits: a held exclusive lock answers false.
// `label` keeps a site's SQL comment for diagnostics and recorded fixtures.
const LABEL = /^[a-z][a-z0-9-]{0,62}$/;

async function tryShared (query, key, { label } = {}) {
  if (typeof query !== 'function') throw new TypeError('Tenant lock requires a query function');
  if (typeof key !== 'string' || !/^-?[0-9]{1,19}$/.test(key) || BigInt(key) < -9223372036854775808n || BigInt(key) > 9223372036854775807n) {
    throw new TypeError('Tenant lock requires a bigint key');
  }
  if (label !== undefined && !LABEL.test(label)) throw new TypeError('Tenant lock label must be a plain identifier');
  const sql = 'SELECT ' + (label ? '/* ' + label + ' */ ' : '') + 'pg_try_advisory_xact_lock_shared($1::bigint) AS held';
  const rows = (await query(sql, [key])).rows;
  return rows?.length === 1 && rows[0].held === true;
}

module.exports = { tryShared };
