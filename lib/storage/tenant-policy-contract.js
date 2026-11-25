'use strict';

// Validate this restricted caller's tenant/write boundary. Other trusted worker
// logins may have ordinary SELECT-only visibility. This is not a global roster
// attestation: the deployment operator owns grants and worker role selection.
const publicRoles = require('./postgres-public-policy-roles');
function valid (policies, binding, expression) {
  if (!Array.isArray(policies)) return false;
  const canonical = policies.filter(p => p.command === '*' && p.permissive === true && publicRoles(p.roles) &&
    expression(p.using) === binding && expression(p.check) === binding);
  return canonical.length === 1 && policies.every(p => p === canonical[0] ||
    p.command === 'r' && p.permissive === true && Array.isArray(p.roles) && p.roles.length > 0 &&
    p.roles.every(role => /^(?:[1-9][0-9]*)$/.test(String(role))) && p.applies === false &&
    expression(p.using) === 'true' && p.check === null);
}
function applies (policy = 'p') {
  return `EXISTS(SELECT 1 FROM unnest(${policy}.polroles) role(oid) WHERE CASE WHEN role.oid=0 THEN true ELSE pg_has_role(current_user,role.oid,'MEMBER') END)`;
}
function binds (relation, binding) {
  const canonical = `p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[0::oid] AND pg_get_expr(p.polqual,p.polrelid)=${binding} AND pg_get_expr(p.polwithcheck,p.polrelid)=${binding}`;
  const additional = `p.polcmd='r' AND p.polpermissive AND cardinality(p.polroles)>0 AND NOT (0::oid=ANY(p.polroles)) AND pg_get_expr(p.polqual,p.polrelid)='true' AND p.polwithcheck IS NULL AND NOT ${applies()}`;
  return `(SELECT count(*) FILTER(WHERE ${canonical})=1 AND bool_and(COALESCE((${canonical}) OR (${additional}),false)) FROM pg_policy p WHERE p.polrelid=${relation})`;
}
module.exports = { valid, applies, binds };
