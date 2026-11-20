'use strict';
const assert=require('node:assert/strict');
const journal=require('../lib/storage/storage-event-journal');
const {encodeDocument}=require('../lib/storage/postgres-identity');
const control=require('./lib/clinical-working-set/control');
const limits={maxRows:8,maxBytes:12000};
function columns(doc){return Object.entries(encodeDocument(doc)).map(([name,value])=>({name,type:name==='doc'?'jsonb':'text',value:name==='doc'?JSON.stringify(value):value}));}
function event(action,after,before,lsn='0/20'){return {action,xid:7,lsn,columns:after?columns(after):null,identity:before?columns(before):null};}
const doc={_id:'synthetic-old',identifier:'public-id',date:1,extension:{kept:true}};
describe('bounded raw storage mutation journal',()=>{
 it('preserves old/out-of-window food/activity CRUD, explicit identifiers, order, equal-LSN rows and duplicate replay',()=>{
  let tail=journal.empty();
  for(const domain of ['entries','food','activity'])tail=journal.append(tail,domain,event('I',doc),limits);
  assert.deepEqual(tail.events.map(e=>e.domain),['entries','food','activity']);
  const replay=journal.append(tail,'activity',event('I',doc),limits);assert.strictEqual(replay,tail);
  tail=journal.append(tail,'food',event('U',{...doc,extension:{kept:'corrected'}},doc,'0/21'),limits);
  tail=journal.append(tail,'activity',event('D',null,doc,'0/22'),limits);
  assert.deepEqual(tail.events.map(e=>e.event),['create','create','create','update','delete']);
  assert.equal(tail.events.at(-1).value.identifier,'public-id');
  assert.equal(tail.events[3].value.doc.extension.kept,'corrected');
 });
 it('uses FULL old identity for TOAST-omitting metadata updates and refuses identity-only deletes',()=>{
  const omitted=event('U',null,doc);omitted.columns=[{name:'storage_bytes',value:100}];
  assert.deepEqual(journal.changes('food',omitted),[]);
  assert.throws(()=>journal.changes('food',{...event('D',null,doc),identity:[{name:'_id',value:doc._id},{name:'id_kind',value:'string'}]}),/FULL_IDENTITY/);
  const renamed=journal.changes('food',event('U',{...doc,identifier:'renamed'},doc));
  assert.deepEqual(renamed.map(e=>[e.event,e.value.identifier||e.value.doc.identifier]),[['delete','public-id'],['update','renamed']]);
 });
 it('preserves soft-delete/undelete visibility and never fabricates expiry events',()=>{
  assert.equal(journal.changes('entries',event('U',{...doc,isValid:false},doc))[0].event,'delete');
  assert.equal(journal.changes('entries',event('U',doc,{...doc,isValid:false}))[0].event,'create');
  assert.deepEqual(journal.changes('entries',event('D',null,{...doc,isValid:false})),[]);
  const tail=journal.append(null,'entries',event('I',doc),limits),saved=structuredClone(tail);
  // No API for cache expiry: only actual committed source events append.
  assert.deepEqual(journal.validate(tail),saved);
 });
 it('bounds history, makes truncation explicit, persists coverage across restart and resets restore continuity',()=>{
  let tail=journal.empty();for(let i=0;i<100;i++)tail=journal.append(tail,'food',event('I',{...doc,_id:'row-'+i},null,'0/'+(32+i).toString(16)),{...limits,maxRows:3});
  assert.equal(tail.events.length,3);assert.equal(tail.base,97);assert.equal(tail.head,100);
  assert.deepEqual(journal.validate(JSON.parse(JSON.stringify(tail))),tail);
  const large=journal.append(tail,'food',event('I',{...doc,big:'x'.repeat(20000)},null,'0/100'),{...limits,maxBytes:512});
  assert.equal(large.base,large.head);assert.equal(large.events.length,0);assert(Buffer.byteLength(JSON.stringify(large))<=512);
  assert.equal(journal.reset(tail).base,101);
 });
 it('has its own bound, separate from the clinical-input limits, and trims a tail written at the old cap',()=>{
  assert.deepEqual(journal.BOUNDS,{maxRows:1000,maxBytes:524288});
  // A legacy tail written under the clinical bounds (10,000 events / 8 MiB).
  const events=Array.from({length:3000},(_,i)=>({event:'create',domain:'entries',value:{colName:'entries',doc:{_id:'legacy-'+i,identifier:'legacy-'+i,pad:'x'.repeat(2600)}},sequence:i+1}));
  const legacy=journal.validate({...journal.empty(),head:3000,base:0,events,last:'0/10',keys:['k']});
  assert(Buffer.byteLength(JSON.stringify(legacy))>7e6);
  const next=journal.append(legacy,'food',event('I',{...doc,_id:'after',identifier:'after'},null,'0/11'));
  assert.equal(next.head,3001);assert(next.events.length<=journal.BOUNDS.maxRows);
  assert(Buffer.byteLength(JSON.stringify(next))<=journal.BOUNDS.maxBytes,'TRIMMED_TO_OWN_BYTE_BOUND');
  assert.equal(next.events.at(-1).value.doc.identifier,'after');assert.equal(next.base,next.head-next.events.length);
 });
 it('matches full JSON eviction at every byte boundary with Unicode, escapes, digit growth and equal-LSN keys',()=>{
  function reference(saved,data,bounds){
   const key=require('node:crypto').createHash('sha256').update(JSON.stringify(['food',data])).digest('hex');
   if(saved.last===data.lsn&&saved.keys.includes(key))return saved;
   const state={...saved,events:saved.events.slice(),keys:saved.last===data.lsn?saved.keys.slice():[],last:data.lsn};
   state.keys.push(key);if(state.keys.length>bounds.maxRows)state.keys.shift();
   for(const change of journal.changes('food',data))state.events.push({...change,sequence:++state.head});
   while(state.events.length&&(state.events.length>bounds.maxRows||Buffer.byteLength(JSON.stringify(state))>bounds.maxBytes))state.base=state.events.shift().sequence;
   while(state.keys.length&&Buffer.byteLength(JSON.stringify(state))>bounds.maxBytes)state.keys.shift();
   if(Buffer.byteLength(JSON.stringify(state))>bounds.maxBytes)throw new Error('STORAGE_EVENT_BOUND');
   return state;
  }
  let saved={...journal.empty(),head:98,base:98};
  for(let i=0;i<6;i++)saved=journal.append(saved,'food',event('I',{...doc,_id:'prior-'+i,extension:'雪😀\\\"\n'.repeat(i+1)}),limits);
  const original=JSON.stringify(saved),data=event('U',{...doc,identifier:'renamed',extension:'é😀\\\"\n'.repeat(9)},doc);
  const check=module=>{
   for(const maxRows of [1,3,8])for(let maxBytes=256;maxBytes<1800;maxBytes++){
    const bounds={maxRows,maxBytes};
    assert.deepEqual(module.append(saved,'food',data,bounds),reference(saved,data,bounds),'EXACT_UTF8_TAIL');
   }
   assert.equal(JSON.stringify(saved),original,'PRIOR_TAIL_MUTATED');
  };
  check(journal);
  assert.throws(()=>check(control('../lib/storage/storage-event-journal','Buffer.byteLength(JSON.stringify(removed))','JSON.stringify(removed).length')),/EXACT_UTF8_TAIL/);
  check(journal);
 });
 it('RED/restored controls detect dropped out-of-window mutations and fabricated public identity',()=>{
  const check=module=>{assert.equal(module.changes('food',event('U',{...doc,carbs:20},doc))[0].value.doc.carbs,20,'RAW_FOOD_MUST_ARRIVE');assert.equal(module.changes('food',event('D',null,doc))[0].value.identifier,'public-id','PUBLIC_DELETE_IDENTITY');};
  assert.throws(()=>check(control('../lib/storage/storage-event-journal',"if(data.action==='U'&&isDeepStrictEqual(before,after))return [];","if(data.action==='U')return [];")),/undefined/);
  assert.throws(()=>check(control('../lib/storage/storage-event-journal',"if(data.action==='D')return [{event:'delete',domain,value:{colName:domain,identifier:normalized(before).identifier}}];","if(data.action==='D')return [{event:'delete',domain,value:{colName:domain,identifier:before._id}}];")),/PUBLIC_DELETE_IDENTITY/);
  check(journal);
 });
});
module.exports={event,doc,limits};
