'use strict';
const c=require('./contract');
const listenerConfig=require('../internal-api/listener-config');
const MAX_SOCKETS_REMOVED='REALTIME_CONFIG_MAX_SOCKETS_REMOVED';
const invalid=()=>c.fail('REALTIME_CONFIG_REFUSED');
function parse(value,source,internal=listenerConfig.resolve(['realtime'],source)){
  if(c.object(value)&&Object.hasOwn(value,'maxSockets'))throw Object.assign(new Error(MAX_SOCKETS_REMOVED+': remove maxSockets; connection limits belong to the edge'),{code:MAX_SOCKETS_REMOVED});
  if(!c.object(value)||!value.registry||['tenants','admissionFileEnv'].some(key=>Object.hasOwn(value,key)))c.fail('REALTIME_REGISTRY_REQUIRED');
  if(!value.completedOutput||!value.trustedWorker||['pageSize','recoveryIntervalMs','settingsRefreshMs','socketOrderDomains','changeFeed'].some(key=>Object.hasOwn(value,key)))c.fail('REALTIME_COMPLETED_OUTPUT_REQUIRED');
  const fields=['version','postgres','consumer','maxRows','maxBytes','registry','maxMessageBytes','operationTimeoutMs','completedOutput','trustedWorker','tenantSettings','activity'];
  const timings=['authorizationRecheckMs','unauthorizedDeadlineMs'];
  if(!c.exact(value,fields,[...timings,'maxTenants'])||value.version!==1||(value.maxTenants!==undefined&&!c.integer(value.maxTenants))||['maxRows','maxBytes','maxMessageBytes','operationTimeoutMs'].some(key=>!c.integer(value[key]))||
    timings.some(key=>value[key]!==undefined&&!c.integer(value[key],2147483647))||value.operationTimeoutMs>2147483647||!/^realtime-[A-Za-z0-9_-]{1,112}$/.test(value.consumer)||
    !c.exact(value.postgres,['connectionEnv','namespaces'])||!c.exact(value.postgres.namespaces,['clock','checkpoint']))invalid();
  const namespaces=value.postgres.namespaces,names=Object.values(namespaces);
  const validName=name=>typeof name==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(name)&&!name.startsWith('pg_')&&!['public','information_schema'].includes(name);
  if(new Set(names).size!==names.length||names.some(name=>!validName(name)))invalid();
  const connectionString=c.reference(value.postgres.connectionEnv,source);
  require('../serve/evaluator-consumer-config').endpoint(connectionString);
  const completedOutput=require('../../pgstream/config').output(value.completedOutput);
  const worker=require('../../trusted-worker/postgres').parse(value.trustedWorker);
  const tenantSettings=require('../serve/settings-config')(value.tenantSettings,source,{namespaces,connections:[connectionString]},{invalid});
  if(!c.exact(value.activity,['namespace'])||!validName(value.activity.namespace)||names.includes(value.activity.namespace)||worker.clock!==namespaces.clock||worker.activity!==value.activity.namespace||
    worker.settings!==tenantSettings.namespaces.settings||worker.operatorPolicy!==tenantSettings.namespaces.operatorPolicy)invalid();
  const registry=require('../serve/registry-config').registry(value.registry,invalid);
  const api=internal.peer('api',{maxBytes:value.maxMessageBytes,timeoutMs:value.operationTimeoutMs});
  return {...value,maxTenants:value.maxTenants??registry.maxTenants,connectionString,namespaces,completedOutput,tenantSettings,registry,tenantIds:Object.freeze(['registry:'+registry.namespace]),tenants:new Map(),api,
    infrastructure:c.identity([value,connectionString,tenantSettings,api])};
}
function load(source,internal){
  let initial;
  try{initial=parse(c.file(source.MULTITENANT_REALTIME_CONFIG,{label:'MULTITENANT_REALTIME_CONFIG',source}),source,internal);}
  catch(error){if(c.isConfigFileRefusal(error)||[MAX_SOCKETS_REMOVED,'REALTIME_REGISTRY_REQUIRED','REALTIME_COMPLETED_OUTPUT_REQUIRED'].includes(error?.code))throw error;invalid();}
  const ownership=require('../../realtime-ownership').load(source);
  // Registry membership and committed presentation settings are the only live
  // tenant authority. The boot file has no per-tenant state to poll or reparse.
  return Object.freeze({...initial,ownership,admission:null,readCurrent:null,readAll:null});
}
module.exports={parse,load,MAX_SOCKETS_REMOVED};
