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
 it('deduplicates persisted JSONB key order while retaining distinct equal-LSN rows',()=>{
  const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)])):value;
  const event=stream.eventOf('entries',data('U',document('a',120))),saved=normalize(stream.stage(boot(),event,limits));
  const check=module=>{const next=module.stage(saved,event,limits);assert.equal(next.staged.length,1,'JSONB_REPLAY_DUPLICATES_COHORT');assert.equal(next,saved,'REPLAY_MUST_KEEP_DURABLE_STATE');};
  const control=require('./lib/clinical-working-set/control');
  const broken=control('../lib/storage/clinical-stream-state','isDeepStrictEqual(receiptEvent(previous),receiptEvent(event))','JSON.stringify(previous)===JSON.stringify(event)');
  assert.throws(()=>check(broken),/JSONB_REPLAY_DUPLICATES_COHORT/);check(stream);
  const other=stream.eventOf('entries',data('I',document('b',130)));
  assert.equal(stream.stage(saved,other,limits).staged.length,2,'DISTINCT_COPY_ROW_MUST_SURVIVE');
 });
 it('deduplicates sparse unchanged-TOAST receipt after JSON drops absent columns',()=>{
  const value=data('U',document('a',100));value.columns=value.columns.filter(c=>!['doc','insertion_ordinal','storage_bytes'].includes(c.name));
  const check=module=>{const event=module.eventOf('entries',value),saved=JSON.parse(JSON.stringify(module.stage(boot(),event,{...limits,maxRows:1})));assert.equal(module.stage(saved,event,{...limits,maxRows:1}),saved,'SPARSE_REPLAY_MUST_KEEP_RECEIPT');};
  // Historical replay also normalizes absent columns. Removing only the new
  // event normalization is now harmless; the next case controls that boundary.
  check(stream);
 });
 it('replays pending sparse receipts persisted before optional-column normalization',()=>{
  const value=data('U',document('a',100));value.columns=value.columns.filter(c=>!['doc','insertion_ordinal','storage_bytes'].includes(c.name));
  const event=stream.eventOf('entries',value),legacy={...event,row:{...event.row,ordinal:undefined,storageBytes:undefined}};
  const saved=JSON.parse(JSON.stringify(stream.stage(boot(),legacy,{...limits,maxRows:1})));
  const check=module=>assert.equal(module.stage(saved,event,{...limits,maxRows:1}),saved,'HISTORICAL_PENDING_RECEIPT_MUST_REPLAY');
  const broken=require('./lib/clinical-working-set/control')('../lib/storage/clinical-stream-state','isDeepStrictEqual(receiptEvent(previous),receiptEvent(event))','isDeepStrictEqual(previous,event)');
  assert.throws(()=>check(broken),/CLINICAL_STREAM_ROW_BOUND/);check(stream);
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
 it('applies the same exact byte bound to full state and a receipt with rows omitted',()=>{
  const full=boot(),bytes=Buffer.byteLength(JSON.stringify(full)),metadata={...full};delete metadata.rows;
  assert.throws(()=>stream.bound(metadata,{...limits,maxBytes:bytes-1}),/BYTE_BOUND/);
  stream.bound(metadata,{...limits,maxBytes:bytes});stream.bound(full,{...limits,maxBytes:bytes});
 });
 it('fits a durable gap marker even when the last sealed cache filled the exact byte cap',()=>{
  const full=boot(),bytes=Buffer.byteLength(JSON.stringify(full));
  const gap=stream.recoverableGap(full,'CLINICAL_STREAM_BYTE_BOUND','FFFFFFFF/FFFFFFFF',{...limits,maxBytes:bytes});
  assert.equal(gap.ready,false);assert.deepEqual(gap.rows,[]);assert(Buffer.byteLength(JSON.stringify(gap))<=bytes);
 });
 it('persists a bounded explicit recovery gap without certifying clinical completion, then clears it only on a consistent snapshot',()=>{
  const before=boot(),gap=stream.recoverableGap(before,'CLINICAL_STREAM_ROW_BOUND','0/40',limits);
  assert.equal(gap.ready,false);assert.deepEqual(gap.rows,[]);assert.equal(gap.floor,undefined);assert.equal(gap.staged.length,0);
  assert.throws(()=>stream.output(JSON.parse(JSON.stringify(gap))),/BOOTSTRAP_REQUIRED/);
  const recovered=stream.bootstrap(gap,{checkpoint:12,signature:{stamp:12,deleted:12},rows:[]},limits);
  assert.equal(recovered.gap,undefined);assert.equal(stream.output(recovered).checkpoint,12);
 });
 it('refuses malformed identity, missing transaction identity and oversized durable state',()=>{
  assert.throws(()=>stream.eventOf('entries',{...data('I',document('a',1)),xid:undefined}),/XID/);
  assert.throws(()=>stream.eventOf('entries',{...data('D',document('a',1)),identity:[]}),/IDENTITY/);
  assert.throws(()=>stream.stage(boot(),stream.eventOf('entries',data('I',document('b',1))),{...limits,maxBytes:10}),/BYTE_BOUND/);
 });
 it('keeps frozen prior envelopes, rows, extensions and pending cohorts unchanged through every transition',()=>{
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const before=freeze(boot()),original=JSON.stringify(before);
  const staged=freeze(stream.stage(before,stream.eventOf('entries',data('U',{...document('a',120),extension:{unicode:'雪😀\\\"\n'}})),limits));
  const stagedJSON=JSON.stringify(staged),sealed=seal(staged);
  assert.equal(JSON.stringify(before),original);assert.equal(JSON.stringify(staged),stagedJSON);
  assert.equal(sealed.rows[0].doc.sgv,120);assert.equal(before.rows[0].doc.sgv,100);
  const snapshot={checkpoint:12,signature:{stamp:12,deleted:0},rows:[]};
  stream.bootstrap(staged,snapshot,limits);assert.equal(JSON.stringify(staged),stagedJSON);
  for(const value of [sealed,stream.bootstrap(staged,snapshot,limits)]){
   const bytes=Buffer.byteLength(JSON.stringify(value));
   assert.throws(()=>stream.bound(value,{...limits,maxBytes:bytes-1}),/BYTE_BOUND/);
   stream.bound(value,{...limits,maxBytes:bytes});
   assert.throws(()=>stream.bound(value,{...limits,maxBytes:bytes-1},value.rowBytes),/BYTE_BOUND/);
   stream.bound(value,{...limits,maxBytes:bytes},value.rowBytes);
  }
  const control=require('./lib/clinical-working-set/control');
  const broken=control('../lib/storage/clinical-stream-state','function stage(saved,event,limits){\n const state={...(saved||empty())};','function stage(saved,event,limits){\n const state=saved||empty();');
  assert.throws(()=>broken.stage(before,stream.eventOf('entries',data('I',document('b',130))),limits),TypeError);
  stream.stage(before,stream.eventOf('entries',data('I',document('b',130))),limits);
 });
 it('control: early row publication fails the coherent cohort oracle; restored path passes',()=>{
  const check=state=>assert.equal(stream.output(state).rows[0].document.sgv,100,'UNSEALED_COHORT_VISIBLE');
  const staged=stream.stage(boot(),stream.eventOf('entries',data('U',document('a',120))),limits);check(staged);
  const broken=structuredClone(staged);broken.rows[0]=staged.staged[0].row;
  assert.throws(()=>check(broken),/UNSEALED_COHORT_VISIBLE/);check(staged);
 });
});
