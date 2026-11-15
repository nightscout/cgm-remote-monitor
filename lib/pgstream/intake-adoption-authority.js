'use strict';
// Administrative cutover inventory only. A NOLOGIN capability is authority
// when an untrusted authenticated/configured principal can assume it, including
// NOINHERIT membership via SET ROLE. A builtin role name is never an exemption.
async function find(query,{table,principals}){
 const rows=(await query(`SELECT /* intake-adoption-retired-rights */ actor.rolname AS principal,capability.rolname AS capability,
 actor.rolcanlogin AS can_login,actor.rolsuper AS superuser,
 EXISTS(SELECT 1 FROM pg_stat_activity active_backend WHERE active_backend.usesysid=actor.oid AND active_backend.datid=(SELECT oid FROM pg_database WHERE datname=current_database())) AS authenticated,
 capability.oid=c.relowner AS owns,
 has_table_privilege(capability.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(capability.oid,c.oid,'INSERT,UPDATE,REFERENCES') AS writes
 FROM pg_roles actor JOIN pg_roles capability ON pg_has_role(actor.oid,capability.oid,'MEMBER') CROSS JOIN pg_class c WHERE c.oid=$1::regclass`,[table])).rows;
 const explicit=new Set(principals);
 if(rows.some(row=>['principal','capability'].some(key=>typeof row[key]!=='string'||!row[key]||Buffer.byteLength(row[key])>63)||['can_login','superuser','authenticated','owns','writes'].some(key=>typeof row[key]!=='boolean')))throw new Error('PGSTREAM_ADOPTION_AUTHORITY_INVENTORY');
 return rows.filter(row=>!row.superuser&&(row.can_login||row.authenticated||explicit.has(row.principal))&&(row.owns||row.writes));
}
module.exports={find};
