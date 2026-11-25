'use strict';
// Exact optional mutation protocol. No trigger or grant is installed at runtime.
const catalogue=require('../../migrations/candidates/postgres-pool-mutation-v1.json');
const statement=catalogue.migrations.find(m=>m.name==='0003_pool_mutation_protocol').up[0];
const tag='$pool_mutation$',start=statement.indexOf(tag),end=statement.lastIndexOf(tag);
if(start<0||end<=start||statement.split(tag).length!==3)throw new Error('POOL_MUTATION_PROTOCOL_DELIMITER');
const BODY=statement.slice(start+tag.length,end);
async function assertInstalled(query,namespace){
 require('./transaction-lock').key(namespace,'evaluator');
 const rows=(await query(`SELECT c.relname AS table_name,t.tgenabled AS enabled,t.tgtype AS type,t.tgnargs AS arguments,
   t.tgqual IS NULL AS unconditional,p.prosrc AS source,p.prosecdef AS definer,p.proconfig AS config,l.lanname AS language,
   p.proname AS function_name,p.pronargs AS function_arguments,p.prorettype='pg_catalog.trigger'::regtype AS trigger_result
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
   WHERE n.nspname=$1 AND f.nspname=$1 AND c.relname=ANY($2::text[]) AND t.tgname='pool_mutation_protocol' AND NOT t.tgisinternal`,[namespace,['pool_membership','pool_desired']])).rows;
 if(rows.length!==2||new Set(rows.map(row=>row.table_name)).size!==2||rows.some(row=>!['pool_membership','pool_desired'].includes(row.table_name)||row.enabled!=='A'||row.type!==31||row.arguments!==0||!row.unconditional||row.source!==BODY||row.definer!==false||JSON.stringify(row.config)!==JSON.stringify(['search_path=pg_catalog'])||row.language!=='plpgsql'||row.function_name!=='pool_mutation_lock_required'||row.function_arguments!==0||row.trigger_result!==true))throw new Error('POOL_MUTATION_PROTOCOL_UNQUALIFIED');
}
module.exports={assertInstalled,BODY};
