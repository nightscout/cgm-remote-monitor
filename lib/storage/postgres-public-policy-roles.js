'use strict';

// PostgreSQL oid[] inside jsonb metadata returns PUBLIC OID 0 as string "0";
// direct OID-array metadata may return numeric 0. Accept only that sole role.
module.exports=function publicPolicyRoles(roles) {
  return Array.isArray(roles)&&roles.length===1&&(Object.is(roles[0],0)||roles[0]==='0');
};
