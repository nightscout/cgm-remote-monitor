'use strict';
// Oracle for this fixed single-document dbAdd/retry cohort. No product clocks or
// packets are changed. Only proved TOP-LEVEL server fields may differ by backend.
const assert=require('node:assert/strict'),profile=require('./profile-timestamps');
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const MODES={entries:'generic',food:'generic',activity:'generic',treatments:'unchanged',devicestatus:'unchanged',profile:'replace'};
function canonical(value){
  if(value?._bsontype==='ObjectId')return {objectId:value.toHexString()};
  if(value instanceof Date)return {date:value.toISOString()};
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,canonical(item)]));
  return value;
}
function instant(value,label){assert(Number.isSafeInteger(value)&&value>=0&&Number.isFinite(new Date(value).getTime()),label);return value;}
function windowValid(window){assert(window&&Number.isSafeInteger(window.startedAt)&&Number.isSafeInteger(window.finishedAt)&&window.startedAt<=window.finishedAt,'DATA_OPERATION_WINDOW');}
function iso(value,window){const n=typeof value==='string'?Date.parse(value):NaN;assert(Number.isFinite(n)&&new Date(n).toISOString()===value,'DATA_GENERATED_CREATED_AT_INVALID');assert(n>=window.startedAt&&n<=window.finishedAt,'DATA_GENERATED_CREATED_AT_OUTSIDE_CALL');}
const wire=value=>JSON.parse(JSON.stringify(value));
function side({logical,producer,before,after,reply,window,clock,previous}){
  assert(own(MODES,logical),'DATA_TIMESTAMP_DOMAIN');windowValid(window);
  assert(Array.isArray(before)&&before.length<=1&&Array.isArray(after)&&after.length===1,'DATA_SINGLE_STORED_RECORD');
  if(before.length){assert(previous,'DATA_PREVIOUS_VERIFIED_STATE_REQUIRED');assert.deepEqual(canonical(before),previous.after,'DATA_BEFORE_STATE_CHANGED');}
  else assert(!previous,'DATA_PREVIOUS_STATE_LOST');
  const stored=after[0],prior=before[0],unchanged=!!prior&&MODES[logical]!=='replace',stamped=logical!=='activity';
  if(unchanged)assert.deepEqual(canonical(stored),canonical(prior),'DATA_DUPLICATE_PHYSICAL_UNCHANGED');
  const generated=!own(producer.data,'created_at');
  assert(own(stored,'created_at'),'DATA_CREATED_AT_MISSING');
  if(generated){if(!unchanged)iso(stored.created_at,window);else assert.deepEqual(stored.created_at,prior.created_at,'DATA_GENERATED_CREATED_AT_CARRIED');}
  else assert.deepEqual(canonical(stored.created_at),canonical(producer.data.created_at),'DATA_CLIENT_CREATED_AT_PRESERVED');
  let upper=clock.upper,observed=clock.observed;
  if(clock.kind==='mongo'){
    instant(clock.upper,'DATA_MONGO_CLOCK_UPPER');instant(clock.observed,'DATA_MONGO_OBSERVED_FLOOR');
    // A dedicated fresh reference child has no other writers. Each one-doc call
    // can allocate at most one stamp, including a duplicate insert's burnt tick.
    upper=Math.max(window.finishedAt,clock.upper+(stamped?1:0));
  }else{
    assert.equal(clock.kind,'postgres');instant(clock.before,'DATA_PG_CLOCK_BEFORE');instant(clock.after,'DATA_PG_CLOCK_AFTER');assert(clock.after>=clock.before,'DATA_PG_CLOCK_REWOUND');
  }
  if(stamped){
    for(const key of ['srvCreated','srvModified'])instant(stored[key],'DATA_SERVER_TIMESTAMP_INVALID_'+key);
    assert(stored.srvCreated<=stored.srvModified,'DATA_SERVER_TIMESTAMP_ORDER');
    if(clock.kind==='postgres')assert(stored.srvModified<=clock.after,'DATA_PG_STORED_STAMP_ABOVE_FLOOR');
    if(prior)assert.equal(stored.srvCreated,prior.srvCreated,'DATA_SERVER_CREATION_CARRIED');
    else assert.equal(stored.srvCreated,stored.srvModified,'DATA_SERVER_NEW_CREATION_EQUALS_MODIFICATION');
    if(!unchanged){
      const stamp=stored.srvModified;assert(stamp>=window.startedAt,'DATA_SERVER_TIMESTAMP_BEFORE_CALL');
      if(clock.kind==='mongo'){assert(stamp>clock.observed&&stamp<=upper,'DATA_MONGO_SERVER_TIMESTAMP_OUTSIDE_ALLOCATION');}
      else assert(stamp>clock.before&&stamp<=clock.after,'DATA_PG_SERVER_TIMESTAMP_OUTSIDE_ALLOCATION');
    }
    if(clock.kind==='mongo')observed=Math.max(clock.observed,stored.srvModified);
  }else for(const key of ['srvCreated','srvModified']){
    assert.equal(own(stored,key),own(producer.data,key),'DATA_ACTIVITY_CLIENT_TIMESTAMP_PRESENCE');
    assert.deepEqual(canonical(stored[key]),canonical(producer.data[key]),'DATA_ACTIVITY_CLIENT_TIMESTAMP_PRESERVED');
  }
  assert.equal(reply.outcome,'reply','DATA_CANONICAL_CALLBACK_REQUIRED');assert(Array.isArray(reply.args)&&reply.args.length===1&&Array.isArray(reply.args[0]),'DATA_CALLBACK_SHAPE');
  const empty=unchanged&&MODES[logical]==='generic';assert.equal(reply.args[0].length,empty?0:1,'DATA_CALLBACK_DOCUMENT_COUNT');
  if(!empty)assert.deepEqual(canonical(reply.args[0][0]),canonical(wire(stored)),'DATA_REPLY_OWN_PHYSICAL_DOCUMENT');
  function normalize(doc){const value=canonical(doc);if(generated)value.created_at={oracle:'verified-generated-or-carried-created-at'};
    if(stamped)for(const key of ['srvCreated','srvModified'])value[key]={oracle:'verified-server-allocation'};
    return value;}
  return {after:canonical(after),normalized:after.map(normalize),reply:{outcome:reply.outcome,args:empty?[[]]:[[normalize(reply.args[0][0])]]},clock:{kind:'mongo',upper,observed}};
}
function compare(operation){
  const mongo=side({logical:operation.logical,producer:operation.producer,before:operation.before.mongoRaw,after:operation.mongoRaw,reply:operation.expected,
    window:operation.windows.mongo,clock:operation.clocks.mongo,previous:operation.previous?.mongo});
  const postgres=side({logical:operation.logical,producer:operation.producer,before:operation.before.pgDocuments,after:operation.pgDocuments,reply:operation.actual,
    window:operation.windows.postgres,clock:operation.clocks.postgres,previous:operation.previous?.postgres});
  if(operation.logical==='profile')profile.compare({...operation,expected:operation.expected.args,actual:operation.actual.args});
  else {assert.deepEqual(postgres.reply,mongo.reply,'DATA_CALLBACK_PARITY_VERIFIED_CLOCKS');assert.deepEqual(postgres.normalized,mongo.normalized,'DATA_PHYSICAL_PARITY_VERIFIED_CLOCKS');}
  return {mongo,postgres};
}
// Captured JSON alone erases BSON Date/ObjectId distinctions. Record only their
// typed paths alongside raw physical rows; ordinary user object keys stay data.
function types(value,path=[],out=[]){
  if(value?._bsontype==='ObjectId'){out.push({path,kind:'objectid',value:value.toHexString()});return out;}
  if(value instanceof Date){out.push({path,kind:'date',value:value.toISOString()});return out;}
  if(value&&typeof value==='object')for(const [key,item] of Object.entries(value))types(item,[...path,Array.isArray(value)?Number(key):key],out);
  return out;
}
function restore(value,descriptors){
  assert(Array.isArray(descriptors),'DATA_CAPTURE_TYPES_REQUIRED');let result=wire(value);const seen=new Set();
  for(const item of descriptors){
    assert(item&&Array.isArray(item.path)&&['date','objectid'].includes(item.kind),'DATA_CAPTURE_TYPE_INVALID');
    const key=JSON.stringify(item.path);assert(!seen.has(key),'DATA_CAPTURE_TYPE_DUPLICATE');seen.add(key);
    let parent=result;
    for(const part of item.path.slice(0,-1)){assert(parent&&typeof parent==='object'&&own(parent,part),'DATA_CAPTURE_TYPE_PATH');parent=parent[part];}
    const leaf=item.path.at(-1);assert(item.path.length&&parent&&own(parent,leaf)&&parent[leaf]===item.value,'DATA_CAPTURE_TYPE_VALUE');
    let restored;
    if(item.kind==='date'){restored=new Date(item.value);assert(Number.isFinite(restored.getTime())&&restored.toISOString()===item.value,'DATA_CAPTURE_DATE_INVALID');}
    else{assert(/^[a-f0-9]{24}$/.test(item.value),'DATA_CAPTURE_OBJECTID_INVALID');restored=new(require('mongodb').ObjectId)(item.value);}
    Object.defineProperty(parent,leaf,{value:restored,writable:true,enumerable:true,configurable:true});
  }
  return result;
}
function capture(row){
  const decoded=row.pgRaw.map(require('../../../lib/storage/postgres-identity').decodeDocument);
  const {previous,...captured}=row; void previous;
  return wire({...captured,physicalTypes:{beforeMongo:types(row.before.mongoRaw),beforePostgres:types(row.before.pgDocuments),
    mongo:types(row.mongoRaw),postgres:types(decoded)}});
}
function initialState(){return {previous:{},mongoClock:{kind:'mongo',upper:0,observed:0}};}
function replay(row,state){
  assert(state&&state.previous&&state.mongoClock&&row.physicalTypes,'DATA_CAPTURE_REPLAY_STATE_REQUIRED');
  assert.deepEqual(row.clocks.mongo,state.mongoClock,'DATA_CAPTURE_MONGO_CLOCK_CHAIN');
  row.pgRaw.forEach(require('../../../lib/storage/postgres-identity').decodeDocument);
  const typed=row.physicalTypes;
  const before={mongoRaw:restore(row.before.mongoRaw,typed.beforeMongo),pgDocuments:restore(row.before.pgDocuments,typed.beforePostgres)};
  const pgDocuments=restore(row.pgRaw.map(item=>item.doc),typed.postgres),mongoRaw=restore(row.mongoRaw,typed.mongo);
  for(let i=0;i<pgDocuments.length;i++)assert.equal(pgDocuments[i]._id?._bsontype==='ObjectId'?'objectid':'string',row.pgRaw[i].id_kind,'DATA_CAPTURE_PG_ID_KIND');
  const verified=compare({...row,before,pgDocuments,mongoRaw,previous:state.previous[row.logical]});
  state.previous[row.logical]=verified;state.mongoClock=verified.mongo.clock;return verified;
}
module.exports={compare,side,canonical,iso,types,restore,capture,initialState,replay};
