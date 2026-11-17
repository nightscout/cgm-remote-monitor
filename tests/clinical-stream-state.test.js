'use strict';
const assert=require('node:assert/strict'),stream=require('../lib/storage/clinical-stream-state');
const native=require('./lib/clinical-stream-native'),control=require('./lib/clinical-working-set/control');
const limits={maxRows:10,maxBytes:100000};
const boot=(rows=[])=>stream.bootstrap(null,{checkpoint:10,signature:{stamp:10,deleted:0},stream:native.boundary,rows},limits);
const events=rows=>rows.map(row=>stream.eventOf('entries',row));
describe('complete native clinical cohorts',()=>{
 it('validates native boundaries/count/indices before accepting any clinical row',()=>{
  const envelope=native.envelope([native.row('a'),native.row('b')]);
  const check=module=>{const partial=structuredClone(envelope);partial.Transaction.splice(1,1);assert.throws(()=>module.validateTransaction(partial,limits),/COVERAGE/,'PARTIAL_NATIVE_COHORT_ACCEPTED');};
  check(stream);
  const broken=control('../lib/storage/clinical-stream-state','commit.transaction_count!==frames.length-2','false');
  const partial=structuredClone(envelope);partial.Transaction.splice(1,1);partial.Transaction[1].transaction_index=1;partial.Transaction[2].transaction_index=2;
  assert.doesNotThrow(()=>broken.validateTransaction(partial,limits));
  assert.throws(()=>stream.validateTransaction(partial,limits),/COVERAGE/);
  assert.equal(stream.validateTransaction(envelope,limits).changes.length,2);
 });
 it('applies distinct same-LSN COPY rows whole and idempotently after JSON loss',()=>{
  const before=boot(),rows=[native.row('a'),native.row('b',130)],original=JSON.stringify(before);
  const next=stream.applyTransaction(before,events(rows),native.coverage('0/30'),limits);
  assert.equal(stream.output(next).rows.length,2);assert.equal(next.floor,11);assert.equal(JSON.stringify(before),original);
  const recovered=JSON.parse(JSON.stringify(next));assert.equal(stream.applyTransaction(recovered,events(rows),native.coverage('0/30'),limits),recovered);
  assert.equal(recovered.rows[0].doc.extension.kept,true);assert.equal(recovered.rows[0].doc.date,1);
 });
 it('uses native commit coverage, not snapshot XIDs or clinical dates, for late corrections and deletes',()=>{
  const created=stream.applyTransaction(boot(),events([native.row('a')]),native.coverage('0/30'),limits);
  const corrected=stream.applyTransaction(created,events([native.row('a',150,'U')]),native.coverage('0/40'),limits);
  assert.equal(stream.output(corrected).rows[0].document.sgv,150);
  assert.equal(stream.output(stream.applyTransaction(corrected,events([native.row('a',0,'D')]),native.coverage('0/50'),limits)).rows.length,0);
 });
 it('keeps delayed raw acceptance independent from recovery snapshot coverage',()=>{
  const recovered=stream.bootstrap(boot(),{checkpoint:11,signature:{stamp:11,deleted:0},stream:{...native.boundary,snapshot_position:'0/80'},rows:[]},limits);
  const next=stream.applyTransaction(recovered,events([native.row('already-covered')]),native.coverage('0/30'),limits);
  assert.equal(next.rows.length,0,'SNAPSHOT_COVERED_ROW_DOUBLE_APPLIED');assert.equal(next.stream.accepted_position,'0/30');assert.equal(next.floor,12);
  assert.equal(stream.applyTransaction(next,events([native.row('new')]),native.coverage('0/90'),limits).rows.length,1);
 });
 it('new source generations begin raw coverage at recovery boundary while same-generation recovery preserves delayed delivery',()=>{
  const before=boot(),same=stream.bootstrap(before,{checkpoint:11,signature:{stamp:11,deleted:0},stream:{...native.boundary,snapshot_position:'0/80'},rows:[]},limits);
  assert.equal(same.stream.accepted_position,'0/10');
  const restored=stream.bootstrap(before,{checkpoint:11,signature:{stamp:11,deleted:0},stream:{...native.boundary,generation:'new-epoch:2',snapshot_position:'0/80'},rows:[]},limits);
  assert.equal(restored.stream.accepted_position,'0/80');
 });
 it('refuses source, slot and restore-generation changes rather than reinterpreting old coverage',()=>{
  for(const patch of [{generation:'2'},{source_identity:{...native.source,system_id:'2'}},{source_identity:{...native.source,slot:'other'}}])assert.throws(()=>stream.applyTransaction(boot(),events([native.row('a')]),{...native.coverage('0/30'),...patch},limits),/SOURCE_FENCE/);
  assert.throws(()=>stream.bootstrap(null,{checkpoint:0,signature:{stamp:0,deleted:0},rows:[]},limits),/GENERATION/);
 });
 it('retains a bounded pending gap and native/raw coverage after clinical overflow',()=>{
  const next=stream.applyTransaction(boot(),events([native.row('a'),native.row('b')]),native.coverage('0/30'),{...limits,maxRows:1});
  assert.equal(next.ready,false);assert.equal(next.gap,'rows');assert.equal(next.floor,11);assert.equal(next.stream.accepted_position,'0/30');assert.throws(()=>stream.output(next),/BOOTSTRAP_REQUIRED/);
  const later=stream.applyTransaction(next,events([native.row('c')]),native.coverage('0/40'),limits);assert.equal(later.ready,false);assert.equal(later.floor,12);
 });
 it('refuses incomplete/oversized/malformed native transport envelopes',()=>{
  assert.throws(()=>stream.validateTransaction({Transaction:[native.row('a')]},limits),/TRANSACTION/);
  assert.throws(()=>stream.validateTransaction(native.envelope([native.row('a'),native.row('b')]),{...limits,maxRows:1}),/ROW_BOUND/);
  assert.throws(()=>stream.validateTransaction(native.envelope([native.row('a')]),{...limits,maxBytes:10}),/BYTE_BOUND/);
  const bad=native.envelope([native.row('a')]);bad.Transaction[1].xid=43;assert.throws(()=>stream.validateTransaction(bad,limits),/COVERAGE/);
 });
 it('retains invalid physical rows and exact state bounds',()=>{
  const invalid={domain:'entries',document:{_id:'a',isValid:false},ordinal:1,storageBytes:100};const next=boot([invalid]);
  assert.equal(stream.output(next).rows.length,0);assert.equal(stream.output(next).stats.dataSize,100);
  const bytes=Buffer.byteLength(JSON.stringify(next));assert.throws(()=>stream.bound(next,{...limits,maxBytes:bytes-1}),/BYTE_BOUND/);stream.bound(next,{...limits,maxBytes:bytes});
 });
});
