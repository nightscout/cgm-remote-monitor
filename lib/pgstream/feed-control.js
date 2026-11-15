'use strict';
// One ordinal-zero control principal. It cannot persist tenant receipts or effects.
const profiles=require('./intake-profile');
const q=name=>{if(!profiles.name(name))throw new TypeError('PGSTREAM_FEED_CONTROL_BINDING');return '"'+name+'"';};
function plan({profile,clockNamespace,role}){
 const p=profiles.validate(profile);q(clockNamespace);q(role);
 if(p.binding.role===role||[p.binding.namespace,p.binding.membershipNamespace,p.binding.lifecycleNamespace,'pgstream'].includes(clockNamespace))throw new TypeError('PGSTREAM_FEED_CONTROL_BINDING');
 const reads=[clockNamespace+'.nightscout_heartbeat','pgstream.webhook_subscriptions',...Object.keys(profiles.CONTROL_READS).map(table=>p.binding.lifecycleNamespace+'.'+table)];
 return {profile:p,clockNamespace,role,reads};
}
function grants(options){const p=plan(options),role=q(p.role),control=q(p.profile.binding.lifecycleNamespace);return Object.freeze([
 ...[p.clockNamespace,'pgstream',p.profile.binding.lifecycleNamespace].map(ns=>'GRANT USAGE ON SCHEMA '+q(ns)+' TO '+role),
 'GRANT SELECT,UPDATE(revision) ON '+q(p.clockNamespace)+'.nightscout_heartbeat TO '+role,
 'GRANT SELECT ON pgstream.webhook_subscriptions TO '+role,
 ...Object.keys(profiles.CONTROL_READS).map(table=>'GRANT SELECT ON '+control+'.'+table+' TO '+role),
]);}
async function assertReady(connection,options){
 const p=plan(options),read=connection.readOnly.bind(connection);
 const roles=(await read(`SELECT /* feed-control-role */ current_user AS principal,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolinherit,
 EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(r.oid,other.oid,'MEMBER')) AS memberships,
 EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND has_schema_privilege(n.oid,'CREATE')) AS creates
 FROM pg_roles r WHERE rolname=current_user`)).rows;
 if(roles.length!==1||roles[0].principal!==p.role||['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolinherit','memberships','creates'].some(k=>roles[0][k]!==false))throw new Error('PGSTREAM_FEED_CONTROL_ROLE_REFUSED');
 const tables=(await read(`SELECT /* feed-control-grants */ n.nspname||'.'||c.relname AS relation,c.relkind AS kind,c.relpersistence AS persistence,
 pg_has_role(current_user,c.relowner,'MEMBER') AS owns,has_table_privilege(c.oid,'SELECT') AS reads,
 has_table_privilege(c.oid,'INSERT,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'INSERT,REFERENCES') AS forbidden,
 ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(c.oid,a.attname,'UPDATE') ORDER BY a.attname) AS updates
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
 AND (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') OR has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`)).rows;
 if(tables.length!==p.reads.length||new Set(tables.map(row=>row.relation)).size!==tables.length||tables.some(row=>!p.reads.includes(row.relation)||row.kind!=='r'||row.persistence!=='p'||row.owns!==false||row.reads!==true||row.forbidden!==false||JSON.stringify(row.updates)!==JSON.stringify(row.relation===p.clockNamespace+'.nightscout_heartbeat'?['revision']:[])))throw new Error('PGSTREAM_FEED_CONTROL_GRANTS_REFUSED');
 await require('./heartbeat-inventory').assert({query:read},{contract:'pgstream-heartbeat-v1',namespace:p.clockNamespace,table:'nightscout_heartbeat'},p.clockNamespace,(code)=>new Error('PGSTREAM_FEED_CONTROL_'+code));
 return Object.freeze({principal:p.role,intakeProfileDigest:p.profile.digest});
}
module.exports={grants,assertReady};
