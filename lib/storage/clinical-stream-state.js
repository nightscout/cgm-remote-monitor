'use strict';

// One bounded clinical input owner. Complete native cohorts enter atomically;
// native coverage and the local scheduler obligation are separate values.
const {decodeDocument}=require('./postgres-identity');
const DOMAINS=require('./clinical-storage-size-sql').DOMAINS;
const KIND='clinical-stream-v2';
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
 if((state.rowCount??state.rows?.length??0)>maxRows)fail('CLINICAL_STREAM_ROW_BOUND');
 // Rows are already measured when cohort application/bootstrap/expiry sets rowBytes.
 // Encode only the remaining envelope there, preserving the exact JSON cap.
 const bytes=measuredRowBytes===undefined
  ?Buffer.byteLength(JSON.stringify(state))+(state.rows===undefined?(state.rowBytes??2)+8:0)
  :Buffer.byteLength(JSON.stringify({...state,rows:undefined}))+measuredRowBytes+8;
 if(bytes>maxBytes)fail('CLINICAL_STREAM_BYTE_BOUND');
 return state;
}
function empty(){return {kind:KIND,ready:false,floor:0,deleted:0,rows:[]};}
function sourceIdentity(value){
 if(!value||typeof value.system_id!=='string'||! /^(0|[1-9][0-9]*)$/.test(value.system_id)||!Number.isSafeInteger(value.timeline)||value.timeline<1||typeof value.database!=='string'||!value.database||typeof value.slot!=='string'||! /^[a-z0-9_]{1,63}$/.test(value.slot))fail('CLINICAL_STREAM_SOURCE');
 return {system_id:value.system_id,timeline:value.timeline,database:value.database,slot:value.slot};
}
function sameSource(a,b){return !!a&&!!b&&['system_id','timeline','database','slot'].every(k=>a[k]===b[k]);}
function streamBoundary(value){
 if(!value||typeof value.generation!=='string'||! /^[A-Za-z0-9:_-]{1,128}$/.test(value.generation))fail('CLINICAL_STREAM_GENERATION');
 const result={source_identity:sourceIdentity(value.source_identity),generation:value.generation,snapshot_position:value.snapshot_position,accepted_position:value.accepted_position??null};
 position(result.snapshot_position);if(result.accepted_position!==null)position(result.accepted_position);
 return result;
}
function validateTransaction(envelope,{maxRows,maxBytes}){
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new TypeError('Explicit transaction bounds required');
 const frames=envelope?.Transaction;
 if(!Array.isArray(frames)||frames.length<2)fail('CLINICAL_STREAM_TRANSACTION');
 if(frames.length-2>maxRows)fail('CLINICAL_STREAM_TRANSACTION_ROW_BOUND');
 if(Buffer.byteLength(JSON.stringify(envelope))>maxBytes)fail('CLINICAL_STREAM_TRANSACTION_BYTE_BOUND');
 const begin=frames[0],commit=frames[frames.length-1];
 if(begin?.action!=='B'||commit?.action!=='C')fail('CLINICAL_STREAM_TRANSACTION_BOUNDARY');
 xid(begin.xid);sourceIdentity(begin.source_identity);sourceIdentity(commit.source_identity);
 position(begin.nextlsn);position(commit.nextlsn);
 if(begin.nextlsn!==commit.nextlsn||!sameSource(begin.source_identity,commit.source_identity)||commit.xid!==begin.xid||commit.transaction_count!==frames.length-2)fail('CLINICAL_STREAM_TRANSACTION_COVERAGE');
 for(let i=0;i<frames.length;i++){
  const frame=frames[i];
  if(frame?.transaction_index!==i||frame.xid!==begin.xid)fail('CLINICAL_STREAM_TRANSACTION_COVERAGE');
  position(frame.lsn);
  if(i>0&&i<frames.length-1&&!['I','U','D','M'].includes(frame.action))fail('CLINICAL_STREAM_TRANSACTION_ACTION');
 }
 return {begin,changes:frames.slice(1,-1),commit,source_identity:sourceIdentity(commit.source_identity),position:commit.nextlsn};
}
function applyTransaction(saved,events,coverage,limits,evaluatedAt){
 if(saved?.kind!==KIND||!saved.stream)fail('CLINICAL_STREAM_BOOTSTRAP_REQUIRED');
 const boundary=streamBoundary(saved.stream);
 if(!sameSource(boundary.source_identity,coverage.source_identity)||boundary.generation!==coverage.generation)fail('CLINICAL_STREAM_SOURCE_FENCE');
 const at=position(coverage.position);
 if(boundary.accepted_position!==null&&at<=position(boundary.accepted_position))return bound(saved,limits);
 if(!Number.isSafeInteger(saved.floor)||saved.floor<0||!Number.isSafeInteger(saved.floor+1))fail('CLINICAL_STREAM_FLOOR');
 const state={...saved,stream:{...boundary,accepted_position:coverage.position},floor:saved.floor+1};
 if(events.some(e=>e.action==='D'))state.deleted=state.floor;
 if(!state.ready)return bound(state,limits);
 // The recovery snapshot may cover clinical rows that the ordinary stream has
 // not yet delivered. It never covers the independent raw-delivery obligation.
 if(at<=position(boundary.snapshot_position))return bound(state,limits);
 if(evaluatedAt!=null&&!Number.isSafeInteger(evaluatedAt))fail('CLINICAL_STREAM_EVALUATION_INSTANT');
 if(state.policy&&evaluatedAt>state.policy.at){state.policy={...state.policy,at:evaluatedAt};windowPolicy.validate(state.policy);}
 const rows=new Map(state.rows.map(row=>[key(row),row]));
 for(const e of events){
  const previous=rows.get(key(e.prior||e));
  if(state.policy&&e.domain==='profile'&&previous&&(e.action==='D'||e.row?.doc&&(JSON.stringify(e.row.doc.startDate)!==JSON.stringify(previous.doc.startDate)||e.row.doc.isValid===false||e.row.doc._id!==previous.doc._id)))return recoverableGap(state,'CLINICAL_STREAM_MISSING_HISTORY',coverage.position,limits);
  if(e.prior)rows.delete(key(e.prior));
  if(e.action==='D')rows.delete(key(e));
  else{
   const row=e.row.doc?e.row:previous?rowOf(e.domain,{id_kind:e.id_kind,doc:previous.doc,ordinal:e.row.ordinal??previous.ordinal,storageBytes:e.row.storageBytes??previous.storageBytes}):null;
   if(!row&&state.policy)continue;
   if(!row)return recoverableGap(state,'CLINICAL_STREAM_MISSING_HISTORY',coverage.position,limits);
   rows.set(key(row),row);
  }
 }
 try{state.rows=state.policy?windowPolicy.select([...rows.values()],state.policy):[...rows.values()];}
 catch(error){if(!error.unsupported)throw error;return recoverableGap(state,'CLINICAL_STREAM_MISSING_HISTORY',coverage.position,limits);}
 state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));
 try{return bound(state,limits,state.rowBytes);}
 catch(error){if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND'].includes(error.message))throw error;return recoverableGap(state,error.message,coverage.position,limits);}
}
function bootstrap(saved,snapshot,limits){
 const state={...(saved||empty())};if(state.kind!==KIND)fail('CLINICAL_STREAM_CONTRACT');
 if(!Number.isSafeInteger(snapshot.checkpoint)||snapshot.checkpoint<0||!snapshot.signature||snapshot.signature.stamp!==snapshot.checkpoint)fail('CLINICAL_STREAM_SNAPSHOT');
 const boundary=streamBoundary(snapshot.stream);
 // Recovery covers clinical membership; retain independently accepted raw coverage.
 if(saved?.stream&&sameSource(saved.stream.source_identity,boundary.source_identity)&&saved.stream.generation===boundary.generation)boundary.accepted_position=saved.stream.accepted_position??null;
 else if(boundary.accepted_position===null)boundary.accepted_position=boundary.snapshot_position;
 state.stream=boundary;
 state.rows=snapshot.rows.map(row=>rowOf(row.domain,{...require('./postgres-identity').encodeDocument(row.document),ordinal:row.ordinal,storageBytes:row.storageBytes}));
 if(snapshot.policy){state.policy=windowPolicy.validate(snapshot.policy);state.windowRevision=(state.windowRevision||0)+1;state.rows=windowPolicy.select(state.rows,state.policy);}else delete state.policy;
 state.rowCount=state.rows.length;state.rowBytes=Buffer.byteLength(JSON.stringify(state.rows));
 delete state.gap;
 state.floor=snapshot.checkpoint;state.deleted=snapshot.signature.deleted;state.ready=true;
 return bound(state,limits,state.rowBytes);
}
function recoverableGap(saved,code,lsn,limits){
 if(!['CLINICAL_STREAM_ROW_BOUND','CLINICAL_STREAM_BYTE_BOUND','CLINICAL_STREAM_MISSING_HISTORY'].includes(code))fail('CLINICAL_STREAM_GAP_REASON');
 position(lsn);
 // Completed clinical output lives in its own durable consumer. Evict this
 // non-ready input cache so a valid full cache always has room for its gap
 // marker. The checkpoint column retains the last sealed clinical floor.
 return bound({kind:KIND,ready:false,gap:code==='CLINICAL_STREAM_ROW_BOUND'?'rows':code==='CLINICAL_STREAM_MISSING_HISTORY'?'history':'bytes',rows:[],floor:saved?.floor??0,deleted:saved?.deleted??0,...(saved?.stream?{stream:saved.stream}:{})},limits);
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
// SQL retains only recovery coordinates. Rows are an evictable process cache;
// a missing cache always requires an exact source snapshot before evaluation.
function compact(state){const metadata={...state,ready:false};delete metadata.rows;return metadata;}
function matches(cached,saved){return !!cached&&cached.floor===saved?.floor&&cached.deleted===saved.deleted&&sameSource(cached.stream?.source_identity,saved.stream?.source_identity)&&['generation','snapshot_position','accepted_position'].every(k=>cached.stream?.[k]===saved.stream?.[k]);}
module.exports={compact,matches,expire,KIND,DOMAINS,position,xid,key,rowOf,eventOf,bound,empty,sourceIdentity,sameSource,streamBoundary,validateTransaction,applyTransaction,bootstrap,recoverableGap,output};
