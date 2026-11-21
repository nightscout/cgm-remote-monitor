'use strict';

const defaults = require('../authorization/default-roles');
const { isDeepStrictEqual } = require('node:util');

// Private operator preparation only, inside its tenant-bound transaction.
// Startup/readiness never calls this writer; an existing custom default refuses.
module.exports = async function provisionDefaultRoles (connection, { namespace, tenant }) {
  if (!connection || typeof connection.query !== 'function' || typeof namespace !== 'string' ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(namespace) || ['public', 'information_schema'].includes(namespace) ||
      namespace.startsWith('pg_') || typeof tenant !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)) {
    throw new TypeError('Default roles require explicit operator tenant transaction');
  }
  const scope = await connection.query("SELECT current_setting('app.current_tenant_id',true) AS tenant");
  if (scope.rows[0]?.tenant !== tenant) throw new TypeError('Default role tenant transaction mismatch');
  const table = '"' + namespace + '".tenant_authorization_roles';
  for (const role of defaults) {
    await connection.query('INSERT INTO ' + table +
      ' (tenant_id,name,permissions) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,name) DO NOTHING',
    [tenant, role.name, [...role.permissions]]);
    const stored = (await connection.query('SELECT permissions FROM ' + table +
      ' WHERE tenant_id=$1 AND name=$2 FOR SHARE', [tenant, role.name])).rows[0];
    if (!stored || !isDeepStrictEqual(stored.permissions, [...role.permissions])) {
      throw Object.assign(new Error('SUBJECT_ADMIN_DEFAULT_ROLE_CONFLICT'), { code: 'SUBJECT_ADMIN_DEFAULT_ROLE_CONFLICT' });
    }
  }
};
