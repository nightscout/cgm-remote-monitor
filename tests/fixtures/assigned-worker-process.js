'use strict';
const scope=require('../../lib/storage/tenant-scope');scope.setTenancyMode('multi');
let connection,store,held,releaseHold,generation='1';
process.on('message',async message=>{
 const {id,op,...args}=message;
 try{
  let value;
  if(op==='open'){
   if(args.brokenKeys){const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../../lib/pgstream/assigned-worker'),source=fs.readFileSync(file,'utf8'),needle="['clinical-tenant-owner',namespace,consumer,tenant]";if(!source.includes(needle))throw Error('ABLATION_NOT_APPLIED');const altered=new Module(file,module);altered.filename=file;altered.paths=Module._nodeModulePaths(path.dirname(file));altered._compile(source.replace(needle,"['clinical-tenant-owner',namespace,consumer,tenant,process.pid]"),file);require.cache[file]=altered;}
   if(args.brokenShared){const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../../lib/pgstream/typed-checkpoint'),source=fs.readFileSync(file,'utf8'),needle='selected?.fixed?{sharedKey:globalKey}:undefined';if(!source.includes(needle))throw Error('ABLATION_NOT_APPLIED');const altered=new Module(file,module);altered.filename=file;altered.paths=Module._nodeModulePaths(path.dirname(file));altered._compile(source.replace(needle,'undefined'),file);require.cache[file]=altered;}
   if(args.brokenStaticKeys){const fs=require('node:fs'),Module=require('node:module'),path=require('node:path'),file=require.resolve('../../lib/pgstream/assigned-worker'),source=fs.readFileSync(file,'utf8'),needle="['evaluator-static-owner-v1',namespace,consumer]";if(!source.includes(needle))throw Error('ABLATION_NOT_APPLIED');const altered=new Module(file,module);altered.filename=file;altered.paths=Module._nodeModulePaths(path.dirname(file));altered._compile(source.replace(needle,"['evaluator-static-owner-v1',namespace,consumer,process.pid]"),file);require.cache[file]=altered;}
   connection=await require('../../lib/storage/postgres-connection')({connectionString:process.env.NS_ASSIGNED_WORKER_URI,direct:true,max:3,idleTimeoutMillis:0,application_name:'assigned-worker-'+process.pid});
   const original=connection.query.bind(connection);connection.query=async(text,values)=>{const result=await original(text,values);if(held&&text.startsWith('UPDATE')){held=false;process.send({event:'held',pid:process.pid});await new Promise(resolve=>{releaseHold=resolve;});}return result;};
   store=require('../../lib/pgstream/typed-checkpoint').create({connection,namespace:args.namespace,consumer:'evaluator-assigned',maxBytes:1048576,timeIntervalMs:60000,...(args.global?{}:{assignment:args.slice?{slice:args.slice,roster:()=>args.tenants,currentGeneration:()=>generation}:{tenants:args.tenants,currentGeneration:()=>generation}})});
   await store.own(()=>{});await store.admit(args.tenants);value={pid:process.pid,assignment:store.assignment};
  }else if(op==='begin')value=await store.begin(args.tenant);
  else if(op==='complete'){held=args.hold===true;value=await store.complete(args.tenant,{observed:{bootstrap:'1'},identity:'a'.repeat(64),restoreGeneration:args.restore||'1',result:{checkpoint:1,trigger:'acquisition',properties:{synthetic:args.marker},emitted:[],requested:[],frame:{sgvs:[{mgdl:123}],lastUpdated:10},due:{dueAt:120000,slow:[]}}});}
  else if(op==='release'){releaseHold?.();value=true;}
  else if(op==='generation'){generation=args.generation;value=true;}
  else if(op==='work')value=await store.work();
  else if(op==='close'){await store?.close();await connection?.end();value=true;}
  else throw Error('FIXTURE_OPERATION');
  process.send({id,value});
 }catch(error){process.send({id,error:{message:error.message,code:error.code||null,causeCode:error.cause?.code||null,causeMessage:error.cause?.message||null}});}
});
process.on('disconnect',()=>process.exit(0));
