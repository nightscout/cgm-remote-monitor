'use strict';
const candidate=require('./partition-candidate');
async function assertInstalled(query,namespace,binding){
 candidate.quote(namespace);const selected=candidate.build(binding);
 const rows=(await query(`SELECT c.relname AS table_name,t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,
  t.tgnargs AS arguments,t.tgqual IS NULL AS unconditional,cardinality(t.tgattr::smallint[]) AS column_count,
  p.prosrc AS source,p.proname AS function_name,p.prosecdef AS definer,p.proconfig AS config,p.pronargs AS function_arguments,
  p.prorettype='pg_catalog.trigger'::regtype AS trigger_result,l.lanname AS language
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
  WHERE n.nspname=$1 AND f.nspname=$1 AND c.relname=ANY($2::text[]) AND t.tgname=ANY($3::text[]) AND NOT t.tgisinternal`,[namespace,candidate.TABLES,['notification_partition_effect','notification_partition_commit']])).rows;
 const seen=new Set();
 if(rows.length!==6||rows.some(row=>{const deferred=row.name==='notification_partition_commit',key=row.table_name+':'+row.name;if(seen.has(key))return true;seen.add(key);return !candidate.TABLES.includes(row.table_name)||!['notification_partition_effect','notification_partition_commit'].includes(row.name)||row.type!==(deferred?29:31)||row.enabled!=='A'||row.deferrable!==deferred||row.deferred!==deferred||row.arguments!==0||row.unconditional!==true||row.column_count!==0||row.source!==selected.body||row.function_name!=='pgstream_notification_partition'||row.function_arguments!==0||row.trigger_result!==true||row.definer!==false||row.language!=='plpgsql'||JSON.stringify(row.config)!==JSON.stringify(['search_path=pg_catalog']);}))throw new Error('NOTIFICATION_PARTITION_PROTOCOL_UNQUALIFIED');
}
module.exports={assertInstalled};
