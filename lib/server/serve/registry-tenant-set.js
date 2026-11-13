'use strict';

// Registry discovery and atomic background-role admission. Revision polling is
// independent of bounded admission work: one failed new tenant cannot stop the
// metadata removal path or an existing tenant's evaluator/timers.
const connect = require('../../storage/postgres-connection');
const registry = require('../../tenant-registry/postgres');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => Object.assign(new Error(code),{code});
function predecessor (tenant) {
  const number=BigInt('0x'+tenant.replace(/-/g,''));if(!number)return null;
  const hex=(number-1n).toString(16).padStart(32,'0');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
function create ({ store, first, settings, maxTenants, build, accept=()=>true, selectionKey=()=>null, now=Date.now,
  alert=(code,detail)=>console.warn('Tenant registry alert',code,detail),schedule=setInterval,cancel=clearInterval,close=async()=>{} }) {
  if(!store || !Array.isArray(first?.tenants) || typeof build!=='function' || !Number.isSafeInteger(maxTenants) || maxTenants<1 || first.tenants.length>maxTenants)throw fail('TENANT_REGISTRY_OVER_BOUND');
  const selected=first.tenants.filter(accept),initial=new Set(selected),tenants=new Map(selected.map(t=>[t,build(t)]));
  let known=[...first.tenants],selection=selectionKey();
  let observed=new Set(selected),active=new Set(selected),revision=first.revision,waiting=0,polling=null,closed=false,hooks=null,closing;
  const pending=new Map(),jobs=new Set(),removing=new Map();
  const counters={polls:0,pollErrors:0,enumerations:1,removed:0,added:0,admissionRefused:0};
  function report(code,detail){try{alert(code,detail);}catch{/* observation cannot authorize admission */}}
  function pump(){
    if(closed || !hooks)return;
    let slots=hooks.concurrency-jobs.size,visited=0;
    for(const [tenant,row] of pending){
      if(slots<1 || visited++>=32)break;
      if(row.running || row.after>now() || removing.has(tenant))continue;
      row.running=true;slots--;
      const job=(async()=>{
        let rollback;
        try{
          const entry=build(tenant);rollback=await hooks.prepare(tenant,entry);
          if(rollback!==undefined && typeof rollback!=='function')throw fail('TENANT_REGISTRY_ADMISSION_PROTOCOL');
          // Existing narrow enumerator grant suffices for an exact membership
          // recheck. No new lookup/read grant or row-security exception.
          const current=await store.page(predecessor(tenant),1);
          if(closed || pending.get(tenant)!==row || !observed.has(tenant) || !accept(tenant) || current.tenants[0]!==tenant)throw fail('TENANT_REGISTRY_ADMISSION_STALE');
          tenants.set(tenant,entry);active.add(tenant);
          const activated=hooks.activate(tenant,entry);
          if(activated && typeof activated.then==='function')throw fail('TENANT_REGISTRY_ACTIVATION_MUST_BE_SYNCHRONOUS');
          pending.delete(tenant);counters.added++;
        }catch(error){
          active.delete(tenant);tenants.delete(tenant);try{await rollback?.();}catch{report('TENANT_REGISTRY_ROLLBACK_REFUSED',{count:1});}
          counters.admissionRefused++;
          if(pending.get(tenant)===row){row.after=now()+settings.refreshMs;pending.delete(tenant);pending.set(tenant,row);}
          report('TENANT_REGISTRY_ADMISSION_REFUSED',{waiting:pending.size,code:/^[A-Z_]+$/.test(error?.code||'')?error.code:'TENANT_WARM_FAILED'});
        }finally{row.running=false;}
      })();
      jobs.add(job);job.finally(()=>{jobs.delete(job);waiting=pending.size;pump();}).catch(()=>{});
    }
  }
  function withdraw(tenant){
    // Hide before asynchronous cancellation/drain. A late prepare cannot make
    // this tenant active again: its pending row identity has been removed.
    active.delete(tenant);tenants.delete(tenant);pending.delete(tenant);
    if(hooks && !removing.has(tenant)){
      const job=Promise.resolve().then(()=>hooks.remove(tenant)).catch(()=>report('TENANT_REGISTRY_REMOVAL_REFUSED',{count:1})).finally(()=>removing.delete(tenant));
      removing.set(tenant,job);
    }
  }
  async function poll(force=false){
    if(closed)return;if(polling)return polling;
    polling=(async()=>{
      counters.polls++;
      try{
        const nextSelection=selectionKey(),nextRevision=await store.revision();
        const changed=force || nextRevision!==revision;
        if(changed){
          const next=await store.enumerate({pageSize:1000});
          if(next.tenants.length>maxTenants)throw fail('TENANT_REGISTRY_OVER_BOUND');
          counters.enumerations++;revision=next.revision;known=[...next.tenants];
        }
        if(changed || nextSelection!==selection){
          selection=nextSelection;
          const selected=known.filter(accept);observed=new Set(selected);
          if(hooks){
            for(const tenant of [...active])if(!observed.has(tenant)){withdraw(tenant);counters.removed++;}
            for(const tenant of selected)if(!tenants.has(tenant) && !pending.has(tenant))pending.set(tenant,{after:0,running:false});
            for(const tenant of [...pending.keys()])if(!observed.has(tenant))withdraw(tenant);
            waiting=pending.size;
          }else{
            active=new Set(selected.filter(t=>initial.has(t)));counters.removed=initial.size-active.size;
            const count=selected.filter(t=>!initial.has(t)).length;
            if(count>waiting)report('TENANT_REGISTRY_EXPANSION_RESTART',{waiting:count});waiting=count;
          }
        }
        pump();
      }catch{counters.pollErrors++;}finally{polling=null;}
    })();return polling;
  }
  const timer=schedule(()=>{poll();},settings.refreshMs);timer?.unref?.();
  return Object.freeze({tenants,isActive:tenant=>!closed && active.has(tenant),activeIds:()=>new Set(active),poll,
    revision:()=>revision,waiting:()=>waiting,tenantIds:Object.freeze(['registry:'+settings.namespace]),
    async follow({prepare,activate,remove,concurrency=1}){
      if(hooks || [prepare,activate,remove].some(fn=>typeof fn!=='function') || !Number.isSafeInteger(concurrency) || concurrency<1 || concurrency>4)throw fail('TENANT_REGISTRY_FOLLOW_REFUSED');
      hooks={prepare,activate,remove,concurrency};await poll(true);
    },
    async drained(){while(jobs.size || removing.size)await Promise.allSettled([...jobs,...removing.values()]);},
    stats:()=>Object.freeze({...counters,configured:tenants.size,active:active.size,revision,waiting,live:!!hooks,pending:pending.size}),
    close(){if(!closing){closed=true;cancel(timer);closing=(async()=>{await polling;await Promise.allSettled([...jobs,...removing.values()]);await close();})();}return closing;}
  });
}
async function open({settings,connectionString,maxTenants,build,applicationName='nightscout-registry-set',...options}){
  if(!settings || typeof build!=='function')throw new TypeError('Registry tenant set requires explicit settings and builder');
  const connection=await connect({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:10000,application_name:applicationName});
  try{const store=registry.create({connection,namespace:settings.namespace});const first=await store.enumerate({pageSize:1000});
    return create({settings,maxTenants,build,store,first,...options,close:()=>connection.end()});
  }catch(error){await connection.end().catch(()=>{});throw error;}
}
module.exports={open,create,predecessor,UUID};
