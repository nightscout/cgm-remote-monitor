'use strict';

// Existing evaluator input-checkpoint payload. Transport receipts may retain an
// unfinished committed cohort; clinical readers see only the sealed working set.
const {decodeDocument}=require('./postgres-identity');
const DOMAINS=require('./clinical-storage-size-sql').DOMAINS;
const KIND='clinical-stream-v1';
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
 const documentColumn=(data.columns||[]).find(c=>c.name==='doc');
 if(documentColumn&&['json','jsonb','pg_catalog.json','pg_catalog.jsonb'].includes(documentColumn.type)&&typeof columns.doc==='string'){
  try{columns.doc=JSON.parse(columns.doc);}catch{fail('CLINICAL_STREAM_DOCUMENT_JSON');}
 }
 const id=columns._id??columns.doc?._id;
 if(!DOMAINS.includes(domain)||!['objectid','string'].includes(columns.id_kind)||typeof id!=='string'||!id)fail('CLINICAL_STREAM_IDENTITY');
 const before=Object.fromEntries((data.identity||[]).map(c=>[c.name,c.value]));
 const prior=before._id===undefined?null:{domain,id_kind:before.id_kind,id:before._id};
 const row=data.action==='D'?null:columns.doc===undefined&&data.action==='U'?{domain,id_kind:columns.id_kind,id,ordinal:columns.insertion_ordinal,storageBytes:columns.storage_bytes}:rowOf(domain,columns);
 if(row?.doc&&row.doc._id!==id)fail('CLINICAL_STREAM_IDENTITY');
 return {xid:data.xid,lsn:data.lsn,action:data.action,domain,id_kind:columns.id_kind,id,prior,row};
}
function bound(state,{maxRows,maxBytes}){
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Explicit clinical stream bounds required');
 if((state.rowCount??state.rows?.length??0)>maxRows||state.staged.length>maxRows)fail('CLINICAL_STREAM_ROW_BOUND');
 if(Buffer.byteLength(JSON.stringify(state))+(state.rows===undefined?(state.rowBytes??2)+7:0)>maxBytes)fail('CLINICAL_STREAM_BYTE_BOUND');
 return state;
}
function empty(){return {kind:KIND,ready:false,floor:0,deleted:0,rows:[],staged:[],last:null};}
function stage(saved,event,limits){
 const state=structuredClone(saved||empty());if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 xid(event.xid);const at=position(event.lsn);
 // Serial strict notifier plus durable position makes redelivery idempotent.
 if(state.last!==null&&at<position(state.last))return bound(state,limits);
 // One heap multi-insert WAL record can produce many rows at the same LSN.
 // Keep its distinct payloads; only exact redeliveries are redundant. A later
 // WAL record has a new LSN, even when it modifies that same typed identity.
 if(state.gap&&!state.ready){state.last=event.lsn;return bound(state,limits);}
 const encoded=JSON.stringify(event);
 if(!state.staged.some(previous=>previous.lsn===event.lsn&&JSON.stringify(previous)===encoded))state.staged.push(event);
 state.last=event.lsn;
 return bound(state,limits);
}
function seal(saved,{xid:transaction,lsn,floor,deleted},limits){
 xid(transaction);position(lsn);
 if(!Number.isSafeInteger(floor)||floor<0||!Number.isSafeInteger(deleted)||deleted<0||deleted>floor)fail('CLINICAL_STREAM_FLOOR');
 const state=structuredClone(saved||empty());if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 const cohort=state.staged.filter(e=>e.xid===transaction);
 if(state.ready&&floor>state.floor){
  const rows=new Map(state.rows.map(row=>[key(row),row]));
  for(const e of cohort){
   const previous=rows.get(key(e.prior||e));
   if(e.prior)rows.delete(key(e.prior));
   if(e.action==='D')rows.delete(key(e));
   else {
    const row=e.row.doc?e.row:previous?rowOf(e.domain,{id_kind:e.id_kind,doc:previous.doc,ordinal:e.row.ordinal??previous.ordinal,storageBytes:e.row.storageBytes??previous.storageBytes}):null;
    if(!row)fail('CLINICAL_STREAM_MISSING_HISTORY');
    rows.set(key(row),row);
   }
  }
  state.rows=[...rows.values()];state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));state.floor=floor;state.deleted=deleted;
 }
 // Before bootstrap the database snapshot will reconstruct the complete cohort.
 // Retain no clinically visible partial rows. The receipt still preserves work.
 state.staged=state.staged.filter(e=>e.xid!==transaction);
 return bound(state,limits);
}
function bootstrap(saved,snapshot,limits){
 const state=structuredClone(saved||empty());if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 if(!Number.isSafeInteger(snapshot.checkpoint)||!snapshot.signature||snapshot.signature.stamp!==snapshot.checkpoint)fail('CLINICAL_STREAM_SNAPSHOT');
 state.rows=snapshot.rows.map(row=>rowOf(row.domain,{...require('./postgres-identity').encodeDocument(row.document),ordinal:row.ordinal,storageBytes:row.storageBytes}));
 state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));
 delete state.gap;
 state.floor=snapshot.checkpoint;state.deleted=snapshot.signature.deleted;state.ready=true;
 // Staged events stay durable: an arriving seal at/below the consistent floor
 // skips them; a later cohort applies them. Never classify by clinical date.
 return bound(state,limits);
}
function recoverableGap(saved,code,lsn,limits){
 if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND'].includes(code))fail('CLINICAL_STREAM_GAP_REASON');
 position(lsn);const state=structuredClone(saved||empty());
 state.ready=false;state.gap=code;state.staged=[];state.last=lsn;
 return bound(state,limits);
}
function output(state){
 if(state?.kind!==KIND||!state.ready)fail('CLINICAL_STREAM_BOOTSTRAP_REQUIRED');
 return {checkpoint:state.floor,signature:{stamp:state.floor,deleted:state.deleted},progress:KIND,stats:{dataSize:state.rows.reduce((sum,row)=>sum+row.storageBytes,0),indexSize:undefined},rows:state.rows.filter(row=>row.doc.isValid!==false).map(row=>({domain:row.domain,document:decodeDocument(row),ordinal:row.ordinal}))};
}
module.exports={KIND,DOMAINS,position,xid,key,rowOf,eventOf,bound,empty,stage,seal,bootstrap,recoverableGap,output};
