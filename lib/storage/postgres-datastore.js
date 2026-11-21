'use strict';
// Direct TCP backend observation; no URL/config label establishes identity.
const SQL="current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,inet_server_addr()::text AS server_address,inet_server_port() AS server_port,extract(epoch from pg_postmaster_start_time())::text AS postmaster_birth";
function identity(row){
  if(!row || typeof row.database!=='string' || !row.database || !/^[1-9][0-9]*$/.test(row.database_oid||'') ||
    typeof row.server_address!=='string' || !row.server_address || !Number.isSafeInteger(row.server_port) || row.server_port<1 || row.server_port>65535 ||
    typeof row.postmaster_birth!=='string' || !row.postmaster_birth)throw new Error('PostgreSQL direct datastore identity unavailable');
  return Object.freeze(Object.fromEntries(['database','database_oid','server_address','server_port','postmaster_birth'].map(key=>[key,row[key]])));
}
async function read(client){
  const row=(await client.query('SELECT pg_backend_pid() AS pid,'+SQL)).rows[0];
  if(!row || !Number.isSafeInteger(row.pid) || row.pid<1 || row.pid!==client.processID)throw new Error('PostgreSQL direct datastore backend required');
  return identity(row);
}
// Supplemental unselected recovery lineage, never an admission resource/epoch.
// This reads the backend's own fixed catalog function; it grants no privilege.
async function cluster(client){
  const rows=(await client.query('SELECT system_identifier::text AS cluster FROM pg_catalog.pg_control_system()')).rows;
  const value=rows?.length===1 ? rows[0]?.cluster : undefined;
  if(typeof value!=='string' || !/^-?[1-9][0-9]{0,18}$/.test(value) || BigInt(value)<-9223372036854775808n || BigInt(value)>9223372036854775807n)throw new Error('PostgreSQL cluster identity unavailable');
  return value;
}
module.exports={SQL,identity,read,cluster};
