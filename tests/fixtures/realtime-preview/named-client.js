'use strict';
// Explicit fixture-local resolver; actual Socket.IO transports and authority stay intact.
const http=require('node:http'),assert=require('node:assert/strict'),diagnostics=require('./transport-diagnostics');
module.exports=function namedClient({hosts,port,timeoutMs,record}){
 assert(Array.isArray(hosts)&&hosts.length===2&&new Set(hosts).size===2&&hosts.every(x=>typeof x==='string'&&/^[a-z0-9-]+\.example\.test$/.test(x)));
 assert(Number.isSafeInteger(port)&&port>0&&port<65536&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&typeof record==='function');
 const known=new Set(hosts),sockets=new Set();let closed=false;
 function lookup(host,options,callback){
  if(typeof options==='function'){callback=options;options={};}options=options||{};
  if(!known.has(host)||options.family===6){const error=Object.assign(new Error('Synthetic fixture lookup refused'),{code:known.has(host)?'EAI_ADDRFAMILY':'EAI_NONAME'});record(diagnostics.metadata({kind:'lookup-refused',url:'/socket.io/',host,hosts,upstreamRole:'realtime',error}));queueMicrotask(()=>callback(error));return;}
  queueMicrotask(()=>options.all?callback(null,[{address:'127.0.0.1',family:4}]):callback(null,'127.0.0.1',4));
 }
 const agent=new http.Agent({lookup});
 function socket({host=hosts[0],namespace='/',transports,autoConnect=true}){
  assert(!closed,'FIXTURE_CLIENT_CLOSED');assert(known.has(host),'FIXTURE_HOST_REFUSED');assert(['','/','/alarm','/storage'].includes(namespace));assert(Array.isArray(transports)&&transports.length>0&&new Set(transports).size===transports.length&&transports.every(x=>['polling','websocket'].includes(x)));assert(typeof autoConnect==='boolean');
  const actual=require('socket.io-client')('http://'+host+':'+port+(namespace==='/'?'':namespace),{agent,transports,reconnection:false,forceNew:true,timeout:timeoutMs,autoConnect});sockets.add(actual);
  actual.on('connect',()=>record(diagnostics.metadata({kind:'client-connect',url:'/socket.io/?transport='+actual.io.engine.transport.name+'&EIO=4',host,hosts,upstreamRole:'realtime'})));
  actual.on('connect_error',error=>record(diagnostics.metadata({kind:'client-connect-error',url:'/socket.io/?transport='+(actual.io.engine?.transport?.name||transports[0])+'&EIO=4',host,hosts,upstreamRole:'realtime',httpStatus:diagnostics.status(error.description)??diagnostics.status(error.context?.status),error})));
  return actual;
 }
 function close(){if(closed)return;closed=true;for(const value of sockets)value.close();sockets.clear();agent.destroy();}
 return Object.freeze({socket,close,agent});
};
