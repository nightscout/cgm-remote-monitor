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
  it('selects the actual evaluator checkpoint instance while refusing an output-only or wrong source catalogue',()=>{
    const selection=selected.create(options());
    const catalogues=[{kind:'checkpoint',namespace:'realtime_checkpoint',catalogue:output,tables:['tenant_consumer_checkpoint']},{kind:'evaluator_checkpoint',instanceOf:'checkpoint',namespace:'native_checkpoint',catalogue:typed,tables:['tenant_consumer_checkpoint']},{kind:'lifecycle',namespace:'native_control',catalogue:require('../lib/tenant-lifecycle/postgres-candidate.json'),tables:['tenant_lifecycle_windows']}];
    assert.equal(compose(catalogues,{nativeSelection:selection}),catalogues);
    assert.throws(()=>compose(catalogues.map(row=>row.kind==='evaluator_checkpoint'?{...row,catalogue:output}:row),{nativeSelection:selection}),{message:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
    assert.throws(()=>compose(catalogues,{nativeSelection:selection,intakeProfile:{}}),{message:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
  });
  it('owns notification route bounds and refuses foreign or duplicate scopes',()=>{
    const selection=selected.create(options()),input=[{namespace:'native_outbox',consumer:'native-route'}],rows=selected.notificationBindings(input,selection);
    input[0].consumer='foreign';assert.equal(rows[0].consumer,'native-route');
    assert.throws(()=>selected.notificationBindings([{namespace:'native_checkpoint',consumer:'route'}],selection),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
    assert.throws(()=>selected.notificationBindings([{namespace:'native_outbox',consumer:'one'},{namespace:'native_outbox',consumer:'two'}],selection),{code:'LIFECYCLE_NATIVE_SELECTION_INVALID'});
  });
});
