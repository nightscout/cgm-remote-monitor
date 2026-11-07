'use strict';
const assert=require('node:assert/strict'),oracle=require('./fixtures/realtime-preview/consumer-oracles');
describe('actual consumer driver physical oracles (synthetic source vectors)',function(){
  const payload={level:2,group:'default',message:'Synthetic low'},row={tenant_id:'synthetic-tenant',request_id:'request-original',state:'attempting',attempt:1,payload,
    origin:'original-logical-effect',config_identity:'current-config',dedup_key:'original-key'};
  const first=()=>({tenant:'synthetic-tenant',id:row.request_id,attempt:1,notification:payload,durable:structuredClone(row),responseLost:true});
  function capture(){const values=[];return {values,record:value=>values.push(structuredClone(value))};}
  it('binds actual durable origin and rejects unrelated fresh-cycle-only sends as retry evidence',function(){
    const lost=first(),next={...lost,responseLost:false,attempt:2,durable:{...row,attempt:2}};
    assert.equal(oracle.bindAttempt(next,[next.durable],lost).request_id,row.request_id);
    assert(oracle.retryBoundary([lost,next],'synthetic-tenant'));
    assert.equal(oracle.retryBoundary([lost,{...next,durable:{...next.durable,origin:'different-cycle'}}],'synthetic-tenant'),null);
    assert.equal(oracle.retryBoundary([lost,{...next,attempt:1}],'synthetic-tenant'),null);
    assert.equal(oracle.bindAttempt(next,[{...next.durable,origin:'different-cycle'}],lost),null);
  });
  it('accepts same-UUID retry only with unchanged persisted payload linkage',function(){
    const lost=first(),next={...lost,responseLost:false,attempt:2,durable:{...row,attempt:2}},saved=capture();
    assert.equal(oracle.retry({first:lost,retry:next,rows:[next.durable]},saved.record).request_id,row.request_id);
    assert.equal(saved.values[0].retryPhysical.first.durable.origin,row.origin);
  });
  it('records full physical evidence before a fresh retry UUID produces its specific assertion disposition',function(){
    const lost=first(),next={...lost,id:'fresh-wrong-request',responseLost:false,attempt:2,durable:{...row,attempt:2}},saved=capture();
    assert.throws(()=>oracle.retry({first:lost,retry:next,rows:[next.durable]},saved.record),error=>error.code==='ERR_ASSERTION'&&error.message.includes('CONSUMER_UNCERTAIN_SAME_ID'));
    assert.equal(saved.values[0].retryPhysical.retry.id,'fresh-wrong-request');
    assert.deepEqual(saved.values[1].semanticFailure,{name:'AssertionError',code:'ERR_ASSERTION',message:'CONSUMER_UNCERTAIN_SAME_ID'});
  });
  it('refuses changed persisted payload and unknown or ambiguous physical effects',function(){
    const lost=first(),next={...lost,responseLost:false,attempt:2,durable:{...row,attempt:2}};
    assert.throws(()=>oracle.retry({first:lost,retry:next,rows:[{...next.durable,payload:{...payload,message:'wrong'}}]},()=>{}),assert.AssertionError);
    assert.throws(()=>oracle.bindAttempt(lost,[],null),/EFFECT_NOT_UNIQUE/);
    assert.throws(()=>oracle.bindAttempt(lost,[row,row],null),/EFFECT_NOT_UNIQUE/);
  });
  const suppression=[1,2].map(alarm_level=>({alarm_group:'default',alarm_level,acked_at:'1000',expires_at:'2000'}));
  const keys=oracle.ackKeys(suppression),clearPayload={clear:true,group:'default'},effect={origin:'ack-transition',payload:clearPayload};
  const producer=()=>({revision:'5',config_identity:'cold-current',producer:{acks:keys,effects:[effect]}});
  const physical=()=>({producer:producer(),ackKeys:keys,beforeRevision:'4',beforeAckRequestIds:['old-clear'],
    rows:[{request_id:'new-clear',origin:effect.origin,payload:clearPayload}],cold:{pid:123,last:[{value:null}]},suppressed:suppression});
  it('requires both exact original-expiry ACK keys and an advancing committed producer revision',function(){
    assert(oracle.consumed(producer(),keys,'4'));
    assert.equal(oracle.consumed(producer(),keys,'5'),false);
    assert.equal(oracle.consumed(producer(),oracle.ackKeys(suppression.map(row=>({...row,expires_at:'2001'}))),'4'),false);
    assert.equal(oracle.consumed({...producer(),producer:{acks:[keys[0]]}},keys,'4'),false);
  });
  it('accepts a new physical clear request linked to a committed clear effect before transport acceptance',function(){
    const saved=capture();assert.equal(oracle.clear(physical(),saved.record).request_id,'new-clear');
    assert.equal(saved.values[0].coldAckPhysical.producer.revision,'5');
  });
  it('records actual ACK-consumption evidence before omitted control clear fails its specific physical assertion',function(){
    for(const mutate of [p=>p.producer.producer.effects=[],p=>p.rows=[],p=>p.rows[0].origin='unrelated',p=>p.rows[0].request_id='old-clear']) {
      const p=physical(),saved=capture();mutate(p);
      assert.throws(()=>oracle.clear(p,saved.record),error=>error.code==='ERR_ASSERTION'&&error.message.includes('CONSUMER_COLD_ACK_CLEAR_INTENT_MISSING'));
      assert.equal(saved.values[0].coldAckPhysical.producer.producer.acks.length,2);
      assert.equal(saved.values[1].semanticFailure.message,'CONSUMER_COLD_ACK_CLEAR_INTENT_MISSING');
    }
  });
  it('keeps malformed ACK and exceeded snapshot bounds as invalid setup rather than assertion controls',function(){
    assert.throws(()=>oracle.ackKeys([]),error=>!(error instanceof assert.AssertionError)&&/PRECONDITION/.test(error.message));
    assert.throws(()=>oracle.bounded([row],{maxRows:0,maxBytes:1000}),error=>!(error instanceof assert.AssertionError)&&/SNAPSHOT_BOUND/.test(error.message));
    assert.throws(()=>oracle.bounded([row],{maxRows:1,maxBytes:1}),/SNAPSHOT_BOUND/);
  });
});
