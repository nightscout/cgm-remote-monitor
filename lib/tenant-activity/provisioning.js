'use strict';

// Tenant provisioning writes the activity row in the SAME transaction as the
// tenant's lifecycle window row (decision activity-row-always-provisioned).
// `query` is the provisioning transaction's query function, already bound to
// the tenant (app.current_tenant_id) by the caller.
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const ACTOR = /^[a-zA-Z0-9_-]{1,128}$/;

async function provisionInTransaction (query, { namespace, tenant, principal, consumer }) {
  if (typeof query !== 'function' || !NAME.test(namespace || '') || typeof tenant !== 'string' ||
      !ACTOR.test(principal || '') || !ACTOR.test(consumer || '')) throw new TypeError('Explicit activity provisioning required');
  const q = table => '"' + namespace + '"."' + table + '"';
  await query('INSERT INTO ' + q('tenant_activity') + ' (tenant_id,version,paused,suspended) VALUES ($1,1,false,false)', [tenant]);
  await query('INSERT INTO ' + q('tenant_activity_audit') + " (tenant_id,version,verb,authority,principal,consumer,paused,suspended) VALUES ($1,1,'provision','operator',$2,$3,false,false)",
    [tenant, principal, consumer]);
}

module.exports = { provisionInTransaction };
