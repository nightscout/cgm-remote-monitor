'use strict';
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { create } = require('../lib/pgstream/checkpoint');
const { optInSuite } = require('./support/opt-in');
optInSuite(process.env.NS_PGSTREAM_ROLE_TEST === '1' && !!process.env.NS_TEST_POSTGRES_ADMIN_URI,
  'NS_PGSTREAM_ROLE_TEST=1 with disposable NS_TEST_POSTGRES_ADMIN_URI')('single CDC receipt metadata on native PostgreSQL', function () {
  this.timeout(30000);
  const lab = require('./fixtures/tenant-projection-evaluator')();
  let store;
  const table = () => '"' + lab.replayNamespace + '".tenant_consumer_checkpoint';
  const originalState = () => ({kind:'evaluator-work-v1',observed:{clock:'5',activity:'5'},completed:{clock:'4'},
    pendingAt:17,enabled:false,eligibility:{activity:false},output:{synthetic:'x'.repeat(65536)},
    nextDueAt:900,nextDueReason:'timer',unknown:{preserved:true}});
  const saved = async () => lab.checkpoint(store.consumer,lab.A);
  before(async () => {
    await lab.open();
    await lab.admin.query(`CREATE POLICY single_receipt_metadata ON ${table()} TO "${lab.readerRole}"
      USING (consumer='evaluator-single-receipt-completed') WITH CHECK (consumer='evaluator-single-receipt-completed')`);
  });
  beforeEach(async () => {
    await lab.reset();
    store = create({connection:lab.reader,namespace:lab.replayNamespace,consumer:'evaluator-single-receipt',maxBytes:4*1024*1024,timeIntervalMs:60000});
    await lab.provision(store.consumer,lab.A,[originalState()],77,store.digest);
  });
  after(() => lab.close());
  async function capture (fn, fullReadControl = false) {
    const original = Client.prototype.query, seen = [];
    Client.prototype.query = function (...args) {
      const input = args[0], sql = typeof input === 'string' ? input : input?.text;
      const selected = this.user === lab.readerRole;
      const receipt = selected && sql?.includes(' AS state,contract_digest FROM') && sql.includes('FOR UPDATE');
      if (receipt && fullReadControl) args[0] = 'SELECT projection,contract_digest FROM ' + table() + ' WHERE tenant_id=$1 AND consumer=$2 FOR UPDATE';
      const result = original.apply(this,args);
      if (!selected || !result?.then) return result;
      return result.then(value => {
        seen.push({sql:typeof args[0]==='string'?args[0]:args[0]?.text,bytes:Buffer.byteLength(JSON.stringify(value.rows))});
        if (receipt && fullReadControl) for (const row of value.rows) row.state = row.projection?.[0];
        return value;
      });
    };
    try { return {value:await fn(),seen}; } finally { Client.prototype.query = original; }
  }
  function noClinicalTransfer (seen) {
    const reads = seen.filter(row => row.sql?.includes('contract_digest') && row.sql.includes('FOR UPDATE'));
    assert.equal(reads.length,1);
    assert(reads.every(row => row.bytes < 2048), 'SINGLE_RECEIPT_NO_CLINICAL_TRANSFER');
  }
  it('keeps completed/output/due/checkpoint/unknown fields and monotone observation/eligibility', async () => {
    const before = await saved();
    const first = await capture(() => store.observe(lab.A,'clock','6'));
    noClinicalTransfer(first.seen);
    assert(!Object.hasOwn(first.value,'output'));
    let next = await saved();
    for (const key of ['completed','output','nextDueAt','nextDueReason','unknown']) assert.deepEqual(next.projection[0][key],before.projection[0][key]);
    assert.equal(next.checkpoint,before.checkpoint); assert.equal(next.contract_digest,before.contract_digest);
    assert.equal(next.projection[0].observed.clock,'6'); assert.equal(next.projection[0].pendingAt,17);
    const stale = await saved(); await store.observe(lab.A,'activity','5',true);
    assert.deepEqual(await saved(),stale);
    await store.observe(lab.A,'activity','6',true); next=await saved();
    assert.equal(next.projection[0].enabled,true); assert(next.projection[0].pendingAt>17);
    assert.equal(next.projection[0].observed.clock,'6'); assert.deepEqual(next.projection[0].completed,{clock:'4'});
  });
  it('rolls back a refused patch and rejects an invalid metadata object or digest', async () => {
    const before = await saved();
    await lab.admin.query(`ALTER TABLE ${table()} ADD CONSTRAINT single_receipt_refusal CHECK ((projection->0->'observed'->>'clock')<>'7')`);
    try { await assert.rejects(store.observe(lab.A,'clock','7'),/single_receipt_refusal/); assert.deepEqual(await saved(),before); }
    finally { await lab.admin.query(`ALTER TABLE ${table()} DROP CONSTRAINT single_receipt_refusal`); }
    await lab.admin.query(`UPDATE ${table()} SET projection=$3::jsonb WHERE tenant_id=$1 AND consumer=$2`,[lab.A,store.consumer,JSON.stringify([{unknown:true}])]);
    await assert.rejects(store.observe(lab.A,'clock','7'),/EVALUATOR_RECEIPT_CONTRACT/);
    await lab.admin.query(`UPDATE ${table()} SET projection=$3::jsonb,contract_digest=$4 WHERE tenant_id=$1 AND consumer=$2`,
      [lab.A,store.consumer,JSON.stringify([originalState()]),'b'.repeat(64)]);
    try { await assert.rejects(store.observe(lab.A,'clock','7'),/EVALUATOR_RECEIPT_CONTRACT/); }
    finally { await lab.admin.query(`UPDATE ${table()} SET contract_digest=$3 WHERE tenant_id=$1 AND consumer=$2`,[lab.A,store.consumer,store.digest]); }
  });
  it('supports NULL initialization and control: the old full SELECT makes the byte oracle red', async () => {
    const control = await capture(() => store.observe(lab.A,'clock','6'),true);
    assert.throws(() => noClinicalTransfer(control.seen),/SINGLE_RECEIPT_NO_CLINICAL_TRANSFER/);
    assert(control.seen.some(row=>row.bytes>65536),'control really transfers full clinical output');
    const after = await saved(); assert.deepEqual(after.projection[0].output,originalState().output);
    await lab.admin.query(`UPDATE ${table()} SET projection=NULL WHERE tenant_id=$1 AND consumer=$2`,[lab.A,store.consumer]);
    await store.observe(lab.A,'clock','1');
    const initialized=(await saved()).projection[0];assert.equal(initialized.output,null);assert.equal(initialized.observed.clock,'1');
    assert.deepEqual(initialized.completed,{});assert(initialized.pendingAt!==null);
  });
});
