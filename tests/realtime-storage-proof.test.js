'use strict';
// Synthetic source/protocol vectors only. Native proof requires the joined cohort.
const assert=require('node:assert/strict'),{ObjectId}=require('mongodb');
const oracle=require('./fixtures/realtime-preview/storage-oracle'),protocolFactory=require('../lib/server/realtime/protocol');
const A='11111111-1111-4111-8111-111111111111',id='0123456789abcdef01234567';
class Socket{
  constructor(){this.id='synthetic-socket';this.request={headers:{host:'one.example.test'},socket:{}};this.rooms=new Set([this.id]);this.handlers={};this.events=[];}
  on(event,fn){this.handlers[event]=fn;}
  emit(event,value){this.events.push({event,value});}
  join(room){this.rooms.add(room);}
  leave(room){this.rooms.delete(room);}
  disconnect(){this.disconnected=true;}
}
const object={id_kind:'objectid',doc:{_id:id,type:'sgv',sgv:111}},string={id_kind:'string',doc:{_id:id,type:'sgv',sgv:222}};
describe('joined storage physical/wire/current-collection oracles',function(){
  it('captures bounded stage events independently of later socket pushes and nested payload mutations',function(){
    const live=[oracle.single('create',object),oracle.single('create',string)],group=[{transport:'polling',events:live}],limits={maxRows:10,maxBytes:10000};
    const observations={CREATE:{clients:oracle.eventSnapshots(group,limits)}};
    live.push(oracle.single('update',{...string,doc:{...string.doc,sgv:333}}));
    observations.UPDATE={clients:oracle.eventSnapshots(group,limits)};
    live.push(oracle.single('delete',object),oracle.single('delete',string));
    live[0].value.doc.sgv=999;
    const saved=JSON.parse(JSON.stringify(observations));
    assert.equal(saved.CREATE.clients[0].events.length,2,'STORAGE_CREATE_SNAPSHOT_IMMUTABLE');
    assert.equal(saved.UPDATE.clients[0].events.length,3,'STORAGE_UPDATE_SNAPSHOT_IMMUTABLE');
    assert.deepEqual(saved.CREATE.clients[0].events,[oracle.single('create',object),oracle.single('create',string)],'STORAGE_SNAPSHOT_ORIGINAL_WIRE_VALUES');
    assert.equal(live.length,5,'all later actual events remain retained in the live collection');
    assert.equal(live[0].value.doc.sgv,999,'capture does not freeze or edit the transport-owned object');
    assert.throws(()=>oracle.eventSnapshots(group,{...limits,maxRows:4}),/PROOF_BOUND/);
    assert.throws(()=>oracle.eventSnapshots(group,{...limits,maxBytes:1}),/PROOF_BOUND/);
  });
  it('compares actual single normalizer/broadcaster shapes with actual typed protocol changes and pins inherited ambiguity',function(){
    const rows=[{domain:'entries',document:{...object.doc,_id:new ObjectId(id)}},{domain:'entries',document:string.doc}];
    assert.deepEqual(protocolFactory.storageChanges([],rows).map(row=>({event:row.event,value:row.value})),[oracle.single('create',object),oracle.single('create',string)]);
    assert.equal(oracle.single('create',object).value.doc.identifier,oracle.single('create',string).value.doc.identifier);
    assert.deepEqual(protocolFactory.storageChanges(rows,rows.slice(1)).map(row=>({event:row.event,value:row.value})),[oracle.single('delete',object)]);
    assert.deepEqual(oracle.single('delete',object),oracle.single('delete',string),'legacy delete wire cannot identify BSON kind');
  });
  it('rejects wrong physical twin deletion or duplicate wire delivery while preserving raw evidence before verdict',function(){
    const expected={twins:[string],events:[oracle.single('delete',object)]};
    const base={stage:'delete',id,twins:[string],clockBefore:[{last_stamp:'42'}],clockAfter:[{last_stamp:'42'}],foreignBefore:[],foreignAfter:[],
      clients:[{transport:'polling',events:expected.events}],foreignClients:[{transport:'websocket',events:[]}]};
    oracle.typed(base,expected,()=>{});
    for(const mutate of [p=>p.twins=[object],p=>p.clients[0].events.push(p.clients[0].events[0]),p=>p.foreignAfter=[string]]){
      const physical=structuredClone(base),saved=[];mutate(physical);
      assert.throws(()=>oracle.typed(physical,expected,row=>saved.push(row)),assert.AssertionError);
      assert(saved[0].STORAGE_CONNECTED_TYPED_DELETE);assert.equal(saved[1].semanticFailure.code,'ERR_ASSERTION');
    }
  });
  const physical=()=>({marker:'synthetic-marker',grants:[],current:{permissions:{read:false},collections:[]},
    checkpoint:{checkpoint:'42',projection:[{domain:'entries',id_kind:'string',doc:{_id:'synthetic-marker'}}]},floor:'42',
    rows:[{id_kind:'string',doc:{_id:'synthetic-marker'}}],clockBefore:[{last_stamp:'42'}],clockAfter:[{last_stamp:'42'}],
    foreignBefore:[],foreignAfter:[],clients:[{transport:'polling',events:[]}],foreignClients:[{transport:'websocket',events:[]}]});
  it('requires actual consumed marker/grant/current-auth preconditions instead of treating a missing pipeline as semantic red',function(){
    oracle.revoked(physical(),()=>{});
    for(const mutate of [p=>p.checkpoint.projection=[],p=>p.grants=[{role_name:'still-reader'}],p=>p.current.denied=true,p=>p.rows=[]]){
      const p=physical();mutate(p);assert.throws(()=>oracle.revoked(p,()=>{}),error=>!(error instanceof assert.AssertionError)&&/CAUSAL_BOUNDARY/.test(error.message));
    }
    assert.throws(()=>oracle.bounded([string],{maxRows:0,maxBytes:10000}),/PROOF_BOUND/);
  });
  it('actual protocol retains a valid socket but removes revoked collections before fanout; missing filter leaks a physical marker',async function(){
    let allowed=true;const socket=new Socket(),current={identity:'synthetic-current'};
    const protocol=protocolFactory.create({admission:{resolve:async()=>A},api:async(operation,body)=>{
      assert.equal(operation,'/authorize');assert.deepEqual(body.credential,{accessToken:'synthetic-signed-port'});
      return {permissions:{read:allowed,write:false,write_treatment:false,ack:false},collections:allowed?['entries']:[]};
    },readCurrent:async()=>current,runtime:()=>({}),maxSockets:4,domains:['entries']});
    try{
      await protocol.prepare(socket);protocol.bind(socket,'/storage');let reply;
      await socket.handlers.subscribe({accessToken:'synthetic-signed-port',collections:['entries']},value=>{reply=value;});
      assert.deepEqual(reply,{success:true,collections:['entries']});allowed=false;
      await protocol.fanout({tenant:A,previous:{rows:[]},next:{identity:current.identity,rows:[{domain:'entries',document:{_id:'synthetic-marker',type:'sgv',sgv:444}}]}});
      const p=physical(),saved=[];p.clients[0].events=socket.events;
      oracle.revoked(p,value=>saved.push(value));
      assert.equal(socket.disconnected,undefined,'valid currently authenticated actor is not an invalid-credential stub');
      assert(saved[0].STORAGE_CURRENT_COLLECTION_REVOKED);
    }finally{protocol.close();}
  });
});
