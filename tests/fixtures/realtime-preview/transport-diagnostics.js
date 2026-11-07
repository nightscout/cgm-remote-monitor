'use strict';
// Bounded fixture metadata only: never headers, queries, sid, credentials or bodies.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const KINDS=['ingress-response','ingress-upgrade','ingress-error','client-connect','client-connect-error','lookup-refused'];
const CODES=['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_NONAME','EAI_ADDRFAMILY','TRANSPORT_ERROR'];
function errorCode(error){return CODES.includes(error?.code)?error.code:'TRANSPORT_ERROR';}
function status(value){return Number.isInteger(value)&&(value===0||value>=100&&value<=599)?value:null;}
function metadata({kind,url,host,hosts,upstreamRole,httpStatus,error}){
 let parsed,hostname;try{parsed=new URL(url,'http://fixture.invalid');}catch{/* Unknown input stays unclassified. */}try{hostname=new URL('http://'+host).hostname;}catch{/* Unknown input stays unclassified. */}
 return {kind,routeClass:parsed?.pathname.startsWith('/socket.io/')?'socket.io':parsed?.pathname.startsWith('/api/')?'api':'other',transport:['polling','websocket'].includes(parsed?.searchParams.get('transport'))?parsed.searchParams.get('transport'):'unknown',eio:['3','4'].includes(parsed?.searchParams.get('EIO'))?Number(parsed.searchParams.get('EIO')):null,status:status(httpStatus),knownHost:hosts.includes(hostname),upstreamRole,errorCode:error?errorCode(error):null};
}
function create({captureDir,maxEvents,maxBytes}){
 assert(path.isAbsolute(captureDir)&&Number.isSafeInteger(maxEvents)&&maxEvents>0&&Number.isSafeInteger(maxBytes)&&maxBytes>0);
 const file=path.join(captureDir,'transport-diagnostics.json'),events=[];let droppedEvents=0;
 const snapshot=()=>({classification:'bounded synthetic fixture transport metadata; knownHost is allowlist membership, not authorization',events,droppedEvents});
 assert(Buffer.byteLength(JSON.stringify(snapshot()))<=maxBytes,'TRANSPORT_DIAGNOSTIC_BOUND_TOO_SMALL');
 function record(row){
  assert.deepEqual(Object.keys(row).sort(),['kind','routeClass','transport','eio','status','knownHost','upstreamRole','errorCode'].sort());
  assert(KINDS.includes(row.kind)&&['socket.io','api','other'].includes(row.routeClass)&&['polling','websocket','unknown'].includes(row.transport)&&[3,4,null].includes(row.eio)&&([null,0].includes(row.status)||Number.isInteger(row.status)&&row.status>=100&&row.status<=599));
  assert(typeof row.knownHost==='boolean'&&['api','realtime'].includes(row.upstreamRole)&&(row.errorCode===null||CODES.includes(row.errorCode)));
  events.push({...row});
  while(events.length>maxEvents||Buffer.byteLength(JSON.stringify(snapshot()))>maxBytes){events.shift();droppedEvents++;assert(events.length||Buffer.byteLength(JSON.stringify(snapshot()))<=maxBytes,'TRANSPORT_DIAGNOSTIC_BOUND_TOO_SMALL');}
  fs.writeFileSync(file,JSON.stringify(snapshot()),{mode:0o600});
 }
 return Object.freeze({record,file});
}
module.exports={create,metadata,errorCode,status};
