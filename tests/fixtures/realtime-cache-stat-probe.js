#!/usr/bin/env node
'use strict';
// No-dependency D5 discriminator. It writes only synthetic {n:1}/{n:2} files.
// Capture happens in memory, without sleeps/logging between the tested calls.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const c=require('../../lib/server/realtime/contract'),bounded=require('../../lib/server/serve/config-file');
const ROOT=path.resolve(__dirname,'../..');
const EXPECTED={
 'lib/server/realtime/contract.js':'069af0306ed38e69954573dfd03baf17c08bc122c60d7605bf656d9f8e9d91a2',
 'lib/server/serve/config-file.js':'210c44a671b09af049076265b8b4d5ee792d96fd3168a0098a878f858a0b2d4b'
};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
function options(args){
 const value={iterations:1000,unchanged:50,out:null,control:'none'};
 for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);if(!['iterations','unchanged','out','control'].includes(key)||args[i+1]===undefined)fail('CACHE_PROBE_USAGE');value[key]=['out','control'].includes(key)?args[i+1]:Number(args[i+1]);}
 if(!Number.isInteger(value.iterations)||value.iterations<1||value.iterations>10000||!Number.isInteger(value.unchanged)||value.unchanged<0||value.unchanged>1000||typeof value.out!=='string'||!path.isAbsolute(value.out)||fs.existsSync(value.out)||!['none','freeze-cache'].includes(value.control))fail('CACHE_PROBE_USAGE');
 return value;
}
function clock(){return {wallMs:Date.now(),monotonicNs:process.hrtime.bigint().toString()};}
function stat(file){const s=fs.statSync(file,{bigint:true});return Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs','mode'].map(key=>[key,s[key].toString()]));}
const key=s=>Object.values(s).join(':')+':'+bounded.maxBytes({});
function run(selected){
 for(const [file,hash] of Object.entries(EXPECTED))if(digest(fs.readFileSync(path.join(ROOT,file)))!==hash)fail('CACHE_PROBE_SOURCE_MISMATCH');
 const ambient=Object.keys(process.env).filter(key=>key.startsWith('NS_')||['NODE_OPTIONS','NODE_PATH'].includes(key));if(ambient.length)fail('CACHE_PROBE_AMBIENT_ENV');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-cache-stat-probe-')),file=path.join(dir,'value.json');
 const result={kind:'d5-realtime-cache-stat-discriminator',sourceExpected:'d5e2e874659155c952b5b5deb862f12f982ac02e',sourceBlobs:EXPECTED,probeSha256:digest(fs.readFileSync(__filename)),node:process.version,kernel:os.release(),platform:os.platform(),arch:process.arch,options:{iterations:selected.iterations,unchangedCalls:selected.unchanged,control:selected.control},cacheByteLimit:bounded.maxBytes({}),started:clock(),modes:{},captures:[],captureBoundPerMode:128};
 let fullReads=0;const original=bounded.read;bounded.read=function(name,...rest){if(name===file)fullReads++;return original.call(this,name,...rest);};
 try{
  for(const mode of ['raw-inplace','cached-inplace','cached-atomic']){
   const summary={iterations:0,sameMetadata:0,stale:0,unchangedFullReads:0,unexpectedParses:0,captured:0};result.modes[mode]=summary;
   for(let iteration=0;iteration<selected.iterations;iteration++){
    fs.writeFileSync(file,'{"n":1}');let parses=0;
    let read=mode==='raw-inplace'?()=>JSON.parse(fs.readFileSync(file,'utf8')):c.parsedFile(file,value=>{parses++;return value;},{source:{}});
    if(selected.control==='freeze-cache'&&mode!=='raw-inplace'){const originalRead=read;let first;read=()=>first??(first=originalRead());}
    const initial=read().n,readsAtPrime=fullReads;
    for(let i=0;i<(mode==='raw-inplace'?0:selected.unchanged);i++)if(read().n!==1)fail('CACHE_PROBE_UNCHANGED_VALUE');
    const unchangedFullReads=fullReads-readsAtPrime,before=stat(file),beforeBytes=fs.readFileSync(file,'utf8'),beforeClock=clock();
    if(mode==='cached-atomic'){fs.writeFileSync(file+'.next','{"n":2}');fs.renameSync(file+'.next',file);}else fs.writeFileSync(file,'{"n":2}');
    const after=stat(file),afterBytes=fs.readFileSync(file,'utf8'),returned=read().n,afterClock=clock();
    const sameMetadata=key(before)===key(after),stale=returned!==2;
    summary.iterations++;summary.sameMetadata+=Number(sameMetadata);summary.stale+=Number(stale);summary.unchangedFullReads+=unchangedFullReads;
    if(mode!=='raw-inplace'&&parses!==(sameMetadata?1:2))summary.unexpectedParses++;
    if((iteration===0||sameMetadata||stale)&&summary.captured<128){result.captures.push({mode,iteration,initial,before,after,beforeKey:key(before),afterKey:key(after),beforeBytes,afterBytes,returned,parses:mode==='raw-inplace'?null:parses,unchangedFullReads,sameMetadata,stale,beforeClock,afterClock});summary.captured++;}
   }
  }
 }finally{bounded.read=original;fs.rmSync(dir,{recursive:true,force:true});}
 result.finished=clock();result.verdict=selected.control==='freeze-cache'?'CONTROL_FAILURE_DETECTED':result.modes['cached-inplace'].stale?'STALE_REPRODUCED':'NO_STALE_REPRODUCED';
 const bytes=JSON.stringify(result,null,2)+'\n';if(Buffer.byteLength(bytes)>1048576)fail('CACHE_PROBE_OUTPUT_BOUND');
 fs.writeFileSync(selected.out,bytes,{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({verdict:result.verdict,node:result.node,kernel:result.kernel,modes:result.modes})+'\n');
 return result.modes['cached-atomic'].stale||result.modes['cached-atomic'].unchangedFullReads||result.modes['cached-atomic'].unexpectedParses?3:result.modes['cached-inplace'].stale?2:0;
}
try{process.exitCode=run(options(process.argv.slice(2)));}catch(error){process.stderr.write((/^[A-Z_]+$/.test(error.code||'')?error.code:'CACHE_PROBE_FAILED')+'\n');process.exitCode=78;}
