'use strict';

// Existing evaluator input-checkpoint payload. Transport receipts may retain an
// unfinished committed cohort; clinical readers see only the sealed working set.
const {decodeDocument}=require('./postgres-identity');
const {isDeepStrictEqual}=require('node:util');
const DOMAINS=require('./clinical-storage-size-sql').DOMAINS;
const KIND='clinical-stream-v1';
const windowPolicy=require('./clinical-working-set-policy');
const fail=code=>{throw new Error(code);};
function position(text){if(typeof text!=='string'||! /^[0-9A-F]+\/[0-9A-F]+$/i.test(text))fail('CLINICAL_STREAM_POSITION');const [hi,lo]=text.split('/');if(hi.length>8||lo.length>8)fail('CLINICAL_STREAM_POSITION');return (BigInt('0x'+hi)<<32n)+BigInt('0x'+lo);}
function xid(value){if(!Number.isSafeInteger(value)||value<=0||value>4294967295)fail('CLINICAL_STREAM_XID');return value;}
const key=row=>JSON.stringify([row.domain,row.id_kind,row.doc?._id??row.id]);
function rowOf(domain,row){
 if(!DOMAINS.includes(domain)||!row||!row.doc||Array.isArray(row.doc))fail('CLINICAL_STREAM_ROW');
 decodeDocument(row);
 const ordinal=row.insertion_ordinal??row.ordinal??null;
 if(ordinal!==null&&(!Number.isSafeInteger(Number(ordinal))||Number(ordinal)<=0))fail('CLINICAL_STREAM_ORDINAL');
 const bytes=row.storage_bytes??row.storageBytes;
 if(!Number.isSafeInteger(Number(bytes))||Number(bytes)<0||bytes===null||bytes===undefined)fail('CLINICAL_STREAM_STORAGE_SIZE');
 return {domain,id_kind:row.id_kind,doc:row.doc,ordinal:ordinal===null?null:Number(ordinal),storageBytes:Number(bytes)};
}
function eventOf(domain,data){
 if(!['I','U','D'].includes(data?.action))fail('CLINICAL_STREAM_ACTION');
 xid(data.xid);position(data.lsn);
 const columns=Object.fromEntries([...(data.identity||[]),...(data.columns||[])].map(c=>[c.name,c.value]));
 const documentColumn=(data.columns||[]).find(c=>c.name==='doc')||(data.identity||[]).find(c=>c.name==='doc');
 if(documentColumn&&['json','jsonb','pg_catalog.json','pg_catalog.jsonb'].includes(documentColumn.type)&&typeof columns.doc==='string'){
  try{columns.doc=JSON.parse(columns.doc);}catch{fail('CLINICAL_STREAM_DOCUMENT_JSON');}
 }
 const id=columns._id??columns.doc?._id;
 if(!DOMAINS.includes(domain)||!['objectid','string'].includes(columns.id_kind)||typeof id!=='string'||!id)fail('CLINICAL_STREAM_IDENTITY');
 const before=Object.fromEntries((data.identity||[]).map(c=>[c.name,c.value]));
 const prior=before._id===undefined?null:{domain,id_kind:before.id_kind,id:before._id};
 const row=data.action==='D'?null:columns.doc===undefined&&data.action==='U'?{domain,id_kind:columns.id_kind,id,ordinal:columns.insertion_ordinal??null,storageBytes:columns.storage_bytes??null}:rowOf(domain,columns);
 if(row?.doc&&row.doc._id!==id)fail('CLINICAL_STREAM_IDENTITY');
 return {xid:data.xid,lsn:data.lsn,action:data.action,domain,id_kind:columns.id_kind,id,prior,row};
}
function bound(state,{maxRows,maxBytes},measuredRowBytes){
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Explicit clinical stream bounds required');
 if((state.rowCount??state.rows?.length??0)>maxRows||state.staged.length>maxRows)fail('CLINICAL_STREAM_ROW_BOUND');
 // Rows are already measured when sealing/bootstrap/expiry sets rowBytes.
 // Encode only the remaining envelope there, preserving the exact JSON cap.
 const bytes=measuredRowBytes===undefined
  ?Buffer.byteLength(JSON.stringify(state))+(state.rows===undefined?(state.rowBytes??2)+8:0)
  :Buffer.byteLength(JSON.stringify({...state,rows:undefined}))+measuredRowBytes+8;
 if(bytes>maxBytes)fail('CLINICAL_STREAM_BYTE_BOUND');
 return state;
}
function empty(){return {kind:KIND,ready:false,floor:0,deleted:0,rows:[],staged:[],last:null};}
// Transitions replace envelopes/arrays and never mutate retained rows or events,
// as in expire(). Readers decode their own documents before exposing them.
// Earlier receipts omitted absent sparse columns. Their null/absence meaning
// is the same during replay; keep those persisted cohorts usable on upgrade.
const receiptEvent=event=>event.row&&!event.row.doc?{...event,row:{...event.row,ordinal:event.row.ordinal??null,storageBytes:event.row.storageBytes??null}}:event;
function stage(saved,event,limits){
 const state={...(saved||empty())};if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 xid(event.xid);const at=position(event.lsn);
 // Serial strict notifier plus durable position makes redelivery idempotent.
 if(state.last!==null&&at<position(state.last))return bound(saved||state,limits);
 // One heap multi-insert WAL record can produce many rows at the same LSN.
 // Keep its distinct payloads; only exact redeliveries are redundant. A later
 // WAL record has a new LSN, even when it modifies that same typed identity.
 if(state.gap&&!state.ready)return recoverableGap(state,state.gap==='rows'?'CLINICAL_STREAM_ROW_BOUND':state.gap==='history'?'CLINICAL_STREAM_MISSING_HISTORY':'CLINICAL_STREAM_BYTE_BOUND',event.lsn,limits);
 // JSONB reorders object keys. Compare values so a persisted receipt remains
 // idempotent after decoding, including distinct rows sharing one COPY LSN.
 if(state.last===event.lsn&&state.staged.some(previous=>previous.lsn===event.lsn&&isDeepStrictEqual(receiptEvent(previous),receiptEvent(event))))return bound(saved||state,limits);
 state.staged=state.staged.concat(event);
 state.last=event.lsn;
 return bound(state,limits);
}
function seal(saved,{xid:transaction,lsn,floor,deleted,evaluatedAt},limits){
 xid(transaction);position(lsn);
 if(!Number.isSafeInteger(floor)||floor<0||!Number.isSafeInteger(deleted)||deleted<0||deleted>floor)fail('CLINICAL_STREAM_FLOOR');
 const state={...(saved||empty())};if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 let measuredRowBytes;
 const cohort=state.staged.filter(e=>e.xid===transaction);
 if(state.ready&&floor>state.floor){
  // The write clock is monotone ordering authority and can be ahead of wall
  // time. Only a completed engine instant may advance clinical membership.
  // Receipt sealing owns the input write, so this does not add a warm-reader
  // write. Idle input cannot grow; a real clock rewind still needs bootstrap.
  if(evaluatedAt!=null&&!Number.isSafeInteger(evaluatedAt))fail('CLINICAL_STREAM_EVALUATION_INSTANT');
  if(state.policy&&evaluatedAt>state.policy.at){
   const policy={...state.policy,at:evaluatedAt};
   windowPolicy.validate(policy);
   state.policy=policy;
  }
  const rows=new Map(state.rows.map(row=>[key(row),row]));
  for(const e of cohort){
   const previous=rows.get(key(e.prior||e));
   // Only a retained profile can hide an older winner when corrected/deleted.
   // A bounded historical fetch reconstructs it; never certify an empty profile.
   if(state.policy&&e.domain==='profile'&&previous&&(e.action==='D'||e.row?.doc&&(JSON.stringify(e.row.doc.startDate)!==JSON.stringify(previous.doc.startDate)||e.row.doc.isValid===false||e.row.doc._id!==previous.doc._id)))return recoverableGap(state,'CLINICAL_STREAM_MISSING_HISTORY',lsn,limits);
   if(e.prior)rows.delete(key(e.prior));
   if(e.action==='D')rows.delete(key(e));
   else {
    const row=e.row.doc?e.row:previous?rowOf(e.domain,{id_kind:e.id_kind,doc:previous.doc,ordinal:e.row.ordinal??previous.ordinal,storageBytes:e.row.storageBytes??previous.storageBytes}):null;
    // An unchanged TOAST-omitting document outside a complete window is
    // still outside it. Settings expansion/clock rewind rebuild before use.
    if(!row&&state.policy)continue;
    if(!row)fail('CLINICAL_STREAM_MISSING_HISTORY');
    rows.set(key(row),row);
   }
  }
  try { state.rows=state.policy?windowPolicy.select([...rows.values()],state.policy):[...rows.values()]; }
  catch(error){if(!error.unsupported)throw error;return recoverableGap(state,'CLINICAL_STREAM_MISSING_HISTORY',lsn,limits);}
  state.rowCount=state.rows.length;state.rowBytes=measuredRowBytes=Buffer.byteLength(JSON.stringify(state.rows));state.floor=floor;state.deleted=deleted;
 }
 // Before bootstrap the database snapshot will reconstruct the complete cohort.
 // Retain no clinically visible partial rows. The receipt still preserves work.
 state.staged=state.staged.filter(e=>e.xid!==transaction);
 return bound(state,limits,measuredRowBytes);
}
function bootstrap(saved,snapshot,limits){
 const state={...(saved||empty())};if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 if(!Number.isSafeInteger(snapshot.checkpoint)||!snapshot.signature||snapshot.signature.stamp!==snapshot.checkpoint)fail('CLINICAL_STREAM_SNAPSHOT');
 state.rows=snapshot.rows.map(row=>rowOf(row.domain,{...require('./postgres-identity').encodeDocument(row.document),ordinal:row.ordinal,storageBytes:row.storageBytes}));
 if(snapshot.policy){state.policy=windowPolicy.validate(snapshot.policy);state.windowRevision=(state.windowRevision||0)+1;state.rows=windowPolicy.select(state.rows,state.policy);}else delete state.policy;
 state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));
 delete state.gap;
 state.floor=snapshot.checkpoint;state.deleted=snapshot.signature.deleted;state.ready=true;
 // Staged events stay durable: an arriving seal at/below the consistent floor
 // skips them; a later cohort applies them. Never classify by clinical date.
 return bound(state,limits,state.rowBytes);
}
function recoverableGap(saved,code,lsn,limits){
 if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND','CLINICAL_STREAM_MISSING_HISTORY'].includes(code))fail('CLINICAL_STREAM_GAP_REASON');
 position(lsn);
 // Completed clinical output lives in its own durable consumer. Evict this
 // non-ready input cache so a valid full cache always has room for its gap
 // marker. The checkpoint column retains the last sealed clinical floor.
 return bound({kind:KIND,ready:false,gap:code==='CLINICAL_STREAM_ROW_BOUND'?'rows':code==='CLINICAL_STREAM_MISSING_HISTORY'?'history':'bytes',rows:[],staged:[],last:lsn},limits);
}
function output(state){
 if(state?.kind!==KIND||!state.ready)fail('CLINICAL_STREAM_BOOTSTRAP_REQUIRED');
 // Under one unchanged signature and compatible policy, expiry only removes
 // members. Count distinguishes successive transient subsets from the same
 // durable base, whose windowRevision otherwise increments to the same value.
 return {checkpoint:state.floor,signature:{stamp:state.floor,deleted:state.deleted},progress:state.policy?windowPolicy.KIND+':'+state.policy.devicestatusMs+':'+(state.windowRevision||0)+':'+state.rows.length:KIND,...(state.policy?{policy:state.policy,expiresAt:windowPolicy.nextExpiry(state.rows,state.policy)}:{stats:{dataSize:state.rows.reduce((sum,row)=>sum+row.storageBytes,0),indexSize:undefined}}),rows:state.rows.filter(row=>row.doc.isValid!==false).map(row=>({domain:row.domain,document:decodeDocument(row),ordinal:row.ordinal}))};
}
function expire(saved,policy,limits){
 if(!saved?.ready||!windowPolicy.compatible(saved.policy,policy))fail('CLINICAL_STREAM_BOOTSTRAP_REQUIRED');
 const state={...saved,policy,rows:windowPolicy.select(saved.rows,policy)};
 if(state.rows.length!==saved.rows.length)state.windowRevision=(saved.windowRevision||0)+1;
 state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));
 return bound(state,limits,state.rowBytes);
}
module.exports={expire,KIND,DOMAINS,position,xid,key,rowOf,eventOf,bound,empty,stage,seal,bootstrap,recoverableGap,output};
