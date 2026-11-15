'use strict';
const candidate=require('./assignment-candidate');
async function assertInstalled(query,{namespace,membershipNamespace,lifecycleNamespace,intakeProfile,requireIntakeExecute=false}){
 // Validation of the work namespace shares the same explicit namespace rules.
 require('../pool-membership/transaction-lock').key(namespace,'evaluator');
 const selected=candidate.build({membershipNamespace,lifecycleNamespace,intakeProfile});
 const expected=new Map([
  ['pgstream_assignment_protocol',{type:31,source:selected.assignmentBody,fn:'pgstream_assignment_required',columns:candidate.ASSIGNMENT_COLUMNS,deferred:false}],
  ['pgstream_effect_protocol',{type:19,source:selected.effectBody,fn:'pgstream_assigned_effect_required',columns:candidate.EFFECT_COLUMNS,deferred:false}],
  ['pgstream_effect_commit',{type:17,source:selected.effectBody,fn:'pgstream_assigned_effect_required',columns:[],deferred:true}]
 ]);
 const rows=(await query(`SELECT t.tgname AS name,t.tgtype AS type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,
   t.tgnargs AS arguments,t.tgqual IS NULL AS unconditional,p.prosrc AS source,p.proname AS function_name,p.prosecdef AS definer,
   p.proconfig AS config,p.pronargs AS function_arguments,p.prorettype='pg_catalog.trigger'::regtype AS trigger_result,l.lanname AS language,
   ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY u(attnum,position) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=u.attnum ORDER BY u.position) AS columns
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
   WHERE n.nspname=$1 AND f.nspname=$1 AND c.relname='tenant_consumer_checkpoint' AND t.tgname=ANY($2::text[]) AND NOT t.tgisinternal`,[namespace,[...expected.keys()]])).rows;
 if(rows.length!==3||new Set(rows.map(row=>row.name)).size!==3||rows.some(row=>{const want=expected.get(row.name);return !want||row.type!==want.type||row.enabled!=='A'||row.deferrable!==want.deferred||row.deferred!==want.deferred||row.arguments!==0||row.unconditional!==true||row.source!==want.source||row.function_name!==want.fn||row.function_arguments!==0||row.trigger_result!==true||row.definer!==false||row.language!=='plpgsql'||JSON.stringify(row.config)!==JSON.stringify(['search_path=pg_catalog'])||JSON.stringify(row.columns)!==JSON.stringify(want.columns);}))throw new Error('EVALUATOR_ASSIGNMENT_PROTOCOL_UNQUALIFIED');
 if(intakeProfile!==undefined){
  const functions=(await query(`SELECT /* intake-assert-function */ p.prosrc AS source,p.prosecdef AS definer,p.proconfig AS config,p.pronargs AS arguments,p.prorettype='pg_catalog.void'::regtype AS void_result,has_function_privilege(p.oid,'EXECUTE') AS executes,l.lanname AS language FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname='pgstream_intake_assert'`,[namespace])).rows;
  const f=functions[0];if(functions.length!==1||f.source!==selected.intakeAssertBody||f.definer!==false||f.arguments!==0||f.void_result!==true||requireIntakeExecute&&f.executes!==true||f.language!=='plpgsql'||JSON.stringify(f.config)!==JSON.stringify(['search_path=pg_catalog']))throw new Error('PGSTREAM_INTAKE_PROTOCOL_UNQUALIFIED');
 }
 const indexes=(await query(`SELECT c.relname AS name,i.indisvalid AS valid,i.indisready AS ready,i.indisunique AS unique,a.amname AS method,
   pg_get_expr(i.indpred,i.indrelid) AS predicate,
   ARRAY(SELECT v.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,position) JOIN pg_attribute v ON v.attrelid=i.indrelid AND v.attnum=k.attnum ORDER BY k.position) AS columns
   FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
   JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am a ON a.oid=c.relam
   WHERE n.nspname=$1 AND t.relname='tenant_consumer_checkpoint' AND c.relname=ANY($2::text[])`,[namespace,candidate.INDEXES.map(index=>index.name)])).rows;
 const normalize=value=>typeof value==='string'?value.replace(/[\s"()]/g,'').toLowerCase():null;
 if(indexes.length!==3||new Set(indexes.map(index=>index.name)).size!==3||indexes.some(index=>{const want=candidate.INDEXES.find(value=>value.name===index.name);return !want||index.valid!==true||index.ready!==true||index.unique!==false||index.method!=='btree'||JSON.stringify(index.columns)!==JSON.stringify(want.columns)||normalize(index.predicate)!==normalize(want.predicate);}))throw new Error('EVALUATOR_ASSIGNMENT_INDEX_UNQUALIFIED');
}
module.exports={assertInstalled};
