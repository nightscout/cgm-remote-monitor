'use strict';
// One database-local cohort lock. PostgreSQL keeps two-int advisory keys in a
// separate keyspace from the bigint lifetime/owner resources. A hash collision
// couples unrelated cohorts conservatively; it never changes tenant selection.
const {createHash}=require('node:crypto');
const checkKind=kind=>{if(typeof kind!=='string'||!/^[a-z][a-z0-9]{0,31}$/.test(kind))throw new TypeError('Pool kind required');return kind;};
const DOMAIN='nightscout:pool-membership:xact:v1:';
function key(namespace,kind){
 if(typeof namespace!=='string'||!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||['public','information_schema'].includes(namespace)||namespace.startsWith('pg_'))throw new TypeError('POOL_TRANSACTION_NAMESPACE');
 checkKind(kind);const bytes=createHash('sha256').update(DOMAIN+namespace+':'+kind).digest();return Object.freeze([bytes.readInt32BE(0),bytes.readInt32BE(4)]);
}
async function lock(query,namespace,kind,shared=false){
 const keys=key(namespace,kind);
 const row=(await query('SELECT pg_advisory_xact_lock'+(shared?'_shared':'')+'($1::integer,$2::integer),pg_backend_pid() AS backend_pid,pg_current_xact_id()::text AS transaction_id',keys)).rows[0];
 if(!row||!Number.isSafeInteger(row.backend_pid)||row.backend_pid<1||typeof row.transaction_id!=='string'||!/^[0-9]+$/.test(row.transaction_id))throw new Error('POOL_TRANSACTION_IDENTITY');return row;
}
module.exports={DOMAIN,key,lock,checkKind};
