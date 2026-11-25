'use strict';

// Existing REST context contract: tenant-only logical JSONB storage bytes.
// Shared physical heap/index pages are never attributed to an individual tenant.
const scope = require('./tenant-scope');
const MAX_AGE_MS = 300000;
const qualified = table => {
  const parts = typeof table === 'string' ? table.split('.') : [];
  if (parts.length !== 2 || parts.some(part => !/^[a-z][a-z0-9_]{0,62}$/.test(part)) ||
      ['public', 'information_schema'].includes(parts[0]) || parts[0].startsWith('pg_')) throw new TypeError('Explicit statistics schema.table required');
  return parts.map(part => '"' + part + '"').join('.');
};
// clock: the tenant write clock table. With it, one instance (one tenant's
// retained service) keeps its last answer while that tenant's clock stamp is
// unchanged, for at most MAX_AGE_MS: the aggregate reads every document the
// tenant holds, and a frame needs it only as a display figure. Writes that
// take no stamp (prune, hard delete, activity) show within that age.
module.exports = function tenantStats ({ connection, tables, clock, sealedDeviceStatus = false, now = Date.now }) {
  if (typeof connection?.query !== 'function' || !tables || typeof tables !== 'object' ||
      Array.isArray(tables) || !Object.keys(tables).length || typeof now !== 'function') throw new TypeError('Explicit tenant statistics tables required');
  const stampSql = clock === undefined ? null : 'SELECT last_stamp::text AS stamp FROM ' + qualified(clock) + ' WHERE tenant_id=$1';
  let kept = null;
  const sources = Object.values(tables).map(qualified);
  // One statement keeps the per-table aggregates in the same statement snapshot
  // and avoids a connection round trip for each domain. Preserve their configured
  // order so floating-point addition and duplicate table entries behave as before.
  const sql = 'SELECT bytes FROM (' + sources.map((table, index) =>
    'SELECT ' + index + ' AS source_index, COALESCE(sum(' + (sealedDeviceStatus && table.endsWith('."devicestatus"') ? 'logical_bytes' : 'pg_column_size(doc)') + '), 0)::float8 AS bytes FROM ' + table
  ).join(' UNION ALL ') + ') tenant_statistics ORDER BY source_index';
  return Object.freeze({ async read (tenant) {
    if (scope.requireTenant('tenant statistics') !== tenant) throw new Error('Tenant statistics scope mismatch');
    let stamp;
    if (stampSql) {
      stamp = (await connection.query(stampSql, [tenant])).rows[0]?.stamp;
      const at = now();
      if (typeof stamp === 'string' && kept && kept.tenant === tenant && kept.stamp === stamp && at >= kept.at && at - kept.at < MAX_AGE_MS) {
        return { dataSize: kept.dataSize, indexSize: undefined };
      }
    }
    const result = await connection.query(sql);
    if (!Array.isArray(result.rows) || result.rows.length !== sources.length) throw new Error('Tenant statistics unavailable');
    let dataSize = 0;
    for (const row of result.rows) {
      const bytes = row?.bytes;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('Tenant statistics unavailable');
      dataSize += bytes;
    }
    if (!Number.isFinite(dataSize)) throw new Error('Tenant statistics unavailable');
    // The stamp was read before the aggregate: a write between them leaves a
    // newer figure under the older stamp, never an older figure under a newer one.
    kept = typeof stamp === 'string' ? { tenant, stamp, dataSize, at: now() } : null;
    return { dataSize, indexSize: undefined };
  } });
};
