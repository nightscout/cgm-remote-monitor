'use strict';
const assert=require('node:assert/strict');
const stream=require('../lib/storage/clinical-stream-state');
const limits={maxRows:10,maxBytes:100000};
const document=(id,value)=>({_id:id,sgv:value,date:1,srvModified:1,extension:{opaque:['kept']}});
const data=(action,doc,lsn='0/20',xid=42)=>({action,xid,lsn,columns:action==='D'?null:[{name:'id_kind',value:'string'},{name:'_id',value:doc._id},{name:'doc',value:doc},{name:'insertion_ordinal',value:1},{name:'storage_bytes',value:100}],identity:[{name:'id_kind',value:'string'},{name:'_id',value:doc._id}]});
const boot=()=>stream.bootstrap(null,{checkpoint:10,signature:{stamp:10,deleted:0},rows:[{domain:'entries',document:document('a',100),ordinal:1,storageBytes:100}]},limits);
const seal=s=>stream.seal(s,{xid:42,lsn:'0/30',floor:11,deleted:0},limits);
describe('durable clinical stream working set',()=>{
 it('exposes a whole cohort only at its clock; preserves extensions and clinical dates independently of commit coverage',()=>{
  const before=boot(),next=stream.stage(before,stream.eventOf('entries',data('U',document('a',120))),limits);
  assert.equal(stream.output(next).rows[0].document.sgv,100);
  const other=stream.stage(next,stream.eventOf('entries',data('I',document('b',130),'0/21')),limits);
  const result=stream.output(seal(other));assert.equal(result.checkpoint,11);assert.equal(result.rows.length,2);
  assert.deepEqual(result.rows[0].document.extension,{opaque:['kept']});assert.equal(result.rows[0].document.date,1);
 });
 it('recovers staged acknowledged rows after JSON/process loss and deduplicates raw redelivery',()=>{
  const event=stream.eventOf('entries',data('U',document('a',120)));
  const accepted=JSON.parse(JSON.stringify(stream.stage(boot(),event,limits)));
  assert.equal(stream.stage(accepted,event,limits).staged.length,1);
  assert.equal(stream.output(seal(accepted)).rows[0].document.sgv,120);
 });
 it('applies delete identities and ignores cohorts already included by consistent bootstrap floor',()=>{
  const staged=stream.stage(boot(),stream.eventOf('entries',data('D',document('a',100))),limits);
  assert.equal(stream.output(seal(staged)).rows.length,0);
  const current=stream.bootstrap(staged,{checkpoint:12,signature:{stamp:12,deleted:12},rows:[]},limits);
  assert.equal(stream.output(seal(current)).checkpoint,12);assert.equal(stream.output(seal(current)).rows.length,0);
 });
 it('merges unchanged TOAST document omission from accepted rows and refuses missing history',()=>{
  const event=data('U',document('a',100));event.columns=event.columns.filter(c=>c.name!=='doc');event.columns.find(c=>c.name==='insertion_ordinal').value=2;
  const result=stream.output(seal(stream.stage(boot(),stream.eventOf('entries',event),limits)));
  assert.equal(result.rows[0].document.sgv,100);assert.equal(result.rows[0].ordinal,2);
  event.identity[1].value='missing';event.columns.find(c=>c.name==='_id').value='missing';
  assert.throws(()=>seal(stream.stage(boot(),stream.eventOf('entries',event),limits)),/MISSING_HISTORY/);
 });
 it('does not consume another XID and retains unfinished input when a newer completed cohort seals',()=>{
  let state=stream.stage(boot(),stream.eventOf('entries',data('U',document('a',120),'0/20',41)),limits);
  state=stream.stage(state,stream.eventOf('entries',data('I',document('b',130),'0/21',42)),limits);
  const result=seal(state);assert.equal(result.staged.length,1);assert.equal(stream.output(result).rows.find(r=>r.document._id==='a').document.sgv,100);
 });
 it('retains invalid physical rows for stored-byte statistics and later updates while excluding them from clinical output',()=>{
  const state=stream.bootstrap(null,{checkpoint:10,signature:{stamp:10,deleted:0},rows:[{domain:'entries',document:{...document('a',100),isValid:false},ordinal:1,storageBytes:80}]},limits);
  assert.equal(state.rows.length,1);assert.equal(stream.output(state).rows.length,0);assert.equal(stream.output(state).stats.dataSize,80);
 });
 it('persists a bounded explicit recovery gap without certifying clinical completion, then clears it only on a consistent snapshot',()=>{
  const before=boot(),gap=stream.recoverableGap(before,'CLINICAL_STREAM_ROW_BOUND','0/40',limits);
  assert.equal(gap.ready,false);assert.deepEqual(gap.rows,before.rows);assert.equal(gap.floor,before.floor);assert.equal(gap.staged.length,0);
  assert.throws(()=>stream.output(JSON.parse(JSON.stringify(gap))),/BOOTSTRAP_REQUIRED/);
  const recovered=stream.bootstrap(gap,{checkpoint:12,signature:{stamp:12,deleted:12},rows:[]},limits);
  assert.equal(recovered.gap,undefined);assert.equal(stream.output(recovered).checkpoint,12);
 });
 it('refuses malformed identity, missing transaction identity and oversized durable state',()=>{
  assert.throws(()=>stream.eventOf('entries',{...data('I',document('a',1)),xid:undefined}),/XID/);
  assert.throws(()=>stream.eventOf('entries',{...data('D',document('a',1)),identity:[]}),/IDENTITY/);
  assert.throws(()=>stream.stage(boot(),stream.eventOf('entries',data('I',document('b',1))),{...limits,maxBytes:10}),/BYTE_BOUND/);
 });
 it('control: early row publication fails the coherent cohort oracle; restored path passes',()=>{
  const check=state=>assert.equal(stream.output(state).rows[0].document.sgv,100,'UNSEALED_COHORT_VISIBLE');
  const staged=stream.stage(boot(),stream.eventOf('entries',data('U',document('a',120))),limits);check(staged);
  const broken=structuredClone(staged);broken.rows[0]=staged.staged[0].row;
  assert.throws(()=>check(broken),/UNSEALED_COHORT_VISIBLE/);check(staged);
 });
});
