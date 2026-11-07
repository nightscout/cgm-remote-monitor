'use strict';
const assert=require('node:assert/strict');
const createProtocol=require('./fixtures/evaluator-consumer-open-protocol');
const syntheticAdminURI='postgres://synthetic:synthetic@127.0.0.1:15432/open_order_test';
const protocol=(options={})=>createProtocol({...options,env:{NS_TEST_POSTGRES_ADMIN_URI:syntheticAdminURI,...options.env}});
describe('actual inherited evaluator consumer fixture setup protocol',function(){
  it('runs base reset during inherited open before extension schemas exist and waits to reset extension until installed',async function(){
    const p=protocol(),lab=p.factory();
    let primary, cleanup;
    try {
      await lab.open();
      assert.equal(p.clients[0].role,new URL(syntheticAdminURI).username,'CONSUMER_SUPPLIED_SYNTHETIC_ADMIN_IDENTITY');
      const firstExtension=p.calls.findIndex(row=>row.kind==='migration'&&row.namespace===lab.consumerNamespaces.outbox);
      const firstBaseReset=p.calls.findIndex(row=>row.kind==='truncate');assert.ok(firstBaseReset>=0&&firstBaseReset<firstExtension);
      assert.equal(p.calls.slice(0,firstExtension).some(row=>row.kind==='truncate'&&row.schemas.includes(lab.consumerNamespaces.outbox)),false,'CONSUMER_EXTENSION_RESET_AFTER_SCHEMA_READY');
      await lab.reset();assert.ok(p.calls.some(row=>row.kind==='truncate'&&row.schemas.includes(lab.consumerNamespaces.outbox)));
    } catch(error) {primary=error;}
    try {await lab.close();}catch(error){cleanup=error;}
    if(primary||cleanup)console.log('CONSUMER_OPEN_PROTOCOL_FAILURE '+JSON.stringify({primary:primary?.code||primary?.message,cleanup:cleanup?.code||cleanup?.message}));
    assert.ifError(primary); assert.ifError(cleanup);
    assert.equal(p.roles.size,0);assert.equal(p.schemas.size,0);assert.ok(p.clients.every(client=>client.closed));
  });
  for(const failure of [{failRoleSuffix:'_reader'},{failConsumerRoleSuffix:'_reader'}]) it('cleans only roles actually created after '+Object.keys(failure)[0]+' refusal',async function(){
    const p=protocol(failure),lab=p.factory();
    await assert.rejects(lab.open(),/SYNTHETIC_CREATE_ROLE_REFUSED/);
    await lab.close();
    assert.equal(p.roles.size,0);assert.equal(p.schemas.size,0);assert.ok(p.clients.every(client=>client.closed),'CONSUMER_PARTIAL_OPEN_CLEANUP');
  });
  it('drains exactly successful created resources when interrupted after every actual fixture SQL creation boundary',async function(){
    const baseline=protocol(),initial=baseline.factory();let count;
    try {await initial.open();count=baseline.calls.filter(row=>['create-role','create-schema'].includes(row.kind)).length;}
    finally {await initial.close();}
    assert.ok(count>0);
    for(let boundary=1;boundary<=count;boundary++) {
      const p=protocol({interruptAfterCreate:boundary}),lab=p.factory();
      await assert.rejects(lab.open(),/SYNTHETIC_AFTER_CREATION_REFUSED/);
      await lab.close();assert.equal(p.roles.size,0,'CONSUMER_CREATED_ROLE_INTERRUPTION_'+boundary);
      assert.equal(p.schemas.size,0,'CONSUMER_CREATED_SCHEMA_INTERRUPTION_'+boundary);
      assert.ok(p.clients.every(client=>client.closed),'CONSUMER_CREATED_CONNECTION_INTERRUPTION_'+boundary);
    }
    console.log('CONSUMER_SETUP_INTERRUPTION_BOUNDARIES '+JSON.stringify({count}));
  });
  it('does not adopt or drop an already-present exact extension schema when CREATE refuses',async function(){
    const p=protocol(),lab=p.factory(),foreign=lab.consumerNamespaces.outbox;p.schemas.add(foreign);
    await assert.rejects(lab.open(),error=>error.code==='42P06');await lab.close();
    assert.deepEqual([...p.schemas],[foreign],'CONSUMER_SCHEMA_CREATE_REFUSAL_NO_ADOPTION');
    assert.equal(p.calls.some(row=>row.kind==='drop-schema'&&row.name===foreign),false);assert.equal(p.roles.size,0);
  });
  it('does not adopt or drop an already-present exact extension role when CREATE refuses',async function(){
    const p=protocol(),lab=p.factory(),foreign=lab.consumerRoles.reader;p.roles.add(foreign);
    await assert.rejects(lab.open(),error=>error.code==='42710');await lab.close();
    assert.deepEqual([...p.roles],[foreign],'CONSUMER_ROLE_CREATE_REFUSAL_NO_ADOPTION');
    assert.equal(p.calls.some(row=>row.kind==='drop-role'&&row.name===foreign),false);assert.equal(p.schemas.size,0);
  });

  it('consumes each explicitly supplied synthetic environment in actual fixture open without sharing a process environment',async function(){
    for(const identity of ['synthetic-isolated-a','synthetic-isolated-b']) {
      const address=new URL(syntheticAdminURI);address.username=identity;
      const p=protocol({env:{NS_TEST_POSTGRES_ADMIN_URI:address.toString()}}),lab=p.factory();
      try {await lab.open();assert.equal(p.clients[0].role,identity,'CONSUMER_ISOLATED_SYNTHETIC_ENV');}
      finally {await lab.close();}
      assert.equal(p.roles.size,0);assert.equal(p.schemas.size,0);assert.ok(p.clients.every(client=>client.closed));
    }
    assert.throws(()=>createProtocol(),/Explicit synthetic fixture environment required/);
  });

});
