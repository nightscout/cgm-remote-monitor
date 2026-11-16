'use strict';

// A bounded delivery tail, never a projection of source history. Socket.IO's
// existing subscription has no offline cursor; each live session owns a cursor.
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {decodeDocument}=require('./postgres-identity');
const {normalizeDoc}=require('../api3/storage/mongoCollection/utils');
const {DOMAINS,position,xid}=require('./clinical-stream-state');
const KIND='storage-events-v1';
const fail=code=>{throw new Error(code);};
function empty(){return {kind:KIND,head:0,base:0,events:[],last:null,keys:[]};}
function validate(value){
 const state=value??empty();
 if(state.kind!==KIND||![state.head,state.base].every(Number.isSafeInteger)||state.base<0||state.head<state.base||!Array.isArray(state.events)||!Array.isArray(state.keys))fail('STORAGE_EVENT_CONTRACT');
 let previous=state.base;
 for(const event of state.events){if(event.sequence!==previous+1||!DOMAINS.includes(event.domain)||!['create','update','delete'].includes(event.event)||event.value?.colName!==event.domain)fail('STORAGE_EVENT_ORDER');previous=event.sequence;}
 if(previous!==state.head)fail('STORAGE_EVENT_COVERAGE');
 return state;
}
function document(columns){
 const row=Object.fromEntries((columns||[]).map(column=>[column.name,column.value]));
 if(typeof row.doc==='string')try{row.doc=JSON.parse(row.doc);}catch{fail('STORAGE_EVENT_JSON');}
 return row.doc?decodeDocument(row):null;
}
function changes(domain,data){
 if(!DOMAINS.includes(domain)||!['I','U','D'].includes(data.action))fail('STORAGE_EVENT_ROUTE');
 const before=document(data.identity),after=document(data.columns)||before;
 if(data.action!=='I'&&!before)fail('STORAGE_EVENT_FULL_IDENTITY_REQUIRED');
 if(data.action!=='D'&&!after)fail('STORAGE_EVENT_DOCUMENT_REQUIRED');
 if(data.action==='U'&&isDeepStrictEqual(before,after))return []; // size-only/unchanged-TOAST DML
 const normalized=doc=>{const copy={...doc};normalizeDoc(copy);return copy;};
 if(data.action==='D'&&before.isValid===false)return [];
 if(data.action==='U'&&after.isValid===false)return before.isValid===false?[]:[{event:'delete',domain,value:{colName:domain,identifier:normalized(before).identifier}}];
 if(data.action==='I'&&after.isValid===false)return [];
 if(data.action==='D')return [{event:'delete',domain,value:{colName:domain,identifier:normalized(before).identifier}}];
 const next=normalized(after),old=before&&normalized(before),result=[];
 // Renaming a public identifier retires the old client key before its update.
 if(old&&old.identifier!==next.identifier)result.push({event:'delete',domain,value:{colName:domain,identifier:old.identifier}});
 result.push({event:data.action==='I'||before?.isValid===false?'create':'update',domain,value:{colName:domain,doc:next}});
 return result;
}
function append(saved,domain,data,{maxRows,maxBytes}){
 const previous=validate(saved);position(data.lsn);xid(data.xid);
 if(!Number.isSafeInteger(maxRows)||maxRows<1||!Number.isSafeInteger(maxBytes)||maxBytes<256)fail('STORAGE_EVENT_BOUND');
 if(previous.last&&position(data.lsn)<position(previous.last))return previous;
 const key=createHash('sha256').update(JSON.stringify([domain,data])).digest('hex');
 if(previous.last===data.lsn&&previous.keys.includes(key))return previous;
 const state={...previous,events:previous.events.slice(),last:data.lsn,keys:previous.last===data.lsn?previous.keys.slice():[]};
 // Exact equal-LSN retries are redundant; distinct multi-insert rows remain.
 state.keys.push(key);if(state.keys.length>maxRows)state.keys.shift();
 for(const change of changes(domain,data)){
  if(!Number.isSafeInteger(++state.head))fail('STORAGE_EVENT_SEQUENCE_EXHAUSTED');
  state.events.push({...change,sequence:state.head});
 }
 // Overflow is explicit coverage loss. A live cursor behind base disconnects;
 // it can never mistake a truncated tail for complete delivery.
 while(state.events.length&&(state.events.length>maxRows||Buffer.byteLength(JSON.stringify(state))>maxBytes))state.base=state.events.shift().sequence;
 while(state.keys.length&&Buffer.byteLength(JSON.stringify(state))>maxBytes)state.keys.shift();
 if(Buffer.byteLength(JSON.stringify(state))>maxBytes)fail('STORAGE_EVENT_BOUND');
 return validate(state);
}
function reset(saved){const state=validate(saved);if(!Number.isSafeInteger(state.head+1))fail('STORAGE_EVENT_SEQUENCE_EXHAUSTED');return {...empty(),head:state.head+1,base:state.head+1};}
module.exports={KIND,empty,validate,changes,append,reset};
