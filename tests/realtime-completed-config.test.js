'use strict';
const assert=require('node:assert/strict');
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
 it('builds its boot configuration from the environment once; live tenant authority is supplied by registry and committed settings',function(){
  const {source}=fixture();
  const loaded=config.load({...source,NS_PG_PREFIX:'rt',NS_REALTIME_PG:source.RT_DB,NS_DISPLAY_PG:source.RT_SETTINGS_DB});
  assert.equal(loaded.readCurrent,null);assert.equal(loaded.readAll,null);assert.equal(loaded.registry.namespace,'rt_registry');
  assert.deepEqual({...loaded.namespaces},{clock:'rt_clock',checkpoint:'rt_rt_checkpoint'});assert.equal(loaded.completedOutput.namespace,'rt_eval_checkpoint');
 });
});
