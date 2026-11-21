'use strict';
module.exports=function(extra={}){
 const value={version:1,postgres:{connectionEnv:'RT_DB',namespaces:{clock:'rt_clock',checkpoint:'rt_checkpoint'}},consumer:'realtime-test',maxRows:100,maxBytes:100000,maxTenants:10,maxMessageBytes:10000,operationTimeoutMs:1000,
  registry:{namespace:'rt_registry',refreshMs:500},completedOutput:{namespace:'ev_checkpoint',consumer:'evaluator-test'},
  trustedWorker:{clock:'rt_clock',activity:'rt_activity',settings:'rt_settings',operatorPolicy:'rt_policy'},
  tenantSettings:{connectionEnv:'RT_SETTINGS_DB',namespaces:{settings:'rt_settings',operatorPolicy:'rt_policy'}},activity:{namespace:'rt_activity'},...extra};
 return {value,source:{RT_DB:'postgres://synthetic:synthetic@127.0.0.1/disposable_test',RT_SETTINGS_DB:'postgres://settings:synthetic@127.0.0.1/disposable_test',NS_API_INTERNAL_SOCKET:'/tmp/a.sock'}};
};
