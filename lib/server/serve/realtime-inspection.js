'use strict';
// Cached bounded private observations, never owner-lock/data-freshness proof.
// UDS permissions / selected HTTP network trust remain authority; service
// headers are NOT authentication. No request warms or invalidates a tenant.
const c=require('../realtime/contract'),placementRules=require('../../realtime-placement');
const fail=()=>{throw Object.assign(Error('REALTIME_INSPECTION_REFUSED'),{code:'REALTIME_INSPECTION_REFUSED'});};
const tenant=v=>c.uuid(v)&&v!=='00000000-0000-0000-0000-000000000000';
module.exports=function inspection({processIncarnation,placement,owner,quiescing,startup,modelWarm,runtimeStats,detectorStats,watchedCount,deliveryStats}){
  const startupRead=typeof startup?.isReady==='function'?t=>startup.isReady(t):null;
  function stats(){
    let runtime=null,watched=null,detector=null;
    try{runtime=runtimeStats?.()||null;}catch{/* unavailable is explicit */}
    try{watched=watchedCount?.();}catch{/* unavailable is explicit */}
    try{detector=detectorStats?.()||null;}catch{/* unavailable is explicit */}
    const available=!!runtime&&Number.isSafeInteger(watched)&&watched>=0;
    return {version:1,available,runtime:available?runtime:null,detector:{available:!!detector,polls:detector?.polls??null,failures:detector?.failures??null},watchedCount:available?watched:null,...(deliveryStats?{delivery:deliveryStats()||null}:{})};
  }
  function snapshot(){const closing=quiescing()===true;return{kind:'realtime',observation:'cached-not-lock-proof',processIncarnation,phase:closing?'quiescing':'booted',placement:placement?.cached?.()||null,ownerAvailable:!closing&&owner()===true,stats:stats()};}
  return function create(token){return{
    async inspectRealtime(request){if(request.transport!==token)fail();return snapshot();},
    async inspectRealtimeTenants(request,body){
      if(request.transport!==token)fail();
      if(!c.exact(body,['tenants'])||!Array.isArray(body.tenants)||body.tenants.length>128||new Set(body.tenants).size!==body.tenants.length||body.tenants.some(t=>!tenant(t)))fail();
      const view=snapshot(),p=view.placement,shards=new Set(p?.shards||[]);
      const observe=(fn,t)=>{if(typeof fn!=='function')return null;try{const value=fn(t);return typeof value==='boolean'?value:null;}catch{return null;}};
      return{...view,observation:'cached-readiness-not-lock-or-data-freshness-proof',tenants:body.tenants.map(t=>{
        const owned=!!p&&shards.has(placementRules.shard(t,p.shardCount));
        const startupComplete=observe(startupRead,t),modelAvailable=observe(modelWarm,t);
        return{tenant:t,owned,startupComplete,modelAvailable,ready:owned&&view.ownerAvailable&&view.phase==='booted'&&startupComplete===true&&modelAvailable===true};
      })};
    }
  };};
};
