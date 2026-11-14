'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const config=require('../lib/server/realtime/config');
const fixture=require('./fixtures/realtime-completed-config');
describe('maintained realtime completed-source product configuration',function(){
 it('requires registry and exact typed output source, without retired discovery or clinical namespace configuration',function(){
  const {value,source}=fixture();const parsed=config.parse(value,source);
  assert.deepEqual(Object.keys(parsed.namespaces).sort(),['checkpoint','clock']);assert.equal(parsed.completedOutput.consumer,'evaluator-test');
  assert.deepEqual(parsed.tenantIds,['registry:'+parsed.registry.namespace],'registry cohort boot must name its configured tenant family');assert.equal(Object.isFrozen(parsed.tenantIds),true);
  for(const key of ['completedOutput','trustedWorker','registry']){const bad=structuredClone(value);delete bad[key];assert.throws(()=>config.parse(bad,source),/REQUIRED/);}
  for(const extra of [{changeFeed:{}},{pageSize:1},{recoveryIntervalMs:1000},{settingsRefreshMs:1000},{socketOrderDomains:[]},{tenants:[]},{admissionFileEnv:'ADMISSION'}])assert.throws(()=>config.parse({...value,...extra},source),/REQUIRED/);
  for(const extra of [{entries:'raw_entries'},{changeStamps:'old_stamps'}])assert.throws(()=>config.parse({...value,postgres:{...value.postgres,namespaces:{...value.postgres.namespaces,...extra}}},source));
  assert.throws(()=>config.parse({...value,completedOutput:{namespace:'public',consumer:'evaluator-test'}},source));
 });
 it('reads bounded boot configuration once; live tenant authority is supplied by registry and committed settings',function(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rt-completed-config-')),file=path.join(dir,'config.json');
  try{const {value,source}=fixture();fs.writeFileSync(file,JSON.stringify(value));const loaded=config.load({...source,MULTITENANT_REALTIME_CONFIG:file});
   assert.equal(loaded.readCurrent,null);assert.equal(loaded.readAll,null);assert.equal(loaded.registry.namespace,'rt_registry');
   fs.writeFileSync(file,'invalid after boot');assert.equal(loaded.registry.namespace,'rt_registry');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});
