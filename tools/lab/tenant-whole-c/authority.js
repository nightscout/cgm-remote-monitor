'use strict';

const lockPolicy = require('../../../lib/operator-policy/fence');
const NAME = /^[A-Za-z0-9_-]{1,128}$/;
// Fixture-only policy payload, stored through the real policy table and shared
// fence. This is not a production management/authentication adapter. The shipping
// policy store opens its own transaction, so its read() cannot retain this lock
// until the lifecycle transaction commits; use its exact fence on the supplied tx.
function currentAuthority ({ namespace, principal, consumer, plane }) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(namespace || '') || !NAME.test(principal || '') || !NAME.test(consumer || '') || !['owner', 'operator'].includes(plane)) throw new Error('WHOLE_C_AUTHORITY_INPUT');
  return async ({ connection, tenant, action }) => {
    await lockPolicy(connection, tenant);
    const result = await connection.query('SELECT generation, policy FROM "' + namespace + '".tenant_operator_policy WHERE tenant_id = $1', [tenant]);
    const row = result.rows[0];
    const actor = row?.policy?.wholeCFixtureActors?.find(candidate => candidate.principal === principal && candidate.consumer === consumer && candidate.plane === plane);
    if (!row || !Number.isInteger(row.generation) || row.generation < 1 || !actor || actor.active !== true || !Array.isArray(actor.actions) || !actor.actions.includes(action)) return null;
    return { allowed: true, current: true, tenant, principal, consumer, plane };
  };
}
module.exports = { currentAuthority };
