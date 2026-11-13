'use strict';

module.exports = async function lockTenantPolicy (connection, tenant) {
  // The shared key serializes owner writes with policy changes across processes.
  await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    ['nightscout:tenant-operator-policy:' + tenant]);
};
