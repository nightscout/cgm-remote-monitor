'use strict';
// covers: tests/fixtures/realtime-preview/named-client.js, tests/fixtures/realtime-preview/transport-diagnostics.js
// Source protocol only: intercept request construction, never listen/send traffic.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{EventEmitter}=require('node:events');
const named=require('./fixtures/realtime-preview/named-client'),diagnostics=require('./fixtures/realtime-preview/transport-diagnostics');
const hosts=['one.example.test','two.example.test'];
function capture(uri,agent,extraHost){
 const XHR=require('xmlhttprequest-ssl').XMLHttpRequest,original=http.request,rows=[];
 http.request=options=>{rows.push({hostname:options.hostname,hostHeader:options.headers.Host,agent:options.agent});const req=new EventEmitter();req.end=()=>{};req.write=()=>{};req.abort=()=>{};return req;};
 try{const xhr=new XHR({agent});xhr.open('GET',new URL('/socket.io/?EIO=4&transport=polling',uri).href,true);xhr.setDisableHeaderCheck(true);if(extraHost)xhr.setRequestHeader('Host',extraHost);xhr.send();xhr.abort();}finally{http.request=original;}
 assert.equal(rows.length,1);return rows[0];
}
describe('named actual-role fixture transport source protocol',function(){
 let directory;
 beforeEach(function(){directory=fs.mkdtempSync(path.join(os.tmpdir(),'ns-named-source-'));fs.chmodSync(directory,0o700);});
 afterEach(function(){fs.rmSync(directory,{recursive:true});});
 it('reproduces pinned XHR overwriting old URL Host despite explicit extraHeaders',function(){const row=capture('http://127.0.0.1:54321',undefined,hosts[0]);assert.equal(row.hostHeader,'127.0.0.1:54321');assert.notEqual(row.hostHeader,hosts[0]);});
 it('constructs actual polling and websocket clients with named origins and the same dedicated Agent',function(){
  const source=named({hosts,port:54321,timeoutMs:1000,record(){}});
  try{for(const transport of ['polling','websocket'])for(const host of hosts)for(const namespace of ['/','/alarm','/storage']){const socket=source.socket({host,namespace,transports:[transport],autoConnect:false});assert.equal(socket.nsp,namespace);const row=capture(socket.io.uri,socket.io.opts.agent);assert.equal(row.hostHeader,host+':54321','NAMED_XHR_HOST_MUST_REMAIN_NAMED');assert.equal(row.agent,source.agent);assert.equal(socket.io.opts.agent,source.agent);assert.equal(socket.io.opts.extraHeaders,undefined);socket.close();}}finally{source.close();}
  assert.throws(()=>source.socket({transports:['polling'],autoConnect:false}),/CLOSED/);
 });
 it('resolves only the two fixture hosts with explicit IPv4 and refuses unknown DNS without fallback',async function(){
  const events=[],source=named({hosts,port:54321,timeoutMs:1000,record:row=>events.push(row)});
  const lookup=(host,options)=>new Promise(resolve=>source.agent.options.lookup(host,options,(error,value,family)=>resolve({error,value,family})));
  try{assert.deepEqual(await lookup(hosts[0],{}),{error:null,value:'127.0.0.1',family:4});assert.deepEqual((await lookup(hosts[1],{all:true})).value,[{address:'127.0.0.1',family:4}]);assert.equal((await lookup('outside.example.test',{})).error?.code,'EAI_NONAME','UNKNOWN_LOOKUP_MUST_REFUSE');assert.equal((await lookup(hosts[0],{family:6})).error?.code,'EAI_ADDRFAMILY');assert.throws(()=>source.socket({host:'outside.example.test',transports:['polling'],autoConnect:false}),/HOST_REFUSED/);assert(events.every(row=>row.kind==='lookup-refused'&&row.errorCode&&!Object.hasOwn(row,'host')));}finally{source.close();}
 });
 it('records only bounded route/transport/status metadata and retains the latest failure before a client rejection',function(){
  const writer=diagnostics.create({captureDir:directory,maxEvents:3,maxBytes:1024});
  for(let i=0;i<100;i++)writer.record(diagnostics.metadata({kind:'ingress-response',url:'/socket.io/?sid=SYNTHETIC_SECRET&token=SYNTHETIC_SECRET&EIO=4&transport=polling',host:hosts[0]+':54321',hosts,upstreamRole:'realtime',httpStatus:i===99?403:200}));
  const raw=fs.readFileSync(writer.file,'utf8'),saved=JSON.parse(raw);assert(saved.events.length<=3&&Buffer.byteLength(raw)<=1024,'TRANSPORT_DIAGNOSTICS_MUST_STAY_BOUNDED');assert(saved.droppedEvents>0);assert.equal(saved.events.at(-1).status,403);assert.equal(saved.events.at(-1).knownHost,true);assert(!raw.includes('SYNTHETIC_SECRET')&&!raw.includes(hosts[0])&&!raw.includes('sid='));
  const row=diagnostics.metadata({kind:'client-connect-error',url:'/socket.io/?transport=polling&EIO=4',host:hosts[0],hosts,upstreamRole:'realtime',httpStatus:403,error:{code:'SYNTHETIC_SECRET',message:'SYNTHETIC_SECRET'}});writer.record(row);assert.equal(JSON.parse(fs.readFileSync(writer.file)).events.at(-1).errorCode,'TRANSPORT_ERROR');assert.throws(()=>writer.record({...row,token:'SYNTHETIC_SECRET'}));
 });
});
