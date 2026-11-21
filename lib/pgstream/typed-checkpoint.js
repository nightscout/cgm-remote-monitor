'use strict';
const scope=require('../storage/tenant-scope');
const work=require('./work-state');
const {createHash}=require('node:crypto');
const {canonical}=require('../server/serve/evaluator-runtime');
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const KIND='evaluator-work-v2';
const contentOf=output=>hash({identity:output.identity,properties:output.result.properties,emitted:output.result.emitted,requested:output.result.requested,rows:output.rows,frame:{...output.frame,lastUpdated:0}});
const summaryOf=output=>{const body=bodyOf(output);delete body.rows;delete body.frame;return body;};
const bodyOf=output=>{const body={...output};for(const key of ['identity','contentDigest','outputRevision','restoreGeneration','runtimeId'])delete body[key];return body;};
function create({connection,namespace,consumer,maxBytes,timeIntervalMs,now=Date.now,onCommit,assignment,notificationRecovery=false,generationFence}){
 // Without an operation window (the production fence), completion itself
 // checks the tenant's lifecycle generation on the restore-fence read path: the
 // shared advisory lock on the tenant's lock key (a restore holds it
 // exclusively), then the generation in a later statement, so its snapshot
 // follows the lock. SELECT on the lifecycle table is the only privilege used.
 if(generationFence!==undefined&&!/^"[a-z][a-z0-9_]{0,62}"\.tenant_lifecycle_windows$/.test(generationFence?.table))throw new TypeError('Explicit lifecycle generation fence required');
 const fenceColumn=generationFence?',(SELECT l.generation::text FROM '+generationFence.table+' l WHERE l.tenant_id=$1) AS lifecycle_generation':'';
 const fenceLock=generationFence&&(async tenant=>{const held=(await connection.query('SELECT /* completion-generation-lock */ pg_try_advisory_xact_lock_shared(l.lock_key) AS held FROM '+generationFence.table+' l WHERE l.tenant_id=$1',[tenant])).rows[0]?.held;if(held!==true)throw Object.assign(new Error('EVALUATOR_COMPLETION_RESTORE_REFUSED'),{code:'EVALUATOR_COMPLETION_RESTORE_REFUSED'});});
 if(onCommit!==undefined&&typeof onCommit!=='function')throw new TypeError('Evaluator committed-activity callback required');
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(namespace)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Explicit typed evaluator checkpoint required');
 // One topology (decision legacy-topology-retirement): every tenant, or a
 // configured assigned-worker slice. No partition or pool intake profile.
 const selected=assignment===undefined?null:require('./assigned-worker').configure(assignment,{namespace,consumer});
 // notification: with durable notification recovery, whether this commit owes
 // notification work (the marker it sets); undefined where nothing records it.
 const notify=(tenant,kind,notification)=>{try{Promise.resolve(onCommit?.({tenant,kind,...(notification===undefined?{}:{notification})})).catch(()=>{});}catch{ /* A lost hint is recovered from the committed outbox. */ }};
 const native=connection.nativeLifecycle && require('../tenant-lifecycle/native-selection').validate(connection.nativeLifecycle);
 if(native&&(native.binding.namespace!==namespace||native.binding.consumer!==consumer))throw new Error('PGSTREAM_NATIVE_RECEIPT_BINDING');
 const outputConsumer=consumer+'-completed',table='"'+namespace+'".tenant_consumer_checkpoint',digest=native?.contractDigest||hash([KIND,namespace,consumer]);let owner,fence;
 const check=row=>{if(!row||row.contract_digest!==digest||row.work_version!==2)throw new Error('EVALUATOR_OUTPUT_CONTRACT');return selected?selected.check(row):row;};
 const assignmentColumns=selected?.select||'';
 const select=work.select+assignmentColumns;
 const beginColumns='work_version,work_observed'+assignmentColumns;
 const completeColumns=work.columns(['work_version','work_observed','work_completed','work_observed_at','work_pending_at','output_identity','output_digest','output_revision','output_restore_generation'])+assignmentColumns;
 const notifyPending='work_version=2 AND work_enabled AND notification_work_pending';
 const matchingOutput="output_digest=$3 AND output_restore_generation IS NOT DISTINCT FROM $4::bigint";
 const completedSummary=",CASE WHEN "+matchingOutput+" AND $5::boolean THEN (projection->0->'output')-'rows'-'frame' END AS output_summary"+
  ",CASE WHEN "+matchingOutput+" AND $5::boolean THEN projection->0->'output'->'frame'->'lastUpdated' END AS frame_at"+
  ",CASE WHEN "+matchingOutput+" AND NOT $5::boolean THEN projection->0->'output' END AS previous_output"+
  (notificationRecovery ? ",CASE WHEN NOT ("+matchingOutput+") THEN jsonb_path_exists(projection,'$[0].output.result.requested[*]') END AS had_notifications" : '');

 const bound=values=>selected?selected.filter(values):{sql:'',values};
 const envelope=(row,body)=>body?{...body,identity:row.output_identity,contentDigest:row.output_digest,outputRevision:Number(row.output_revision),restoreGeneration:row.output_restore_generation===null?null:work.version(row.output_restore_generation)}:null;
 const retained=(row,value)=>{try{return value&&value.tenant===row.tenant&&value.identity===row.output_identity&&value.contentDigest===row.output_digest&&String(value.outputRevision)===row.output_revision&&(value.restoreGeneration===null?null:String(value.restoreGeneration))===row.output_restore_generation&&value.frame?.lastUpdated===row.frame_at&&canonical(summaryOf(value))===canonical(row.output_summary)&&contentOf(value)===row.output_digest;}catch{return false;}};
 const compact=",CASE WHEN jsonb_typeof(projection->0->'output')='object' THEN (projection->0->'output')-'rows'-'frame' ELSE NULL END AS output_summary,projection->0->'output'->'frame'->'lastUpdated' AS frame_at";
 const deliveryHints=new WeakMap();
 const deliveryCompact=",CASE WHEN jsonb_typeof(projection->0->'output')='object' THEN (projection->0->'output')-'rows'-'frame'-'result' ELSE NULL END AS output_summary,projection->0->'output'->'frame'->'lastUpdated' AS frame_at";
 const deliveryRetained=(row,value)=>{try{return value&&deliveryHints.has(value)&&value.tenant===row.tenant&&value.identity===row.output_identity&&value.contentDigest===row.output_digest&&String(value.outputRevision)===row.output_revision&&(value.restoreGeneration===null?null:String(value.restoreGeneration))===row.output_restore_generation&&value.frame?.lastUpdated===row.frame_at&&canonical(summaryOf(value))===canonical(row.output_summary)&&deliveryHints.get(value)===hash(value.frame);}catch{return false;}};
 // Hot trusted work-state reads are fixed SELECTs: one statement each where the
 // connection offers it (postgres-connection readStatement).
 const read1=(text,values)=>typeof connection.readStatement==='function'?connection.readStatement(text,values):connection.readOnly(text,values);
 const read=async tenant=>check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+select+compact+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]);
 async function physical(tenant,row){const body=(await connection.query("SELECT projection->0->'output' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]?.output;return envelope(row,body);}
 return Object.freeze({consumer:outputConsumer,digest,...(native?{nativeLifecycle:native}:{}),assignment:selected?.fixed?Object.freeze({identity:selected.identity,...(selected.static?{slice:selected.slice}:{}),get tenants(){return selected.tenants;}}):null,
 async admit(tenants){const roster=[...tenants];if(selected?.fixed){roster.forEach(selected.tenant);return connection.admitEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,digest,tenants:roster});}if(selected){if(new Set(roster).size!==roster.length)throw new Error('EVALUATOR_PARTITION_ADMISSION_ROSTER');for(const tenant of roster)selected?.tenant(tenant);for(let offset=0;offset<roster.length;offset+=64){const page=roster.slice(offset,offset+64),rows=(await connection.readOnly('SELECT tenant_id::text AS tenant,contract_digest,work_version'+(selected?.select||'')+' FROM '+table+' WHERE consumer=$1 AND tenant_id=ANY($2::uuid[])',[outputConsumer,page])).rows;if(rows.length!==page.length||new Set(rows.map(row=>row.tenant)).size!==page.length||rows.some(row=>!page.includes(row.tenant)))throw new Error('EVALUATOR_OUTPUT_NOT_PROVISIONED');rows.forEach(check);}return;}return connection.admitEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,digest,tenants:roster});},
 async own(onLoss){if(selected&&owner)throw new Error('EVALUATOR_OWNER_ALREADY_OPEN');const globalKey=BigInt.asIntN(64,BigInt('0x'+hash(['pgstream-evaluator-owner-v1',namespace,consumer]).slice(0,16))).toString();owner=await connection.holdAdvisoryLock(selected?selected.key:globalKey,onLoss,selected?.fixed?{sharedKey:globalKey}:undefined);if(selected)try{fence=await selected.open(connection,owner);}catch(error){await owner.close();owner=null;throw error;}},
 async observe(tenant,source,version,enabled){if(selected&&!selected.fixed)throw new Error('EVALUATOR_WORKER_OBSERVATION_REFUSED');selected?.tenant(tenant);const receipt=(await connection.observeEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,observations:[{tenant,observed:{[source]:work.version(version)},...(enabled===undefined?{}:{eligibility:{[source]:enabled}})}]}))[0];if(receipt.deliveryPending)notify(tenant,'observe');return receipt;},
 async observeMany(observations){if(selected&&!selected.fixed)throw new Error('EVALUATOR_WORKER_OBSERVATION_REFUSED');if(selected)observations.forEach(row=>selected.tenant(row.tenant));const receipts=await connection.observeEvaluatorTyped({table:namespace+'.tenant_consumer_checkpoint',consumer:outputConsumer,contractDigest:digest,observations});receipts.forEach((receipt,index)=>{if(receipt.deliveryPending)notify(observations[index].tenant,'observe');});return receipts;},
 // Trusted worker metadata: the observed versions this cycle may cover. No
 // tenant serving lease and no output detoast; complete() fences the result
 // under the owner/tenant window and refuses versions the row does not hold.
 async begin(tenant){selected?.tenant(tenant);const assignment=bound([tenant,outputConsumer]);return work.map(check((await read1('SELECT tenant_id::text AS tenant,contract_digest,'+beginColumns+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2'+assignment.sql,assignment.values)).rows[0]).work_observed);},
 async complete(tenant,{observed,identity,result,restoreGeneration=null,retainedOutput}){
 if(!owner?.available)throw new Error('EVALUATOR_OWNER_UNAVAILABLE');const withOwner=selected?owner.withTenantTransaction.bind(owner):owner.withTenant.bind(owner);const committed=await withOwner(tenant,async()=>{
 const context=selected?await fence.start(tenant,restoreGeneration):null;
 const content=hash({identity,properties:result.properties,emitted:result.emitted,requested:result.requested,rows:result.encodedRows??result.rows,frame:{...result.frame,lastUpdated:0}});
 const restore=restoreGeneration===null?null:work.version(restoreGeneration);
 if(fenceLock)await fenceLock(tenant);
 const row=check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+completeColumns+completedSummary+fenceColumn+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,outputConsumer,content,restore,!!retainedOutput])).rows[0]);
 if(generationFence&&(restore===null||row.lifecycle_generation!==restore))throw Object.assign(new Error('EVALUATOR_COMPLETION_RESTORE_REFUSED'),{code:'EVALUATOR_COMPLETION_RESTORE_REFUSED'});
 const state=work.state(row);
 if(selected&&Object.keys(state.completed).some(key=>observed[key]===undefined))throw new Error('EVALUATOR_COMPLETION_VERSION_REFUSED');
 for(const [key,value]of Object.entries(observed)){const exact=work.version(value);if(state.observed[key]===undefined||BigInt(exact)>BigInt(state.observed[key])||state.completed[key]!==undefined&&BigInt(exact)<BigInt(state.completed[key]))throw new Error('EVALUATOR_COMPLETION_VERSION_REFUSED');}
 const changed=row.output_digest!==content,replace=changed||row.output_restore_generation!==restore;
 const revision=changed?Number(row.output_revision)+1:Number(row.output_revision);if(!Number.isSafeInteger(revision))throw new Error('EVALUATOR_OUTPUT_REVISION_EXHAUSTED');
 let output;if(replace){const saved={...result};delete saved.encodedRows;delete saved.frame;output={tenant,identity,restoreGeneration:restore,outputRevision:revision,contentDigest:content,inputCheckpoint:result.checkpoint,checkpoint:result.checkpoint,trigger:result.trigger,result:saved,rows:result.encodedRows??result.rows,frame:result.frame};}else{
  output=retainedOutput?(retained(row,retainedOutput)?retainedOutput:await physical(tenant,row)):envelope(row,row.previous_output);
  if(!output)throw new Error('EVALUATOR_OUTPUT_CONTRACT');
 }
 const at=selected?now():null,next=Math.min(result.due?.dueAt??Infinity,result.due?.slow?.length?(at??now())+timeIntervalMs:Infinity),remaining=Object.entries(state.observed).filter(([key,value])=>observed[key]===undefined||BigInt(value)>BigInt(observed[key])),pendingAt=remaining.length?Math.min(...remaining.map(([key])=>Number(state.observedAt[key]??state.pendingAt??(at??now())))):null;
 const projection=replace?JSON.stringify([{kind:KIND,output:bodyOf(output)}]):null;if(projection&&Buffer.byteLength(projection)>maxBytes)throw new Error('EVALUATOR_OUTPUT_BYTE_BOUND');
 const assignment=bound([tenant,outputConsumer,result.checkpoint,work.array(observed),work.instant(next),pendingAt,at??now(),identity,content,revision,restore,replace?1:0,...(replace?[projection]:[])]);
 // The notification producer independently acknowledges this exact completed
 // output after its outbox transaction commits. A quiet result keeps any
 // outstanding marker, so it can reconcile a previously unprocessed alarm.
 const markNotification = notificationRecovery && replace && (result.requested?.length > 0 || row.had_notifications);
 const updated=await connection.query('UPDATE '+table+' SET checkpoint=$3,work_completed=$4,work_due_at=$5,work_pending_at=$6,work_completed_at=$7,output_identity=$8,output_digest=$9,output_revision=$10,output_restore_generation=$11,delivery_revision=delivery_revision+$12'+(replace?',projection=$13::jsonb':'')+(markNotification?',notification_work_pending=true':'')+' WHERE tenant_id=$1 AND consumer=$2 AND work_version=2'+assignment.sql,assignment.values);
 if(selected){if(updated.rowCount!==1)throw new Error('EVALUATOR_PARTITION_EFFECT_REFUSED');await fence.finish(context);}
 return {output,changed,pendingAt,deliveryPending:replace,...(notificationRecovery?{notificationPending:!!markNotification}:{})};});if(committed.deliveryPending)notify(tenant,'complete',committed.notificationPending);return committed;},
 async output(tenant,identity,{retained:hint,delivery=false,notification}={}){
   if(delivery)return scope.withTenant(tenant,()=>connection.readOnlyTransaction(async()=>{
     // Metadata and a cold physical frame share one repeatable snapshot. A
     // concurrent evaluator completion cannot mix two output revisions.
     const row=check((await connection.query("SELECT current_setting('transaction_isolation') AS output_read_isolation,tenant_id::text AS tenant,contract_digest,"+select+deliveryCompact+' FROM '+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]);
     // The shared read port joins an ambient write. Refuse a weaker outer
     // isolation level before fetching or reusing a separately stored frame.
     if(!['repeatable read','serializable'].includes(row.output_read_isolation))throw new Error('EVALUATOR_OUTPUT_REPEATABLE_READ_REQUIRED');
     const state=work.state(row);
     if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');
     if(row.output_identity!==identity||row.output_revision==='0')throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');
     if(deliveryRetained(row,hint))return hint;
     const body=(await connection.query("SELECT (projection->0->'output')-'result'-'rows' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]?.output;
     const value=envelope(row,body);if(value)deliveryHints.set(value,hash(value.frame));
     return value;
   }));
   if(notification)return scope.withTenant(tenant,async()=>{
     const row=check((await connection.query("SELECT tenant_id::text AS tenant,contract_digest,"+select+
       ",projection->0->'output' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]);
     const state=work.state(row);
     if(!state.enabled||row.output_identity!==identity||row.output_revision==='0'||
         row.output_restore_generation!==work.version(notification.generation)||
         state.pendingAt!==null&&state.pendingAt+notification.pendingMs<=now()||
         state.nextDueAt!==null&&state.nextDueAt<=now()||
         ['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))return null;
     return envelope(row,row.output);
   });
   // A cold read without a retained hint (the runtime's loadOutput) is one
   // statement: metadata and output from one snapshot, so the envelope never
   // labels one revision's body with another's version fields.
   return scope.withTenant(tenant,async()=>{const row=hint?await read(tenant):check((await connection.query('SELECT tenant_id::text AS tenant,contract_digest,'+select+",projection->0->'output' AS output FROM "+table+' WHERE tenant_id=$1 AND consumer=$2',[tenant,outputConsumer])).rows[0]),state=work.state(row);if(!state.enabled||['activity','policy','lifecycle'].some(key=>state.observed[key]!==undefined&&state.completed[key]!==state.observed[key]))throw new Error('EVALUATOR_OUTPUT_CONTROL_PENDING');if(row.output_identity!==identity||row.output_revision==='0')throw new Error('EVALUATOR_OUTPUT_CONFIG_CHANGED');if(!hint)return envelope(row,row.output);return retained(row,hint)?hint:physical(tenant,row);});
 },
 ...(notificationRecovery ? {
   async notificationPending(exclude) {
     const assignment=bound([outputConsumer,exclude]);
     return (await read1('SELECT /* evaluator-notification-pending */ tenant_id::text AS tenant FROM '+table+
       ' WHERE consumer=$1 AND '+notifyPending+' AND NOT (tenant_id=ANY($2::uuid[]))'+assignment.sql+
       ' ORDER BY tenant_id LIMIT 64',assignment.values)).rows;
   },
   acknowledgeNotification(tenant, output) {
     selected?.tenant(tenant);
     const assignment=bound([tenant,outputConsumer,output.outputRevision,output.restoreGeneration,output.contentDigest]);
     return scope.withTenant(tenant,()=>connection.query('UPDATE '+table+
       ' SET notification_work_pending=false WHERE tenant_id=$1 AND consumer=$2 AND '+notifyPending+
       ' AND output_revision=$3 AND output_restore_generation IS NOT DISTINCT FROM $4::bigint AND output_digest=$5'+
       assignment.sql,assignment.values));
   }
 } : {}),
 async work(limit=64,{after=null,exclude=[]}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new TypeError('Bounded pending work required');const assignment=bound([outputConsumer,now(),limit,after,exclude]);const rows=(await read1('SELECT tenant_id::text AS tenant,'+select+' FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled'+assignment.sql+' AND (work_pending_at IS NOT NULL OR work_due_at<=$2) AND ($4::uuid IS NULL OR tenant_id>$4::uuid) AND NOT (tenant_id=ANY($5::uuid[])) ORDER BY tenant_id LIMIT $3',assignment.values)).rows;return rows.map(row=>{if(selected)selected.check(row);return {tenant:row.tenant,...work.state(row)};});},
 // Spike S1 sweep: pending rows only, through the partial pending index.
 async pending(limit=64,{after=null}={}){if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw new TypeError('Bounded pending work required');const assignment=bound([outputConsumer,limit,after]);const rows=(await read1('SELECT /* evaluator-pending-sweep */ tenant_id::text AS tenant,'+select+' FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled AND work_pending_at IS NOT NULL'+assignment.sql+' AND ($3::uuid IS NULL OR tenant_id>$3::uuid) ORDER BY tenant_id LIMIT $2',assignment.values)).rows;return rows.map(row=>{if(selected)selected.check(row);return {tenant:row.tenant,...work.state(row)};});},
 async nextDue({exclude=[]}={}){const assignment=bound([outputConsumer,exclude]);const row=(await read1('SELECT min(work_due_at)::text AS due FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled'+assignment.sql+' AND work_due_at IS NOT NULL AND NOT (tenant_id=ANY($2::uuid[]))',assignment.values)).rows[0];return row?.due===null||row?.due===undefined?null:Number(row.due);},
 // Bounded durable pending witness for explicitly selected tenants (operator
 // diagnostics). One read-only statement; no clinical frame or input.
 async witness(tenants){if(!Array.isArray(tenants)||!tenants.length||tenants.length>128||new Set(tenants).size!==tenants.length||tenants.some(tenant=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant)))throw new TypeError('Bounded pending witness selector required');const assignment=bound([outputConsumer,tenants]);const rows=(await read1('SELECT tenant_id::text AS tenant,'+select+' FROM '+table+' WHERE consumer=$1 AND work_version=2 AND tenant_id=ANY($2::uuid[])'+assignment.sql,assignment.values)).rows;const byTenant=new Map(rows.map(row=>[row.tenant,row]));return tenants.map(tenant=>{const row=byTenant.get(tenant);if(!row)return {tenant,durable:null};const state=work.state(row);return {tenant,durable:{pendingAt:state.pendingAt,nextDueAt:state.nextDueAt,observed:state.observed,completed:state.completed,observedAt:state.observedAt,outputRevision:row.output_revision}};});},
 async health(){const assignment=bound([outputConsumer]);const row=(await read1('SELECT min(work_pending_at)::text AS oldest FROM '+table+' WHERE consumer=$1 AND work_version=2 AND work_enabled'+assignment.sql+' AND work_pending_at IS NOT NULL',assignment.values)).rows[0];return {pending:row?.oldest!==null&&row?.oldest!==undefined,oldestPendingAt:row?.oldest===null?null:Number(row?.oldest)};},
 async close(){await owner?.close();},get available(){return owner?.available===true;}
 });
}
module.exports={create,KIND,WORK_COLUMNS:work.COLUMNS};
