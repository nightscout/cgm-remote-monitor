'use strict';
const assert=require('node:assert/strict');
const operator=require('../lib/pgstream/pool-operator-grants'),worker=require('../lib/pgstream/pool-worker-grants'),profiles=require('../lib/pgstream/pool-intake-profile');
const profile=profiles.create({namespace:'test_work',membershipNamespace:'test_pool',lifecycleNamespace:'test_lifetime',role:'intake_writer',operatorRole:'pool_operator',consumer:'evaluator-dynamic',codec:profiles.CODEC,generationDomain:profiles.GENERATION_DOMAIN,sliceRule:'sha256-modulo-v1'});
describe('pool assignment operator grant plan',()=>{
 it('binds only its source operator and narrow assignment/placement columns, never clinical/output/ACK/input writes',()=>{
  const plan=operator.build({role:'pool_operator',profile});
  assert(plan.includes('GRANT SELECT(tenant_id,consumer,work_owner_ordinal,work_assignment_revision),UPDATE(work_owner_ordinal,work_assignment_revision) ON "test_work".tenant_consumer_checkpoint TO "pool_operator"'));
  assert.deepEqual(operator.DESIRED_UPDATES,['members','previous_members','revision','updated_at','partitioned','previous_partitioned']);
  assert(!plan.some(sql=>/INSERT|DELETE|TRUNCATE|ALTER|EXECUTE|projection|output_digest|delivery_ack_revision|work_observed/.test(sql)));
  for(const role of ['worker_one','intake_writer','pool_operator;evil'])assert.throws(()=>operator.build({role,profile}),/PRINCIPAL/);
 });
 it('known completed-consumer restrictive+permissive policies admit global metadata enumeration without recursive checkpoint reads or a frozen roster',()=>{
  const plan=operator.build({role:'pool_operator',profile}),policies=plan.filter(sql=>sql.startsWith('CREATE POLICY'));
  assert.equal(policies.length,2);assert(policies.some(sql=>sql.includes(' AS RESTRICTIVE ')));assert(policies.some(sql=>sql.includes(' AS PERMISSIVE ')));
  assert(policies.every(sql=>sql.includes("USING (consumer='evaluator-dynamic-completed') WITH CHECK (consumer='evaluator-dynamic-completed')")));
  assert(!operator.expression(profile).includes('current_setting'));assert(!operator.expression(profile).includes('SELECT'));assert.deepEqual(worker.policyTree(operator.expression(profile)),['=',['field',['consumer']],['string','evaluator-dynamic-completed']]);
 });
 it('grants exact existing lifecycle current-authority SELECT and USAGE without policies, writes or backend-birth execution',()=>{
  const reads=operator.lifecycleReads(profile);assert(reads.tenant_lifecycle_windows.includes('generation'));assert(reads.tenant_lifecycle_requests.includes('phase'));assert(reads.tenant_lifecycle_recommission.includes('activated'));
  const plan=operator.build({role:'pool_operator',profile});assert(plan.includes('GRANT USAGE ON SCHEMA "test_lifetime" TO "pool_operator"'));for(const [table,columns]of Object.entries(reads))assert(plan.includes('GRANT SELECT('+columns.join(',')+') ON "test_lifetime".'+table+' TO "pool_operator"'));assert(!plan.some(sql=>sql.includes('EXECUTE')||sql.startsWith('CREATE POLICY')&&sql.includes('test_lifetime')));
 });
});
