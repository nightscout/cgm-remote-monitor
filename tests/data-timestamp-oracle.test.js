'use strict';
const assert=require('node:assert/strict'),oracle=require('./fixtures/realtime-preview/data-timestamps');
const t=Date.UTC(2026,10,7,12),clone=value=>structuredClone(value);
function operation(){
  const producer={collection:'entries',data:{_id:'synthetic-entry',type:'sgv',sgv:123,nested:{created_at:'client-nested',srvModified:t-1000}}};
  const doc=(at)=>({...clone(producer.data),created_at:new Date(at).toISOString(),srvCreated:at,srvModified:at});
  const mongo=doc(t+1),pg=doc(t+101);
  return {logical:'entries',producer,before:{mongoRaw:[],pgDocuments:[]},mongoRaw:[clone(mongo)],pgDocuments:[clone(pg)],
    expected:{outcome:'reply',args:[[clone(mongo)]]},actual:{outcome:'reply',args:[[clone(pg)]]},
    windows:{mongo:{startedAt:t,finishedAt:t+10},postgres:{startedAt:t+100,finishedAt:t+110}},
    clocks:{mongo:{kind:'mongo',observed:0,upper:0},postgres:{kind:'postgres',before:t+90,after:t+101}}};
}
function setPg(op,key,value){op.pgDocuments[0][key]=value;op.actual.args[0][0][key]=value;}
describe('six-domain socket timestamp/physical oracle',function(){
  it('allows only independently proved top-level generated clock differences',function(){oracle.compare(operation());});
  for(const kind of ['missing','invalid','outside'])it('rejects generated created_at '+kind,function(){
    const op=operation();if(kind==='missing'){delete op.pgDocuments[0].created_at;delete op.actual.args[0][0].created_at;}
    else setPg(op,'created_at',kind==='invalid'?'not-ISO':new Date(t-1).toISOString());
    assert.throws(()=>oracle.compare(op),/DATA_CREATED_AT|DATA_GENERATED_CREATED_AT/);
  });
  it('preserves explicit producer created_at and nested timestamp/BSON date types exactly',function(){
    const op=operation(),client='2001-01-01T00:00:00.000Z';op.producer.data.created_at=client;
    op.mongoRaw[0].created_at=client;op.expected.args[0][0].created_at=client;setPg(op,'created_at',client);oracle.compare(op);
    const wrong='2002-01-01T00:00:00.000Z';op.mongoRaw[0].created_at=wrong;op.expected.args[0][0].created_at=wrong;setPg(op,'created_at',wrong);
    assert.throws(()=>oracle.compare(op),/DATA_CLIENT_CREATED_AT/);op.mongoRaw[0].created_at=client;op.expected.args[0][0].created_at=client;setPg(op,'created_at',client);
    op.pgDocuments[0].nested.srvModified++;op.actual.args[0][0].nested.srvModified++;assert.throws(()=>oracle.compare(op),/DATA_CALLBACK_PARITY/);
    const typed=operation();typed.mongoRaw[0].nested.date=new Date(t);typed.expected.args[0][0].nested.date=new Date(t).toISOString();
    typed.pgDocuments[0].nested.date=new Date(t).toISOString();typed.actual.args[0][0].nested.date=new Date(t).toISOString();
    assert.throws(()=>oracle.compare(typed),/DATA_PHYSICAL_PARITY/);
  });
  it('validates server date allocation, order and exact reply-to-own-physical agreement',function(){
    for(const mutate of [op=>setPg(op,'srvCreated',NaN),op=>setPg(op,'srvCreated',t+102),
      op=>{setPg(op,'srvCreated',t+105);setPg(op,'srvModified',t+105);},op=>op.actual.args[0][0].srvModified++,
      op=>{op.mongoRaw[0].srvCreated=t+1000;op.mongoRaw[0].srvModified=t+1000;op.expected.args[0][0]={...op.mongoRaw[0]};}]){
      const op=operation();mutate(op);assert.throws(()=>oracle.compare(op),/DATA_SERVER_TIMESTAMP|DATA_PG_|DATA_REPLY_OWN|DATA_MONGO_/);
    }
  });
  it('carries generic duplicate state from a previously verified operation, acknowledging an empty array',function(){
    const first=operation(),previous=oracle.compare(first),next=operation();next.previous=previous;
    next.before={mongoRaw:clone(first.mongoRaw),pgDocuments:clone(first.pgDocuments)};next.mongoRaw=clone(first.mongoRaw);next.pgDocuments=clone(first.pgDocuments);
    next.expected={outcome:'reply',args:[[]]};next.actual={outcome:'reply',args:[[]]};
    next.windows={mongo:{startedAt:t+200,finishedAt:t+210},postgres:{startedAt:t+300,finishedAt:t+310}};
    next.clocks={mongo:previous.mongo.clock,postgres:{kind:'postgres',before:t+101,after:t+310}};oracle.compare(next);
    next.pgDocuments[0].created_at=new Date(t+301).toISOString();assert.throws(()=>oracle.compare(next),/DATA_DUPLICATE_PHYSICAL_UNCHANGED/);
  });
  it('activity keeps client server-looking fields instead of silently treating them as server clocks',function(){
    const op=operation();op.logical='activity';op.producer.collection='activity';op.producer.data.srvCreated=t-100;op.producer.data.srvModified='client-owned';
    for(const doc of [...op.mongoRaw,...op.pgDocuments,op.expected.args[0][0],op.actual.args[0][0]]){doc.srvCreated=t-100;doc.srvModified='client-owned';}
    oracle.compare(op);setPg(op,'srvCreated',t-99);assert.throws(()=>oracle.compare(op),/DATA_ACTIVITY_CLIENT_TIMESTAMP/);
  });
  it('replays captured JSON with explicit Date/ObjectId paths and rejects altered clock-chain/type evidence',function(){
    const op=operation();op.pgRaw=op.pgDocuments.map(doc=>({id_kind:'string',doc}));
    const row=oracle.capture(op),state=oracle.initialState();oracle.replay(JSON.parse(JSON.stringify(row)),state);
    const bad=clone(row);bad.clocks.mongo.upper++;assert.throws(()=>oracle.replay(bad,oracle.initialState()),/CLOCK_CHAIN/);
    const {ObjectId}=require('mongodb'),value=[{_id:new ObjectId('0123456789abcdef01234567'),date:new Date(t),ordinary:{date:'ordinary-data'}}];
    const tags=oracle.types(value),restored=oracle.restore(JSON.parse(JSON.stringify(value)),tags);
    assert(restored[0]._id instanceof ObjectId);assert(restored[0].date instanceof Date);assert.deepEqual(restored[0].ordinary,{date:'ordinary-data'});
    const changed=JSON.parse(JSON.stringify(value));changed[0].date='2001-01-01T00:00:00.000Z';assert.throws(()=>oracle.restore(changed,tags),/TYPE_VALUE/);
  });
  it('characterizes ALL six actual handler/write-intent first+retry timestamp paths with constrained storage/allocator protocols (not native DB)',async function(){
    const scope=require('../lib/storage/tenant-scope'),srv=require('../lib/server/srv-dates'),old=scope.getTenancyMode(),A='11111111-1111-4111-8111-111111111111';
    const contexts=[0,1].map(()=>{const f=require('./fixtures/socket-forwarding/recording-context').context();
      for(const store of Object.values(f.collections)){const insert=store.insertOne;store.insertOne=function(doc,...args){
        if(store.documents.some(row=>row._id===doc._id))throw Object.assign(new Error('synthetic unique constraint'),{code:11000});return insert.call(this,doc,...args);
      };}return {f,allocator:{active:true,tenant:A,floor:0,next(at){this.floor=Math.max(at,this.floor+1);return this.floor;}}};});
    const now=Date.now(),time=new Date(now).toISOString(),docs={entries:{_id:'entry',type:'sgv',sgv:123,date:now},
      treatments:{_id:'treatment',eventType:'Note',created_at:time,notes:'synthetic'},devicestatus:{_id:'status',device:'synthetic',created_at:time},
      profile:{_id:'profile',NSCLIENT_ID:'synthetic-profile',startDate:time,defaultProfile:'Synthetic',store:{Synthetic:{dia:3}}},
      food:{_id:'food',name:'synthetic',carbs:10},activity:{_id:'activity',type:'activity',created_at:time,duration:10}};
    const wireCall=require('./fixtures/realtime-preview/wire-call'),codec=require('./fixtures/realtime-preview/wire-response');let mongoClock={kind:'mongo',upper:0,observed:0};const replayState=oracle.initialState();
    try{scope.setTenancyMode('multi');
      for(const logical of Object.keys(docs)){let previous;
        for(const attempt of [1,2]){
          const producer={collection:logical,data:clone(docs[logical])},before={mongoRaw:clone(contexts[0].f.collections[logical].documents),pgDocuments:clone(contexts[1].f.collections[logical].documents)},calls=[];
          const beforeFloor=contexts[1].allocator.floor;
          for(const context of contexts){const handlers=require('../lib/server/socket-write-handlers').createHandlers({env:context.f.env,ctx:context.f.ctx,authorizationFor:()=>({read:true,write:true,write_treatment:true})});
            const call=await scope.withTenant(A,()=>srv.withAllocator(context.allocator,()=>wireCall(producer,sent=>new Promise(resolve=>handlers.dbAdd(sent,value=>resolve({outcome:'reply',args:codec.encode([value])}))))));
            assert(call.producerUnchanged);calls.push(call);
          }
          const op={logical,producer,before,previous,expected:calls[0].result,actual:calls[1].result,windows:{mongo:calls[0].window,postgres:calls[1].window},
            clocks:{mongo:mongoClock,postgres:{kind:'postgres',before:beforeFloor,after:contexts[1].allocator.floor}},
            mongoRaw:clone(contexts[0].f.collections[logical].documents),pgDocuments:clone(contexts[1].f.collections[logical].documents)};
          previous=oracle.replay(oracle.capture({...op,pgRaw:op.pgDocuments.map(doc=>({id_kind:'string',doc}))}),replayState);mongoClock=previous.mongo.clock;
          assert.equal(op.mongoRaw.length,1,logical+'/'+attempt+' actual source protocol stores once');
        }
      }
    }finally{contexts.forEach(c=>c.f.ctx.bus.emit('teardown'));scope.setTenancyMode(old);}
  });
});
