'use strict';
// Actual cohort handlers/coordinator with recording transport and role contexts.
// No native PG, process deployment, UDS listener or credential-custody evidence.
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const manifest=require('../lib/server/serve/operation-cohort-manifest');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
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

describe('Fixed process configuration v2',function(){
  it('derives participant addresses from serve.internal and peer addresses and refuses missing role coverage/local selection',function(){
    const os=require('node:os'),config=require('../lib/server/serve/operation-cohort-config');
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cohort-peer-config-')), file=path.join(dir,'config.json');
    const value={version:2,namespace:'synthetic_window',connectionEnv:'SYNTHETIC_PG',locks:[{tenant:A,key:'17'},{tenant:B,key:'19'}],participantId:'peer_0',
      participants:roles.map((role,index)=>({id:'peer_'+index,roles:[role],namespaces:['clinical_'+index],maxMessageBytes:100000,timeoutMs:1000}))};
    const env=role=>'NS_'+role.toUpperCase().replace('-','_')+'_INTERNAL_';
    const source={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:'postgresql://synthetic:synthetic@127.0.0.1/disposable_test',NS_SERVE_INTERNAL_SOCKET:'/synthetic/api.sock',
      ...Object.fromEntries(roles.slice(1).map(role=>[env(role)+'SOCKET','/synthetic/'+role+'.sock']))};
    try{
      fs.writeFileSync(file,JSON.stringify(value));const parsed=config.load(source);assert.equal(parsed.participantId,'peer_0');assert.equal(parsed.participants.length,4);assert.equal(manifest.isParticipant(parsed.participants[0]),true);
      assert.deepEqual(parsed.participants.map(row=>row.endpoint.socketPath),roles.map(role=>'/synthetic/'+role+'.sock'),'own serve.internal for peer_0, peer addresses for the rest');
      const networkSource={MULTITENANT_OPERATION_CONFIG:file,SYNTHETIC_PG:source.SYNTHETIC_PG,NS_SERVE_INTERNAL_HOST:'0.0.0.0',NS_SERVE_INTERNAL_PORT:'1401',
        ...Object.fromEntries(roles.slice(1).map(role=>[env(role)+'URL','http://'+role+'.nightscout.svc.cluster.local:1401']))};
      const http=config.load(networkSource);
      assert.equal(http.participants[0].endpoint.url,'http://127.0.0.1:1401/','own wildcard listener is dialled on loopback');assert.equal(http.participants[1].endpoint.url,'http://evaluator.nightscout.svc.cluster.local:1401/');
      assert.throws(()=>config.load({...networkSource,NS_REALTIME_INTERNAL_URL:networkSource.NS_EVALUATOR_INTERNAL_URL+'/'}),/invalid explicit/,'equivalent HTTP origins cannot alias participant endpoints');
      assert.throws(()=>config.load({...source,NS_API_INTERNAL_SOCKET:'/synthetic/elsewhere.sock'}),/invalid explicit/,'a peer address cannot move a co-resident role');
      for(const retired of [{socketPathEnv:'SOCKET_0'},{endpoint:{urlEnv:'PRIVATE_0',trust:'network'}}]){
        const old=structuredClone(value);Object.assign(old.participants[0],retired);fs.writeFileSync(file,JSON.stringify(old));assert.throws(()=>config.load(source),/invalid explicit/,'per-contract endpoint keys are retired');
      }
      for(const change of [v=>{v.participantId='absent';},v=>{v.participants.pop();},v=>{v.participants[0].roles=['api','unknown'];},v=>{v.participants[0].timeoutMs=0;}]){
        const changed=structuredClone(value);change(changed);fs.writeFileSync(file,JSON.stringify(changed));assert.throws(()=>config.load(source),/invalid explicit/);
      }
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});


describe('Private role health client', function () {
  it('exposes the named health operation only', function () {
    const client = require('../lib/server/internal-api/clients').roleHealth({socketPath:'/synthetic/health.sock', maxBytes:1000, timeoutMs:1000});
    assert.deepEqual(Object.keys(client), ['getStatus']);
    assert.equal(client.constructor, undefined);
  });
});
