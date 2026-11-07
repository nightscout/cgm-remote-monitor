'use strict';

// Existing REST context contract: tenant-only logical JSONB storage bytes.
// Shared physical heap/index pages are never attributed to an individual tenant.
const scope = require('./tenant-scope');
module.exports = function tenantStats ({ connection, tables }) {
  if (typeof connection?.query !== 'function' || !tables || typeof tables !== 'object' ||
      Array.isArray(tables) || !Object.keys(tables).length) throw new TypeError('Explicit tenant statistics tables required');
  const sources = Object.values(tables).map(table => {
    const parts = typeof table === 'string' ? table.split('.') : [];
    if (parts.length !== 2 || parts.some(part => !/^[a-z][a-z0-9_]{0,62}$/.test(part)) ||
        ['public', 'information_schema'].includes(parts[0]) || parts[0].startsWith('pg_')) throw new TypeError('Explicit statistics schema.table required');
    return parts.map(part => '"' + part + '"').join('.');
  });
  return Object.freeze({ async read (tenant) {
    if (scope.requireTenant('tenant statistics') !== tenant) throw new Error('Tenant statistics scope mismatch');
    let dataSize = 0;
    for (const table of sources) {
      const result = await connection.query('SELECT COALESCE(sum(pg_column_size(doc)), 0)::float8 AS bytes FROM ' + table);
      const bytes = result.rows[0]?.bytes;
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('Tenant statistics unavailable');
      dataSize += bytes;
    }
    if (!Number.isFinite(dataSize)) throw new Error('Tenant statistics unavailable');
    return { dataSize, indexSize: undefined };
  } });
};
