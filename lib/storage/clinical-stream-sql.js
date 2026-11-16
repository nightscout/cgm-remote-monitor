'use strict';
const state=require('./clinical-stream-state');
const work=require('../pgstream/work-state');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function accept({pool,observeBackend,table,consumer,tenant,data,domain,invalidate=false,snapshotDigest,maxRows,maxBytes,completedConsumer,completedDigest}){
 if(!/^[a-z][a-z0-9_]{0,62}\.tenant_consumer_checkpoint$/.test(table)||!/^evaluator-[A-Za-z0-9_-]{1,100}$/.test(consumer)||!UUID.test(tenant)||! /^[a-f0-9]{64}$/.test(snapshotDigest))throw new TypeError('CLINICAL_STREAM_BINDING');
 const relation='"'+table.split('.')[0]+'".tenant_consumer_checkpoint';
 const event=!invalidate&&domain?state.eventOf(domain,data):null;
 if(!invalidate){state.xid(data.xid);state.position(data.lsn);}
 const client=await pool.connect();let failure;
 try{
  await observeBackend(client);await client.query('BEGIN');
  const rows=(await client.query('SELECT '+(domain?"jsonb_build_array((projection->0)-'rows',projection->1) AS projection":'projection') +',contract_digest,checkpoint FROM '+relation+' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE',[tenant,consumer])).rows;
  if(rows.length!==1)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const saved=rows[0].projection?.[0]?.kind===state.KIND?rows[0].projection[0]:null;
  if(!invalidate&&saved&&rows[0].contract_digest!==snapshotDigest)throw new Error('CLINICAL_STREAM_CONTRACT');
  let next,receipt;
  if(invalidate){next=rows[0].contract_digest===snapshotDigest&&saved?saved:state.empty();next.ready=false;next.rows=[];next.rowCount=0;next.rowBytes=2;next.staged=[];next.last=null;}
  else if(event){
   try{next=state.stage(saved,event,{maxRows,maxBytes});}
   catch(error){
    if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND'].includes(error.message))throw error;
    next=state.recoverableGap(saved,error.message,data.lsn,{maxRows,maxBytes});
   }
  }
  else{
   const row=Object.fromEntries([...(data.identity||[]),...(data.columns||[])].map(c=>[c.name,c.value]));
   const floor=Number(work.version(row.last_stamp)),deleted=Number(work.version(row.last_delete_stamp));
   // Read one completed clinical instant, not its frame or raw input. The
   // logical write clock may be future-clamped and cannot define a TTL.
   const evaluatedAt=saved?.policy&&completedConsumer?(await client.query("SELECT projection->0->'output'->'result'->'now' AS evaluated_at FROM "+relation+' WHERE tenant_id=$1 AND consumer=$2',[tenant,completedConsumer])).rows[0]?.evaluated_at:undefined;
   try{next=state.seal(saved,{xid:data.xid,lsn:data.lsn,floor,deleted,evaluatedAt},{maxRows,maxBytes});}
   catch(error){
    if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND'].includes(error.message))throw error;
    next=state.recoverableGap(saved,error.message,data.lsn,{maxRows,maxBytes});
   }
   receipt=(await work.observeInTransaction({client,table,consumer:completedConsumer,contractDigest:completedDigest,observations:[{tenant,observed:{clock:String(floor)}}]}))[0];
  }
  // The second envelope is a bounded mutation tail, independent of the
  // disposable clinical cache in the first. One input-row write commits both;
  // completed delivery metadata changes without rewriting its clinical frame.
  const journal=require('./storage-event-journal');
  const previous=journal.validate(rows[0].projection?.[1]);
  const tail=completedConsumer&&(event||invalidate)?invalidate?journal.reset(previous):journal.append(previous,domain,data,{maxRows,maxBytes}):previous;
  if(completedConsumer&&tail.head!==previous.head){
   const changed=await client.query('UPDATE '+relation+' SET delivery_revision=delivery_revision+1 WHERE tenant_id=$1 AND consumer=$2 AND contract_digest=$3',[tenant,completedConsumer,completedDigest]);
   if(changed.rowCount!==1)throw new Error('STORAGE_EVENT_OUTPUT_CONTRACT');
  }
  const input=domain&&saved&&!next.gap?"(projection->0)||($3::jsonb->0)":'$3::jsonb->0';
  const update=await client.query('UPDATE '+relation+' SET projection=jsonb_build_array('+input+',$3::jsonb->1),contract_digest=$4'+(!domain&&!invalidate?',checkpoint=$5':'')+' WHERE tenant_id=$1 AND consumer=$2',[tenant,consumer,JSON.stringify([next,tail]),snapshotDigest,...(!domain&&!invalidate?[next.ready?next.floor:rows[0].checkpoint]:[])]);
  if(update.rowCount!==1)throw new Error('CLINICAL_STREAM_NOT_PROVISIONED');
  const committed=await client.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('CLINICAL_STREAM_COMMIT_UNCONFIRMED');
  return receipt??{rawDeliveryPending:tail.head!==previous.head};
 }catch(error){failure=error;try{await client.query('ROLLBACK');}catch{ /* Evict failed receipt connection. */ }throw error;}
 finally{client.release(failure);}
}
module.exports={accept};
