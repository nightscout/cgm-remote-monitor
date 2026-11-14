'use strict';
const assert = require('node:assert/strict');
const {Client} = require('pg');
const scope = require('../lib/storage/tenant-scope');
const {create} = require('../lib/pgstream/checkpoint');
const reconcile = require('../lib/pgstream/bootstrap');
const {optInSuite} = require('./support/opt-in');

optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('bounded pgstream bootstrap receipts on PostgreSQL', function () {
  this.timeout(30000);
  const lab = require('./fixtures/tenant-projection-evaluator')();
  let store;
  const table = () => '"' + lab.replayNamespace + '".tenant_consumer_checkpoint';
  const state = async tenant => (await lab.checkpoint(store.consumer, tenant)).projection?.[0];
  const metadata = (stamp = 1, paused = false) => ({signature:{stamp},settings:2,policy:3,activity:{version:4,paused,suspended:false}});
  const observation = (tenant, clock = 1) => ({tenant,observed:{clock:String(clock)}});
  const saved = (extra = {}) => ({kind:'evaluator-work-v1',observed:{},completed:{},pendingAt:null,enabled:true,output:null,...extra});
  before(async () => {
    await lab.open();
    await lab.admin.query(`CREATE POLICY pgstream_bulk_metadata ON ${table()} TO "${lab.readerRole}"
      USING (consumer='evaluator-bootstrap-completed') WITH CHECK (consumer='evaluator-bootstrap-completed')`);
  });
  beforeEach(async () => {
    await lab.reset();
    store = create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-bootstrap',maxBytes:4*1024*1024,timeIntervalMs:60000});
    for (const tenant of [lab.A,lab.B]) await lab.provision(store.consumer,tenant,null,0,store.digest);
  });
  after(() => lab.close());
  async function queries (fn) {
    const original = Client.prototype.query, seen = [];
    Client.prototype.query = function (...args) {
      if (this.user === lab.readerRole) seen.push(typeof args[0] === 'string' ? args[0] : args[0]?.text);
      return original.apply(this,args);
    };
    try { return {value:await fn(),seen}; } finally { Client.prototype.query = original; }
  }
  async function workBound (target = store) {
    const tenants = Array.from({length:65},(_,i) => '44444444-4444-4444-8444-' + String(i+1).padStart(12,'0'));
    for (const tenant of tenants) await lab.provision(store.consumer,tenant,null,0,store.digest);
    const {seen} = await queries(() => reconcile(target,new Map(tenants.map(tenant=>[tenant,metadata()]))));
    assert.equal(seen.filter(sql=>sql==='BEGIN').length,2,'BOOTSTRAP_TRANSACTION_BOUND');
    assert.equal(seen.filter(sql=>sql==='COMMIT').length,2,'BOOTSTRAP_COMMIT_BOUND');
    assert.equal(seen.filter(sql=>sql?.includes('UPDATE') && !sql.includes('FOR UPDATE')).length,2,'BOOTSTRAP_UPDATE_BOUND');
    assert.equal(seen.length,8,'BOOTSTRAP_QUERY_BOUND');
    for (const tenant of tenants) assert.deepEqual((await state(tenant)).observed,{clock:'1',settings:'2',policy:'3',activity:'4'});
  }
  it('commits 65 tenants through two bounded pages and eight receipt queries', async () => { await workBound(); });
  it('control: restoring four per-tenant transactions fails the same deterministic work bound', async () => {
    const unbatched = {observeMany:async rows => {
      for (const row of rows) for (const [source,version] of Object.entries(row.observed))
        await store.observe(row.tenant,source,version,row.eligibility?.[source]);
    }};
    await assert.rejects(workBound(unbatched),error=>error.code==='ERR_ASSERTION' && error.message.includes('BOOTSTRAP_TRANSACTION_BOUND'));
  });
  it('preserves completion, output/frame/due, unknown fields, checkpoint and pending age', async () => {
    const prior = saved({observed:{clock:'10',policy:'7'},observedAt:{clock:100,policy:110},completed:{clock:'9',policy:'7'},
      pendingAt:100,enabled:false,eligibility:{lifecycle:false,activity:true},nextDueAt:123456,completedAt:99,
      output:{frame:{sgvs:[{mgdl:123}],huge:'x'.repeat(300000)},result:{synthetic:true}},extra:'retained'});
    await lab.admin.query(`UPDATE ${table()} SET checkpoint=17,projection=$3::jsonb WHERE tenant_id=$1 AND consumer=$2`,[lab.A,store.consumer,JSON.stringify([prior])]);
    await reconcile(store,new Map([[lab.A,metadata(11)],[lab.B,metadata(2,true)]]));
    const next = await state(lab.A);
    for (const key of ['completed','output','nextDueAt','completedAt','extra','pendingAt']) assert.deepEqual(next[key],prior[key],key);
    assert.equal((await lab.checkpoint(store.consumer,lab.A)).checkpoint,'17');
    assert.equal(next.enabled,false);assert.deepEqual(next.eligibility,{lifecycle:false,activity:true});
    assert.equal(next.observed.policy,'7');assert.equal(next.observedAt.policy,110);
    assert.equal(next.observed.clock,'11');assert.equal((await state(lab.B)).enabled,false);
    assert.equal((await store.work()).length,0,'paused receipts do not become runnable');
  });
  it('uses monotone source versions and preserves pending age during simultaneous newer receipt', async () => {
    await store.observeMany([observation(lab.A,10),observation(lab.B,5)]);
    const age = (await state(lab.A)).pendingAt;
    await Promise.all([store.observeMany([observation(lab.A,11),observation(lab.B,4)]),store.observe(lab.A,'clock','12')]);
    assert.equal((await state(lab.A)).observed.clock,'12');assert.equal((await state(lab.A)).pendingAt,age);
    assert.equal((await state(lab.B)).observed.clock,'5');
    assert.deepEqual((await state(lab.A)).completed,{});
  });
  it('does not unpause on equal/stale activity, and resets pending age on actual reactivation only', async () => {
    await store.observe(lab.A,'activity','10',false);const before=await state(lab.A);
    await store.observeMany([{tenant:lab.A,observed:{activity:'10'},eligibility:{activity:true}}]);
    assert.deepEqual(await state(lab.A),before);
    await store.observeMany([{tenant:lab.A,observed:{activity:'11'},eligibility:{activity:true}}]);
    assert.equal((await state(lab.A)).enabled,true);assert((await state(lab.A)).pendingAt>=before.pendingAt);
  });
  it('refuses a missing/wrong-contract consumer and rolls back all other tenant observations', async () => {
    await lab.admin.query(`DELETE FROM ${table()} WHERE tenant_id=$1 AND consumer=$2`,[lab.B,store.consumer]);
    await assert.rejects(store.observeMany([observation(lab.A),observation(lab.B)]),/NOT_PROVISIONED/);
    assert.equal(await state(lab.A),undefined);
    await lab.provision(store.consumer,lab.B,null,0,'b'.repeat(64));
    await assert.rejects(store.observeMany([observation(lab.A),observation(lab.B)]),/RECEIPT_CONTRACT/);
    assert.equal(await state(lab.A),undefined);
  });
  it('rolls back the batch when the database rejects one patch', async () => {
    await lab.admin.query(`ALTER TABLE ${table()} ADD CONSTRAINT synthetic_bulk_refusal CHECK (tenant_id<>'${lab.B}' OR projection IS NULL)`);
    try {
      const {seen} = await queries(async () => {
        await assert.rejects(store.observeMany([observation(lab.A),observation(lab.B)]),/synthetic_bulk_refusal/);
      });
      assert.equal(seen.filter(sql=>sql==='ROLLBACK').length,1);assert.equal(await state(lab.A),undefined);assert.equal(await state(lab.B),undefined);
    } finally { await lab.admin.query(`ALTER TABLE ${table()} DROP CONSTRAINT synthetic_bulk_refusal`); }
  });
  it('bounds rows and bytes, refuses duplicate tenants, and cannot mutate another consumer', async () => {
    await assert.rejects(store.observeMany(Array.from({length:65},()=>observation(lab.A))),/BATCH_BOUND/);
    await assert.rejects(store.observeMany([observation(lab.A),observation(lab.A.toUpperCase())]),/receipt batch/);
    const prior=saved({observedAt:{oversize:'x'.repeat(270000)}});
    await lab.admin.query(`UPDATE ${table()} SET projection=$3::jsonb WHERE tenant_id=$1 AND consumer=$2`,[lab.A,store.consumer,JSON.stringify([prior])]);
    await assert.rejects(store.observeMany([observation(lab.A)]),/BATCH_BOUND/);assert.deepEqual(await state(lab.A),prior);
    await assert.rejects(lab.reader.observeEvaluatorMany({table:lab.replayNamespace+'.tenant_consumer_checkpoint',consumer:'clinical-view',contractDigest:store.digest,observations:[observation(lab.A)]}),/receipt required/);
  });
});
