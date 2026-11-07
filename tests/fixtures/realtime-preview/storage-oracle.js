'use strict';
const assert=require('node:assert/strict');
const normalize=require('../../../lib/api3/storage/mongoCollection/utils').normalizeDoc;
const {decodeDocument}=require('../../../lib/storage/postgres-identity');
function single(event,row){
  const doc=decodeDocument(row);normalize(doc);const sent=[];
  const socket=new(require('../../../lib/api3/storageSocket'))({},{},{});
  socket.namespace={to:()=>({emit:(kind,value)=>sent.push({event:kind,value})})};
  const payload=event==='delete'?{colName:'entries',identifier:doc.identifier}:{colName:'entries',doc};
  socket['emit'+event[0].toUpperCase()+event.slice(1)](payload);
  return JSON.parse(JSON.stringify(sent[0]));
}
function bounded(value,{maxRows,maxBytes}){
  if(Array.isArray(value)&&value.length>maxRows||Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new Error('STORAGE_PROOF_BOUND');
  return value;
}
function verdict(label,physical,record,verify){
  record({[label]:physical});
  try{return verify();}catch(error){if(error instanceof assert.AssertionError)record({semanticFailure:{name:'AssertionError',code:'ERR_ASSERTION',message:label}});throw error;}
}
function typed(physical,expected,record){
  return verdict('STORAGE_CONNECTED_TYPED_'+physical.stage.toUpperCase(),physical,record,()=>{
    assert.deepEqual(physical.clockAfter,physical.clockBefore,'STORAGE_QUIET_CLOCK_UNCHANGED');
    assert.deepEqual(physical.foreignAfter,physical.foreignBefore,'STORAGE_FOREIGN_PHYSICAL_UNCHANGED');
    assert.deepEqual(physical.twins.map(row=>[row.id_kind,row.doc.sgv]).sort(),expected.twins.map(row=>[row.id_kind,row.doc.sgv]).sort(),'STORAGE_TYPED_PHYSICAL_IDENTITY');
    for(const client of physical.clients){
      const order=(a,b)=>a.event.localeCompare(b.event)||Number(a.value.doc?.sgv||0)-Number(b.value.doc?.sgv||0);
      const actual=client.events.filter(row=>(row.value.doc?.identifier||row.value.identifier)===physical.id).sort(order);
      assert.deepEqual(actual,[...expected.events].sort(order),'STORAGE_CONNECTED_TYPED_WIRE '+physical.stage+' '+client.transport);
    }
    for(const client of physical.foreignClients)assert.deepEqual(client.events,[],'STORAGE_FOREIGN_WIRE_UNCHANGED');
  });
}
function revoked(physical,record){
  const marker=physical.checkpoint?.projection?.some(row=>row.domain==='entries'&&row.id_kind==='string'&&row.doc._id===physical.marker);
  return verdict('STORAGE_CURRENT_COLLECTION_REVOKED',physical,record,()=>{
  if(!marker||String(physical.checkpoint.checkpoint)!==String(physical.floor)||physical.grants.length!==0||
    physical.current.denied||!Array.isArray(physical.current.collections)||physical.current.collections.length!==0||physical.current.permissions?.read!==false||
    !physical.rows.some(row=>row.id_kind==='string'&&row.doc._id===physical.marker))throw new Error('STORAGE_REVOCATION_CAUSAL_BOUNDARY_REQUIRED');
    assert.deepEqual(physical.clockAfter,physical.clockBefore,'STORAGE_REVOCATION_CLOCK_UNCHANGED');
    assert.deepEqual(physical.foreignAfter,physical.foreignBefore,'STORAGE_REVOCATION_FOREIGN_UNCHANGED');
    for(const client of physical.clients)assert.deepEqual(client.events,[],'STORAGE_CURRENT_COLLECTION_REVOKED '+client.transport);
    for(const client of physical.foreignClients)assert.deepEqual(client.events,[],'STORAGE_REVOCATION_FOREIGN_WIRE_UNCHANGED');
  });
}
module.exports={single,bounded,typed,revoked};
