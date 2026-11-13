'use strict';
const assert=require('node:assert/strict');
const {create}=require('../lib/pgstream/receiver');
const A='11111111-1111-4111-8111-111111111111';
const event=(table,values,action='U')=>({Data:{action,schema:'synthetic',table,columns:Object.entries(values).map(([name,value])=>({name,value})),identity:null}});
describe('pgstream explicit input/output/schema receiver',function(){
 const routes=[{schema:'synthetic',table:'clock',kind:'clock'},{schema:'synthetic',table:'activity',kind:'activity'},{schema:'synthetic',table:'lifecycle',kind:'lifecycle'},{schema:'synthetic',table:'checkpoint',kind:'output'},{schema:'synthetic',table:'heartbeat',kind:'heartbeat'}];
 let observe,inputs,outputs,schemas,heartbeats;
 beforeEach(()=>{observe=[];inputs=[];outputs=[];schemas=[];heartbeats=[];});
 const receiver=extra=>create({routes,store:{consumer:'evaluator-test-completed',observe:async(...args)=>{observe.push(args);}},onInput:async(...args)=>{inputs.push(args);},onOutput:async t=>{outputs.push(t);},onSchema:async value=>{schemas.push(value);},onHeartbeat:async value=>{heartbeats.push(value);},...extra});
 it('does not acknowledge before observed work commits, and does not await clinical computation',async()=>{
   let commit;const durable=new Promise(resolve=>{commit=resolve;});let settled=false;
   const receive=receiver({store:{observe:()=>durable},onInput:()=>new Promise(()=>{})});
   const work=receive(event('clock',{tenant_id:A,last_stamp:'17'})).then(()=>{settled=true;});
   await Promise.resolve();assert.equal(settled,false);commit();await work;assert.equal(settled,true);
 });
 it('refuses failed durable receipt',async()=>{const receive=receiver({store:{observe:async()=>{throw Error('COMMIT_LOST');}}});await assert.rejects(receive(event('clock',{tenant_id:A,last_stamp:'18'})),/COMMIT_LOST/);assert.equal(inputs.length,0);});
 it('routes output/receiver writes without input feedback; ignores another checkpoint consumer',async()=>{
   const receive=receiver();await receive(event('checkpoint',{tenant_id:A,consumer:'evaluator-test-completed'}));await receive(event('checkpoint',{tenant_id:A,consumer:'acquired-only'}));assert.deepEqual(outputs,[A]);assert.equal(inputs.length,0);assert.equal(observe.length,0);
 });
 it('routes actual pgstream.ddl action M to admission revalidation, with irrelevant DDL defined',async()=>{
   const receive=receiver(),message=schema=>({Data:{action:'M',prefix:'pgstream.ddl',content:JSON.stringify({schema_name:schema,objects:[{schema,type:'table'}],ddl:'synthetic schema change'})}});
   assert.equal((await receive(message('synthetic'))).kind,'schema');assert.equal((await receive(message('unrelated'))).kind,'irrelevant-schema');assert.deepEqual(schemas,[['synthetic']]);assert.equal(observe.length,0);
 });
 it('refuses unknown and malformed control events without clinical completion',async()=>{const receive=receiver();await assert.rejects(receive({Data:{action:'M',prefix:'unknown',content:'{}'}}),/CONTROL_UNKNOWN/);await assert.rejects(receive({Data:{action:'M',prefix:'pgstream.ddl',content:'{}'}}),/DDL_SHAPE/);await assert.rejects(receive(event('unknown',{})),/UNROUTED/);});
 it('orders lifecycle suspension and activation with the existing generation; keeps activity eligibility separate',async()=>{
   const receive=receiver();await receive(event('lifecycle',{tenant_id:A,generation:'7',phase:'active'}));await receive(event('lifecycle',{tenant_id:A,generation:'7',phase:'suspended'}));await receive(event('lifecycle',{tenant_id:A,generation:'8',phase:'active'}));await receive(event('activity',{tenant_id:A,version:'9',paused:true,suspended:false}));
   assert.deepEqual(observe.map(args=>args.slice(1)),[['lifecycle','14',true],['lifecycle','15',false],['lifecycle','16',true],['activity','9',false]]);
 });
 it('heartbeat is fixed worker health work and creates no tenant completion',async()=>{await receiver()(event('heartbeat',{id:1,revision:'19'}));assert.deepEqual(heartbeats,[19]);assert.equal(observe.length,0);});
 it('accepts the DBA bootstrap heartbeat at zero without treating it as live delivery',async()=>{await receiver({onHeartbeat:async revision=>assert(revision>0,'bootstrap zero must not acknowledge current liveness')})(event('heartbeat',{id:1,revision:'0'}));});
 it('refuses numeric versions outside JavaScript exact integer range',async()=>{await assert.rejects(receiver()(event('clock',{tenant_id:A,last_stamp:9007199254740992})),/EVENT_VERSION/);});
 it('control: removing the durable await acknowledges before commit; the receipt criterion goes red',async()=>{
   const file=require.resolve('../lib/pgstream/receiver'),fs=require('node:fs'),vm=require('node:vm'),original=fs.readFileSync(file,'utf8');
   const broken=original.replace('await store.observe(', 'store.observe(');assert.notEqual(broken,original);
   const output={exports:{}};vm.runInThisContext('(function(require,module,exports){'+broken+'\n})',{filename:file})(require,output,output.exports);
   let commit;const held=new Promise(resolve=>{commit=resolve;});let committed=false;
   const receive=output.exports.create({routes,store:{observe:()=>held.then(()=>{committed=true;})},onInput:()=>{},onOutput:()=>{},onHeartbeat:()=>{},onSchema:()=>{}});
   await receive(event('clock',{tenant_id:A,last_stamp:'1'}));assert.throws(()=>assert.equal(committed,true),{code:'ERR_ASSERTION'});commit();await held;
 });
});

describe('pgstream deployment routes',function(){it('puts the heartbeat outside the upstream internal schema',function(){const routes=require('../lib/pgstream/evaluator').routes({namespaces:{clock:'test_clock',checkpoint:'test_checkpoint'},trustedWorker:{settings:'test_settings',operatorPolicy:'test_policy',activity:'test_activity'}});assert.equal(routes.find(row=>row.kind==='heartbeat').schema,'test_clock');});});
