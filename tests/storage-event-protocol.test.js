'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const journal=require('../lib/storage/storage-event-journal'),factory=require('../lib/server/realtime/protocol');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
class Socket extends EventEmitter{
 constructor(host='a.test'){super();this.id=host;this.rooms=new Set([host]);this.request={headers:{host},socket:{}};this.sent=[];}
 emit(event,value){this.sent.push({event,value});return true;}
 join(room){this.rooms.add(room);}leave(room){this.rooms.delete(room);}disconnect(){this.disconnected=true;super.emit('disconnect');}
 async receive(event,...args){await Promise.all(this.listeners(event).map(fn=>fn(...args)));}
}
function fixture(module=factory){
 let tail=journal.empty(),allowed=true,held=false,failRead=false;
 const protocol=module.create({admission:{resolve:async req=>req.headers.host==='b.test'?B:A},
 api:{authorizeSocket:async()=>{if(held)throw new Error('temporarily unavailable');return {permissions:{read:allowed,write:false,write_treatment:false,ack:false},collections:allowed?['food','entries','activity']:[]};},executeSocketMutation:async()=>{}},readCurrent:async()=>({identity:'same'}),runtime:()=>({}),domains:['food','entries','activity'],retry:{minMs:5,maxMs:20},storageEvents:{read:async()=>{if(failRead){failRead=false;throw new Error('TRANSIENT_RAW_READ');}return tail;}}});
 return {protocol,failReadOnce:()=>{failRead=true;},get tail(){return tail;},set allowed(v){allowed=v;},set held(v){held=v;},reset(){tail=journal.reset(tail);},
 append(domain,action,id,extra={}){const doc={_id:id,identifier:'public-'+id,...extra},cols=Object.entries({id_kind:'string',doc}).map(([name,value])=>({name,value}));tail=journal.append(tail,domain,{xid:7,lsn:'0/'+(32+tail.head).toString(16),action,columns:action==='D'?null:cols,identity:action==='I'?null:cols},{maxRows:3,maxBytes:10000});},
 async socket(host){const socket=new Socket(host);await protocol.prepare(socket);protocol.bind(socket,'/storage');let answer;await socket.receive('subscribe',{},value=>{answer=value;});assert.equal(answer.success,true);return socket;},close:()=>protocol.close()};
}
describe('raw storage live-session delivery independent of clinical completion',()=>{
 it('delivers food/activity/out-of-window operations in order, keeps neighbors isolated and suppresses duplicate retry',async()=>{
  const f=fixture();try{const a=await f.socket('a.test'),b=await f.socket('b.test');f.append('food','I','old',{date:1});f.append('activity','D','deleted');await f.protocol.storage({tenant:A,tail:f.tail});await f.protocol.storage({tenant:A,tail:f.tail});assert.deepEqual(a.sent.map(e=>e.event),['create','delete']);assert.equal(a.sent[1].value.identifier,'public-deleted');assert.deepEqual(b.sent,[]);
  // Clinical cache expiry/completion is not a source delete.
  await f.protocol.fanout({tenant:A,previous:{rows:[{domain:'food',document:{_id:'old'}}]},next:{identity:'same',rows:[],frame:{}}});assert.equal(a.sent.length,2);
  }finally{f.close();}
 });
 it('uses live subscribe high-water mark without offline replay, then resumes actual new events',async()=>{
  const f=fixture();try{f.append('food','I','before');const a=await f.socket();assert.deepEqual(a.sent,[]);await f.protocol.storage({tenant:A,tail:f.tail});assert.deepEqual(a.sent,[]);f.append('food','I','after');await f.protocol.storage({tenant:A,tail:f.tail});assert.equal(a.sent[0].value.doc.identifier,'public-after');a.disconnect();const again=await f.socket();await f.protocol.storage({tenant:A,tail:f.tail});assert.deepEqual(again.sent,[]);}finally{f.close();}
 });
 it('disconnects lagged/restore-invalidated sessions instead of silently skipping mutations, while new sessions progress',async()=>{
  const f=fixture();try{const a=await f.socket();for(let i=0;i<5;i++)f.append('food','I','n'+i);await f.protocol.storage({tenant:A,tail:f.tail});assert(a.disconnected,'TRUNCATED_SESSION_MUST_DISCONNECT');const fresh=await f.socket();f.append('food','I','next');await f.protocol.storage({tenant:A,tail:f.tail});assert.equal(fresh.sent.length,1);f.reset();await f.protocol.storage({tenant:A,tail:f.tail});assert(fresh.disconnected,'RESTORE_MUST_BREAK_OLD_CONTINUITY');}finally{f.close();}
 });
 it('retains held authority cursor until recheck, then catches up or removes revoked collections',async()=>{
  const f=fixture();try{const a=await f.socket();f.held=true;await f.protocol.recheckTenant(A);f.append('food','I','held');await f.protocol.storage({tenant:A,tail:f.tail});assert.deepEqual(a.sent,[]);f.held=false;await f.protocol.recheckTenant(A);assert.equal(a.sent.length,1);f.allowed=false;await f.protocol.recheckTenant(A);f.append('food','I','revoked');await f.protocol.storage({tenant:A,tail:f.tail});assert.equal(a.sent.length,1);}finally{f.close();}
 });
 it('RED/restored control catches silent journal truncation',async()=>{
  const broken=require('./lib/clinical-working-set/control')('../lib/server/realtime/protocol',"retire(state,CAUSES.STORAGE_CONTINUITY);continue;","state.storageCursor=tail.base;");
  const check=async module=>{const f=fixture(module);try{const a=await f.socket();for(let i=0;i<5;i++)f.append('food','I','n'+i);await f.protocol.storage({tenant:A,tail:f.tail});assert(a.disconnected,'TRUNCATED_SESSION_MUST_DISCONNECT');}finally{f.close();}};
  await assert.rejects(check(broken),/TRUNCATED_SESSION/);await check(factory);
 });
 it('ignores an older concurrent tail after a newer subscribe/delivery without disconnecting',async()=>{
  const f=fixture();try{f.append('food','I','before');const old=structuredClone(f.tail);f.append('food','I','newer');const a=await f.socket();await f.protocol.storage({tenant:A,tail:old});assert(!a.disconnected);assert.deepEqual(a.sent,[]);}finally{f.close();}
 });

 it('retries temporary journal-read pressure while subscribing without inventing a refusal',async()=>{
  const f=fixture();try{f.failReadOnce();const a=await f.socket();assert(!a.disconnected);f.append('food','I','after-retry');await f.protocol.storage({tenant:A,tail:f.tail});assert.equal(a.sent.length,1);}finally{f.close();}
 });

});
