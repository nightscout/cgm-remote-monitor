'use strict';
// Actual plan/parser/admission with synthetic catalogue protocols. This is not
// native policy deparser/RLS authority or clinical throughput evidence.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),vm=require('node:vm');
const {createRequire}=require('node:module');
const worker=require('../lib/pgstream/pool-worker-grants'),operator=require('../lib/pgstream/pool-operator-grants');
const profiles=require('../lib/pgstream/pool-intake-profile'),placement=require('../lib/pool-membership/pool-candidate'),mutation=require('../lib/pool-membership/fixed-protocol');
const profile=profiles.create({namespace:'test_work',membershipNamespace:'test_pool',lifecycleNamespace:'test_lifetime',role:'intake_writer',operatorRole:'pool_operator',consumer:'evaluator-dynamic',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:require('../lib/pool-membership/slice').RULE});
const ordinal=1;
function sourceMutation(from,to){const file=require.resolve('../lib/pgstream/pool-worker-grants'),text=fs.readFileSync(file,'utf8');assert.equal(text.split(from).length,2);const module={exports:{}};vm.runInThisContext('(function(require,module,exports){'+text.replace(from,to)+'\n})',{filename:file})(createRequire(file),module,module.exports);return module.exports;}
function evaluate(node,row,desired){
 const [kind,a,b]=node,read=x=>evaluate(x,row,desired);
 if(kind==='number')return BigInt(a);if(kind==='string')return a;if(kind==='null')return null;if(kind==='true')return true;if(kind==='false')return false;
 if(kind==='field'){const value=a.length===2&&a[0]==='d'?desired?.[a[1]]:row[a.at(-1)];return value;}
 if(kind==='cast')return read(a)===null?null:b==='text'?String(read(a)):BigInt(read(a));
 if(kind==='exists')return desired!==null&&evaluate(node[3],row,desired)===true;
 if(kind==='is-null')return b?read(a)!==null:read(a)===null;
 if(kind==='call'){const args=b.map(read);if(a==='sha256')return crypto.createHash('sha256').update(args[0]).digest();if(a==='convert_to'){assert.equal(args[1],'UTF8');return Buffer.from(args[0],'utf8');}if(a==='get_byte')return BigInt(args[0][Number(args[1])]);if(a==='mod')return args[0]%args[1];assert.fail(a);}
 const left=read(a),right=read(b);
 if(kind==='and')return left===false||right===false?false:left===null||right===null?null:left&&right;
 if(kind==='or')return left===true||right===true?true:left===null||right===null?null:left||right;
 if(left===null||right===null)return null;
 if(kind==='+')return left+right;if(kind==='*')return left*right;if(kind==='=')return left===right;if(kind==='<>')return left!==right;if(kind==='>=')return left>=right;if(kind==='<=')return left<=right;if(kind==='<')return left<right;if(kind==='>')return left>right;assert.fail(kind);
}
function dynamicParity(module){const ids=Array.from({length:128},(_,i)=>'00000000-0000-4000-8000-'+(i+1).toString(16).padStart(12,'0'));
 for(const n of [1,3,5]){const desired={pool_kind:'evaluator',members:BigInt(n),revision:7n,slice_rule:'sha256-modulo-v1',partitioned:n!==1},trees=Array.from({length:n},(_,i)=>module.policyTree(module.expression(profile,i)));
  for(const tenant_id of ids){const bucket=require('../lib/pool-membership/slice').bucket(tenant_id,n),base={tenant_id,consumer:profile.binding.consumer,work_owner_ordinal:null,work_assignment_revision:null},completed={...base,consumer:profile.binding.consumer+'-completed',work_owner_ordinal:BigInt(bucket),work_assignment_revision:7n};
   for(const row of [base,completed]){const admitted=trees.map(tree=>evaluate(tree,row,desired)===true);assert.equal(admitted.filter(Boolean).length,1);assert.equal(admitted[bucket],true);}
   assert(trees.every(tree=>evaluate(tree,{...completed,work_assignment_revision:6n},desired)!==true));
   assert(trees.every(tree=>evaluate(tree,{...base,work_owner_ordinal:0n},desired)!==true));
   assert(trees.every(tree=>evaluate(tree,{...completed,consumer:'foreign-consumer'},desired)!==true));
  }
 }
}
function model({isOperator=false,rolePatch={},relationPatch,policyPatch,extra=[],badLedger=false,badPlacement=false,badProfile=false,grantPlan}={}){
 const calls=[],principal=isOperator?'pool_operator':'worker_one',want=worker.metadata(profile,{worker:!isOperator}),policy=isOperator?{prefix:'pgstream_pool_operator_',suffix:'',expression:operator.expression(profile)}:worker.policies(profile,ordinal);
 const safeRole={principal,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolinherit:false,memberships:false,creates:false,owns:false,...rolePatch};
 // Model actual GRANT execution, rather than handing readiness a fabricated
 // complete rights set. Missing namespace/column grants now fail admission.
 const plan=grantPlan||(isOperator?operator.build({role:principal,profile}):worker.build({role:principal,profile,ordinal}));
 const schemas=new Set(),rights=new Map([...want].map(([relation])=>[relation,{reads:new Set(),updates:new Set()}]));
 for(const sql of plan){const usage=/^GRANT USAGE ON SCHEMA "([a-z0-9_]+)" TO/.exec(sql);if(usage){schemas.add(usage[1]);continue;}const relation=/^GRANT (.+) ON "([a-z0-9_]+)"\.([a-z0-9_]+) TO/.exec(sql);if(!relation)continue;const name=relation[2]+'.'+relation[3],target=rights.get(name);assert(target,name);for(const mode of ['SELECT','UPDATE']){const start=relation[1].indexOf(mode);if(start<0)continue;const tail=relation[1].slice(start+mode.length).trimStart(),key=mode==='SELECT'?'reads':'updates',columns=tail.startsWith('(')?tail.slice(1,tail.indexOf(')')).split(','):want.get(name)[key];for(const column of columns)target[key].add(column);}}
 const relationRows=[...want].map(([relation,need])=>({relation,kind:'r',persistence:'p',rls:need.secured,forced:need.secured,inherited:false,owns:false,uses_schema:schemas.has(relation.split('.')[0]),creates:false,forbidden:false,reads:[...rights.get(relation).reads].sort(),updates:[...rights.get(relation).updates].sort()}));
 const tenant="tenant_id=NULLIF(current_setting('app.current_tenant_id',true),'')::uuid";
 const policies=[{name:'tenant_consumer_checkpoint_isolation',command:'*',permissive:true,using:tenant,check:tenant,public:true,exact_role:false},...['allow','restrict'].map(kind=>({name:policy.prefix+kind+policy.suffix,command:'*',permissive:kind==='allow',using:policy.expression,check:policy.expression,public:false,exact_role:true}))];
 async function query(sql,values){calls.push({sql,values});
  if(sql.includes('pool-grant-principal'))return {rows:[safeRole]};
  if(sql.includes('pool-grant-relations'))return {rows:relationRows.map(row=>({...row,...(relationPatch?.(row)||{})}))};
  if(sql.includes('pool-grant-extras'))return {rows:extra};
  if(sql.includes('pool-grant-policies'))return {rows:policies.map(row=>({...row,...(policyPatch?.(row)||{})}))};
  if(sql.includes('pool-grant-profile'))return {rows:[{consumer:profile.binding.consumer+'-completed',profile:profile.binding,digest:badProfile?'0'.repeat(64):profile.digest,contract_digest:profile.contractDigest}]};
  if(sql.startsWith('SELECT to_regclass'))return {rows:[{present:true}]};
  if(sql.includes('SELECT name, checksum'))return {rows:placement.build().migrations.map((m,i)=>({name:m.name,checksum:badLedger&&i===placement.build().migrations.length-1?'0'.repeat(64):m.checksum}))};
  if(sql.includes('pool-placement-columns'))return {rows:[{name:'partitioned',type:'boolean',required:true,default_value:'true'},{name:'previous_partitioned',type:'boolean',required:false,default_value:null}].map(row=>({...row,...(badPlacement?{type:'text'}:{})}))};
  if(sql.includes('pool-placement-constraint'))return {rows:[{expression:placement.EXPRESSION,valid:true,deferrable:false}]};
  if(sql.includes("t.tgname='pool_mutation_protocol'"))return {rows:['pool_membership','pool_desired'].map(table_name=>({table_name,enabled:'A',type:31,arguments:0,unconditional:true,source:mutation.BODY,definer:false,config:['search_path=pg_catalog'],language:'plpgsql',function_name:'pool_mutation_lock_required',function_arguments:0,trigger_result:true}))};
  assert.fail('Unknown actual readiness query path');
 }
 return {query,calls};
}
describe('dynamic pool worker grant plan, policy grammar and source admission',()=>{
 it('same actual policy adapts to current singleton/N3/N5 without tenant/count/revision constants; unsigned-prefix omission is RED then restored',()=>{
  dynamicParity(worker);const broken=sourceMutation('.unsignedPrefix().replaceAll',".unsignedPrefix().split('+').at(-1).replaceAll");assert.throws(()=>dynamicParity(broken),{code:'ERR_ASSERTION'});dynamicParity(worker);
 });
 it('plans exact worker writes and existing lifecycle readport SELECTs without receipt/assignment/INSERT or function execution',()=>{
  const plan=worker.build({role:'worker_one',profile,ordinal});assert(plan.some(sql=>sql==='GRANT UPDATE('+require('../lib/pgstream/worker-grants').UPDATES.join(',')+') ON "test_work".tenant_consumer_checkpoint TO "worker_one"'));
  assert(!plan.some(sql=>/INSERT|DELETE|GRANT.*work_observed|GRANT.*work_assignment_revision.*UPDATE/.test(sql)));assert(plan.includes('GRANT USAGE ON SCHEMA "test_lifetime" TO "worker_one"'));assert(!plan.some(sql=>sql.includes('EXECUTE')));
  for(const [table,columns]of Object.entries(worker.lifecycleReads(profile)))assert(plan.includes('GRANT SELECT('+columns.join(',')+') ON "test_lifetime".'+table+' TO "worker_one"'));
  const read=worker.lifecycleReads(profile);for(const [table,columns]of Object.entries(require('../lib/tenant-lifecycle/pool-authority').READS))assert(columns.every(column=>read[table].includes(column)));
  assert(worker.DESIRED.includes('partitioned')&&worker.DESIRED.includes('previous_partitioned'));
  const text=worker.expression(profile,ordinal);assert(!text.includes('uuid[]'));assert(!text.includes('9007199254740993'));assert(text.includes('work_assignment_revision=d.revision'));assert.equal(text.match(/FROM/g).length,1);assert(text.includes('FROM "test_pool".pool_desired d'));
 });
 it('actual build GRANTs admit fresh worker/operator roles; omitting a lifecycle table or namespace grant is RED then restored',async()=>{
  for(const isOperator of [false,true]){const role=isOperator?'pool_operator':'worker_one',plan=isOperator?operator.build({role,profile}):worker.build({role,profile,ordinal});const ready=lab=>isOperator?operator.assertReady(lab.query,{profile}):worker.assertReady(lab.query,{profile,ordinal,expectedRole:role});
   await ready(model({isOperator,grantPlan:plan}));
   for(const broken of [plan.filter(sql=>!sql.includes('ON "test_lifetime".tenant_lifecycle_recommission ')),plan.filter(sql=>sql!=='GRANT USAGE ON SCHEMA "test_lifetime" TO "'+role+'"')])await assert.rejects(ready(model({isOperator,grantPlan:broken})),/RELATIONS/);
   await ready(model({isOperator,grantPlan:plan}));
  }
 });
 it('parser preserves grouping, role predicate literals, casts and namespace identity rather than stripping all parentheses',()=>{
  assert.notDeepEqual(worker.policyTree("consumer='A' AND (work_owner_ordinal=1 OR work_assignment_revision=2)"),worker.policyTree("(consumer='A' AND work_owner_ordinal=1) OR work_assignment_revision=2"));
  assert.notDeepEqual(worker.policyTree("consumer='A B'"),worker.policyTree("consumer='AB'"));
  assert.deepEqual(worker.policyTree("consumer = ('exact'::text)"),worker.policyTree("consumer='exact'"));
  for(const text of ['true; SELECT 1',"private_function(consumer)=1",'consumer/*hidden*/=1'])assert.throws(()=>worker.policyTree(text),/GRAMMAR/);
 });
 it('admits exact source privileges and membership0005 metadata once, without mutation or role widening',async()=>{
  const lab=model();const result=await worker.assertReady(lab.query,{profile,ordinal,expectedRole:'worker_one'});assert.equal(result.principal,'worker_one');assert(lab.calls.some(row=>row.sql.includes('pool-placement-columns')));assert(lab.calls.some(row=>row.sql.includes('SELECT name, checksum')));assert(lab.calls.every(row=>row.sql.startsWith('SELECT')));
 });
 it('rejects wrong/elevated/membership-bearing principals and broadened/altered policies',async()=>{
  for(const rolePatch of [{principal:profile.binding.role},{principal:profile.binding.operatorRole},{principal:'wrong_worker'},{rolsuper:true},{rolbypassrls:true},{rolinherit:true},{memberships:true},{creates:true},{owns:true}])await assert.rejects(worker.assertReady(model({rolePatch}).query,{profile,ordinal,expectedRole:'worker_one'}),/PRINCIPAL/);
  for(const principal of ['pg_read_all_data','public'])await assert.rejects(worker.assertReady(model({rolePatch:{principal}}).query,{profile,ordinal}),/PRINCIPAL/);
  for(const policyPatch of [row=>row.public?{}:{using:'true'},row=>row.public?{}:{exact_role:false},row=>row.public?{}:{command:'r'},row=>row.public?{}:{using:row.using.replace('d.revision','work_assignment_revision')},row=>row.public?{using:'true'}:{}])await assert.rejects(worker.assertReady(model({policyPatch}).query,{profile,ordinal}));
 });
 it('rejects missing lifecycle metadata, extra receipt/assignment writes and unrelated writes; actual update-check omission is RED/restored',async()=>{
  for(const relationPatch of [row=>row.relation.endsWith('.tenant_consumer_checkpoint')?{updates:[...row.updates,'work_observed']}:{},row=>row.relation.endsWith('.tenant_consumer_checkpoint')?{updates:[...row.updates,'work_assignment_revision']}:{},row=>row.relation.endsWith('.tenant_lifecycle_windows')?{reads:row.reads.filter(x=>x!=='generation')}:{},row=>row.relation.endsWith('.pool_membership')?{forbidden:true}:{}])await assert.rejects(worker.assertReady(model({relationPatch}).query,{profile,ordinal}),/RELATIONS/);
  await assert.rejects(worker.assertReady(model({extra:[{relation:'unrelated.outbox'}]}).query,{profile,ordinal}),/EXTRA_RIGHTS/);
  const qualify=async module=>assert.rejects(module.assertReady(model({relationPatch:row=>row.relation.endsWith('.tenant_consumer_checkpoint')?{updates:[...row.updates,'work_observed']}:{} }).query,{profile,ordinal}),/RELATIONS/);
  await qualify(worker);const broken=sourceMutation(' || sorted(row.updates) !== sorted(need.updates)','');await assert.rejects(qualify(broken),{code:'ERR_ASSERTION'});await qualify(worker);
 });
 it('refuses membership placement ledger/type drift and wrong installed profile',async()=>{
  for(const patch of [{badLedger:true},{badPlacement:true},{badProfile:true}])await assert.rejects(worker.assertReady(model(patch).query,{profile,ordinal}));
 });
 it('operator admission uses the same actual scope check with metadata-only global visibility, rejecting clinical SELECT/write extras',async()=>{
  assert.equal((await operator.assertReady(model({isOperator:true}).query,{profile})).principal,profile.binding.operatorRole);
  for(const patch of [{rolePatch:{principal:'wrong_operator'}},{relationPatch:row=>row.relation.endsWith('.tenant_consumer_checkpoint')?{reads:[...row.reads,'projection']}:{}},{relationPatch:row=>row.relation.endsWith('.tenant_consumer_checkpoint')?{updates:[...row.updates,'delivery_ack_revision']}:{}},{extra:[{relation:'clinical.entries'}]}])await assert.rejects(operator.assertReady(model({isOperator:true,...patch}).query,{profile}));
 });
});
