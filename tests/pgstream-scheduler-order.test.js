'use strict';
// NS_EVALUATOR_ORDER=oldest-first: a saturated executor serves the work that has
// been owed longest, writes and due alarms on one clock. Control: arrival order
// without the switch (the red state), and an overdue alarm is not starved.
const assert=require('node:assert/strict');
const scheduler=require('../lib/pgstream/activity-scheduler');
const tick=async()=>{for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,8));for(let j=0;j<10;j++)await new Promise(r=>setImmediate(r));}};
function lab({oldestFirst,rows=[]}){
 let release;const held=new Promise(r=>{release=r;});const ran=[];let clock=1000;
 const store={async work(limit,{after}={}){return rows.filter(r=>!after||r.tenant>after).slice(0,limit);},async nextDue(){return null;},async pending(){return [];}};
 const s=scheduler.start({store,oldestFirst,concurrency:1,now:()=>clock,scan:async()=>{},
  run:async(tenant,kind)=>{ran.push([tenant,kind]);if(tenant==='hold')await held;}});
 return {s,ran,release,advance:ms=>{clock+=ms;},names:()=>ran.map(r=>r[0]).filter(t=>t!=='hold')};
}
describe('evaluator saturated ordering',()=>{
 for(const [mode,flag] of [['oldest-first',true],['arrival',false]]){
  it(mode+': recovered pending marks',async()=>{
   const l=lab({oldestFirst:flag,rows:[{tenant:'a',pendingAt:900,nextDueAt:null},{tenant:'b',pendingAt:100,nextDueAt:null},{tenant:'c',pendingAt:500,nextDueAt:null}]});
   try{l.s.wake('hold');await tick();l.s.recover().catch(()=>{});await tick();l.release();await tick();
    assert.deepEqual(l.names(),flag?['b','c','a']:['a','b','c']);}finally{l.release();await l.s.close();}
  });
  it(mode+': an overdue due alarm is not starved behind newer writes',async()=>{
   const l=lab({oldestFirst:flag,rows:[{tenant:'z',pendingAt:null,nextDueAt:50}]});
   try{l.s.wake('hold');await tick();l.s.wake('w1');l.advance(5);l.s.wake('w2');await tick();l.s.recover().catch(()=>{});await tick();l.release();await tick();
    assert.deepEqual(l.names(),flag?['z','w1','w2']:['w1','w2','z']);
    assert(l.ran.some(r=>r[0]==='z'&&r[1]==='due'));}finally{l.release();await l.s.close();}
  });
  it(mode+': a repeated write keeps its place',async()=>{
   const l=lab({oldestFirst:flag});
   try{l.s.wake('hold');await tick();l.s.wake('A');l.advance(1);l.s.wake('B');await tick();l.advance(1);l.s.wake('A');await tick();l.release();await tick();
    assert.deepEqual(l.names(),flag?['A','B']:['B','A']);}finally{l.release();await l.s.close();}
  });
 }
 it('control: a younger write does not jump ahead of an older one (starvation check inverted)',async()=>{
  const l=lab({oldestFirst:true});
  try{l.s.wake('hold');await tick();l.s.wake('old');l.advance(10);l.s.wake('young');await tick();l.release();await tick();assert.deepEqual(l.names(),['old','young']);}finally{l.release();await l.s.close();}
 });
 it('switch parsing: off by default, strict values',()=>{
  assert.equal(scheduler.orderMode({}),false);assert.equal(scheduler.orderMode({NS_EVALUATOR_ORDER:'arrival'}),false);assert.equal(scheduler.orderMode({NS_EVALUATOR_ORDER:'oldest-first'}),true);
  assert.throws(()=>scheduler.orderMode({NS_EVALUATOR_ORDER:'x'}),/NS_EVALUATOR_ORDER/);
 });
});
