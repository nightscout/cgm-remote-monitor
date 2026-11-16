'use strict';
const {DOMAINS}=require('./clinical-storage-size-sql');
function build({namespace,domain}){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||namespace.startsWith('pg_')||['public','information_schema'].includes(namespace)||!DOMAINS.includes(domain))throw new TypeError('STORAGE_EVENT_IDENTITY_BINDING');
 return ['ALTER TABLE "'+namespace+'"."'+domain+'" REPLICA IDENTITY FULL'];
}
async function assertReady(connection,{namespace,domain}){
 build({namespace,domain});
 const row=(await connection.query('SELECT relreplident FROM pg_class WHERE oid=to_regclass($1)',[namespace+'.'+domain])).rows[0];
 if(row?.relreplident!=='f')throw new Error('STORAGE_EVENT_FULL_IDENTITY_REQUIRED');
}
module.exports={build,assertReady};
