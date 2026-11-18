'use strict';
const assert=require('node:assert/strict');
const selected=require('../lib/tenant-lifecycle/native-selection');
const compose=require('../lib/tenant-operations/selected-platform').compose;
const typed=require('../migrations/candidates/postgres-evaluator-work-v2.json');
const output=require('../migrations/candidates/postgres-realtime-output-v2.json');
const options=()=>({namespace:'native_checkpoint',lifecycleNamespace:'native_control',consumer:'evaluator-native-proof',source:{system_id:'42',timeline:1,database:'native_test',slot:'native_slot'},generation:'native-v1'});
describe('private native lifecycle source selection',()=>{
  it('owns an immutable bounded deployment declaration and refuses a serialized or missing capability',()=>{
    const value=options(),selection=selected.create(value);value.source.system_id='99';
    assert.equal(selection.binding.source.system_id,'42');assert(Object.isFrozen(selection.binding.source));
    assert.throws(()=>selected.validate(JSON.parse(JSON.stringify(selection))),{code:'LIFECYCLE_NATIVE_SELECTION_REQUIRED'});
    assert.throws(()=>selected.validate(),{code:'LIFECYCLE_NATIVE_SELECTION_REQUIRED'});
    assert.throws(()=>selected.create({...options(),generation:'bad:unbounded-alias'}),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
    assert.throws(()=>selected.bind(selection,'foreign_control'),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
  });
  it('binds the selection digest to current source and the full selected lifecycle catalogue separately from typed output',()=>{
    const selection=selected.create(options()),canonical=require('../lib/server/serve/evaluator-runtime').canonical;
    const expected=require('node:crypto').createHash('sha256').update(canonical(['native-lifecycle-v1',selection.binding,selected.catalogue(selection)])).digest('hex');
    assert.equal(selection.selectionDigest,expected);assert.equal(selection.digest,selection.selectionDigest);
    for(const changed of [{...options(),generation:'native-v2'},{...options(),source:{...options().source,system_id:'43'}}]){
      const other=selected.create(changed);assert.notEqual(other.selectionDigest,selection.selectionDigest);assert.equal(other.contractDigest,selection.contractDigest);
    }
  });
  it('selects the actual evaluator checkpoint instance while refusing an output-only or wrong source catalogue',()=>{
    const selection=selected.create(options());
    const catalogues=[{kind:'checkpoint',namespace:'realtime_checkpoint',catalogue:output,tables:['tenant_consumer_checkpoint']},{kind:'evaluator_checkpoint',instanceOf:'checkpoint',namespace:'native_checkpoint',catalogue:typed,tables:['tenant_consumer_checkpoint']},{kind:'lifecycle',namespace:'native_control',catalogue:require('../lib/tenant-lifecycle/postgres-candidate.json'),tables:['tenant_lifecycle_windows']}];
    const result=compose(catalogues,{nativeSelection:selection});assert(result.find(row=>row.kind==='lifecycle').tables.includes('tenant_lifecycle_recommission'));assert.equal(result.find(row=>row.kind==='evaluator_checkpoint').catalogue,typed);
    assert.throws(()=>compose(catalogues.map(row=>row.kind==='evaluator_checkpoint'?{...row,catalogue:output}:row),{nativeSelection:selection}),{message:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
    assert.throws(()=>compose(catalogues,{nativeSelection:selection,intakeProfile:{}}),{message:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
  });
  it('owns notification route bounds and refuses foreign or duplicate scopes',()=>{
    const selection=selected.create(options()),input=[{namespace:'native_outbox',consumer:'native-route'}],rows=selected.notificationBindings(input,selection);
    input[0].consumer='foreign';assert.equal(rows[0].consumer,'native-route');
    assert.throws(()=>selected.notificationBindings([{namespace:'native_checkpoint',consumer:'route'}],selection),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
    assert.throws(()=>selected.notificationBindings([{namespace:'native_outbox',consumer:'one'},{namespace:'native_outbox',consumer:'two'}],selection),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
  });
  it('brands the explicit operation JSON and refuses missing or foreign source/generation fields',()=>{
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-operation-')),file=path.join(dir,'operation.json');
    const config=require('../lib/server/serve/operation-cohort-config');
    const raw={version:1,namespace:'native_control',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:'11111111-1111-4111-8111-111111111111',key:'17'}],nativeSelection:options()};
    const source={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:'postgres://synthetic:synthetic@127.0.0.1/synthetic'};
    try{
      fs.writeFileSync(file,JSON.stringify(raw));const value=config.load(source);
      // The native selection has its own key; intakeProfile is legacy only.
      assert.equal(selected.isNative(value.nativeSelection),true);
      assert.equal(Object.hasOwn(value,'intakeProfile'),false,'NATIVE_SELECTION_NOT_UNDER_INTAKE_PROFILE');
      assert.deepEqual(value.nativeSelection.binding,selected.create(options()).binding);
      assert.deepEqual(require('../lib/tenant-lifecycle/generation-domain').catalogue(value.nativeSelection),selected.catalogue(value.nativeSelection));
      const scope=require('../lib/tenant-lifecycle/generation-scope'),pool={connect:async()=>{throw new Error('unused');}};
      assert.throws(()=>scope.create({namespace:'native_control',locks:raw.locks,pool,intakeProfile:value.nativeSelection}),/LIFECYCLE_NATIVE_SELECTION_KEY_REQUIRED/);
      const window=scope.create({namespace:'native_control',locks:raw.locks,pool,nativeSelection:value.nativeSelection});
      assert.equal(window.selectionDigest,value.nativeSelection.digest);assert.equal(window.intakeProfileDigest,undefined);
      for(const mutate of [v=>{delete v.nativeSelection.source;},v=>{delete v.nativeSelection.generation;},v=>{v.nativeSelection.lifecycleNamespace='foreign_control';},v=>{v.nativeSelection.source.extra=true;},v=>{v.intakeProfile={};}]){
        const changed=structuredClone(raw);mutate(changed);fs.writeFileSync(file,JSON.stringify(changed));assert.throws(()=>config.load(source),/invalid explicit/);
      }
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });

});
