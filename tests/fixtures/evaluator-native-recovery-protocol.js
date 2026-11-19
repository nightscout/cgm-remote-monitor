'use strict';
// Recording ports for tests of preview composition, never native SQL or a
// snapshot substitute. Any clinical source read or receipt effect refuses.
const assert=require('node:assert/strict');
const generation='a'.repeat(32);
function document(pgstream={},options={}){
 return {...pgstream,generation,transactionRows:pgstream.transactionRows??10000,
  recovery:{connectionEnv:options.connectionEnv??'SNAPSHOT_EXPORT_PG',timeoutMs:1000,maxQueued:1}};
}
function config(pgstream={}){
 return {...pgstream,generation,transactionRows:pgstream.transactionRows??10000,slot:pgstream.slot??'synthetic_stream',
  recovery:{connectionString:'synthetic',timeoutMs:1000,maxQueued:1},receiver:{maxBytes:10000,...pgstream.receiver}};
}
function replay({events=[]}={}){
 return {configureStream(binding){assert.equal(typeof binding.generation,'function');assert.equal(typeof binding.assertFence,'function');assert.equal(binding.expectedSource.system_id,'123');events.push('native-configured');},
  async invalidateStream(){events.push('native-invalidated');},async acceptTransaction(){throw new Error('CLINICAL_TRANSACTION_OUTSIDE_BOOT_PROTOCOL');}};
}
function mocks({events=[]}={}){
 class Client{
  constructor(options){assert.equal(options.replication,'database');this.closed=false;events.push('identify-created');}
  async connect(){assert.equal(this.closed,false);events.push('identify-connected');}
  async query(text){assert.equal(text,'IDENTIFY_SYSTEM','BOOT_PROTOCOL_MUST_NOT_FAKE_SOURCE_READS');return {rows:[{systemid:'123',timeline:1,dbname:'synthetic'}]};}
  async end(){if(!this.closed){this.closed=true;events.push('identify-closed');}}
 }
 return {'pg':{Client},'../../pgstream/snapshot-recovery':{create(options){
  assert.equal(options.mainSource.system_id,'123');assert.equal(typeof options.connection,'object');assert.equal(typeof options.generation,'function');events.push('native-recovery-created');let closed=false;
  return {lockKey:()=>'123',async close(){if(!closed){closed=true;events.push('native-recovery-closed');}},async withSnapshot(){throw new Error('CLINICAL_SNAPSHOT_OUTSIDE_BOOT_PROTOCOL');}};
 }},'../../pgstream/receipt-authority':{create(options){assert.equal(typeof options.namespace,'string');assert.equal(options.generation,generation);assert.equal(typeof options.available,'function');return async()=>{throw new Error('CLINICAL_RECEIPT_OUTSIDE_BOOT_PROTOCOL');};}}};
}
module.exports={document,config,replay,mocks};
