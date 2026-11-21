'use strict';
const assert = require('node:assert/strict');
const reconcile = require('../lib/pgstream/bootstrap');
const metadata = () => ({signature:{stamp:'11'},settings:'12',policy:'13',activity:{version:'14',paused:false,suspended:false}});
const rows = count => new Map(Array.from({length:count},(_,i)=>['11111111-1111-4111-8111-'+String(i).padStart(12,'0'),metadata()]));

describe('pgstream bootstrap durable page boundary', function () {
  it('does not finish reconciliation or issue another page before the current commit', async () => {
    let release, finished = false;
    const held = new Promise(resolve => { release = resolve; });
    const calls = [];
    const work = reconcile({observeMany:async page => {calls.push(page);if(calls.length===1)await held;}},rows(65)).then(()=>{finished=true;});
    await Promise.resolve();assert.equal(finished,false);assert.equal(calls.length,1);assert.equal(calls[0].length,64);
    release();await work;assert.equal(finished,true);assert.equal(calls.length,2);assert.equal(calls[1].length,1);
  });
  it('refuses bootstrap after a failed durable page instead of proceeding to later tenants', async () => {
    let calls=0;
    await assert.rejects(reconcile({observeMany:async()=>{calls++;throw new Error('SYNTHETIC_COMMIT_LOSS');}},rows(65)),/SYNTHETIC_COMMIT_LOSS/);
    assert.equal(calls,1);
  });
  it('refuses missing recovery metadata rather than silently skipping its receipt', async () => {
    const input=rows(1);input.set('22222222-2222-4222-8222-222222222222',null);
    await assert.rejects(reconcile({observeMany:async()=>assert.fail('incomplete page')},input),/PGSTREAM_BOOTSTRAP_METADATA_MISSING/);
  });
});
