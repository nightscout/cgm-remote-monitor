'use strict';
// Actual cohort handlers/coordinator with recording transport and role contexts.
// No native PG, process deployment, UDS listener or credential-custody evidence.
const assert=require('node:assert/strict');
const manifest=require('../lib/server/serve/operation-cohort-manifest');
const roles=['api','evaluator','realtime','tenant-admin'];
describe('Fixed participant manifest', function () {
  it('refuses manifest omissions and duplicate endpoints, while admitting explicit API replicas',function(){
    const rows=roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],endpoint:{socketPath:'/synthetic/'+index+'.sock',maxBytes:1000,timeoutMs:1000}}));
    assert.throws(()=>manifest.validate(rows.slice(1)),/cover every role/);
    assert.throws(()=>manifest.validate([...rows,{...rows[0],id:'replica'}]),/Duplicate participant/);
    const replica={...rows[0],id:'replica',endpoint:{...rows[0].endpoint,socketPath:'/synthetic/replica.sock'}};
    assert.equal(manifest.validate([...rows,replica]).length,5);
  });
});

describe('Private role health client', function () {
  it('exposes the named health operation only', function () {
    const client = require('../lib/server/internal-api/clients').roleHealth({socketPath:'/synthetic/health.sock', maxBytes:1000, timeoutMs:1000});
    assert.deepEqual(Object.keys(client), ['getStatus']);
    assert.equal(client.constructor, undefined);
  });
});
