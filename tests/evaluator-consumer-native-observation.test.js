'use strict';
// covers: tests/fixtures/evaluator-consumers-native.js, lib/server/realtime/alarm-transport.js
const assert=require('node:assert/strict');
const protocol=require('./fixtures/evaluator-consumer-open-protocol');
describe('actual controlled consumer sink provenance protocol',function(){
  it('correlates each actual transport delivery with its incoming durable UUID without adding UUID to the product delivery',async function(){
    const token=Symbol('owned-protocol');let routes;
    const p=protocol({env:{NS_TEST_POSTGRES_ADMIN_URI:'postgres://synthetic:synthetic@127.0.0.1:15432/sink_protocol_test'},
      ipc:{async open(options,service,create){routes=create(token);return {async close(){}};}}});
    const lab=p.factory(),id='33333333-3333-4333-8333-333333333333';
    try {
      await lab.open();await lab.openSink();
      lab.requests=async()=>[{request_id:id,state:'attempting'}];
      const body={tenant:lab.A,id,attempt:1,notification:{title:'Synthetic alarm',level:2},receipts:[]};
      lab.sinkMode='lost-response';
      await assert.rejects(routes.deliverAlarm({transport:token},body),/lost response/);
      lab.sinkMode='accept';await routes.deliverAlarm({transport:token},{...body,attempt:2});
      assert.equal(lab.sinkEffects.filter(row=>row.id===id).length,2,'CONSUMER_SINK_SAME_UUID_PROVENANCE');
      assert.deepEqual(lab.sinkEffects.map(row=>row.notification),[body.notification,body.notification]);
      assert.equal(lab.observations.find(row=>row.id===lab.sinkEffects[0].id).ownRow.state,'attempting');
      const real=require('../lib/server/realtime/alarm-transport').operations({token,deliver:async operation=>{
        assert.deepEqual(Object.keys(operation).sort(),['notification','tenant'],'unchanged actual realtime delivery shape');
      }});await real.deliverAlarm({transport:token},body);
    } finally {await lab.close();}
  });
});
