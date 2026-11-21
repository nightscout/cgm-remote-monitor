'use strict';
const work=require('../../lib/pgstream/work-state');
module.exports=function fixture(consumer){
 const lab=require('./tenant-projection-evaluator')();
 const table=()=> '"'+lab.replayNamespace+'".tenant_consumer_checkpoint';
 let store;
 return {lab,table,get store(){return store;},
  async open(){await lab.open();await require('../../lib/migrations/postgres').run('up',{direct:true,connectionString:process.env.NS_TEST_POSTGRES_ADMIN_URI,namespace:lab.replayNamespace,catalogue:require('../../migrations/candidates/postgres-evaluator-work-v2.json')});await lab.admin.query('GRANT UPDATE('+work.COLUMNS.join(',')+') ON '+table()+' TO "'+lab.readerRole+'"');await lab.admin.query('CREATE POLICY typed_receipt_fixture ON '+table()+' TO "'+lab.readerRole+'" USING (consumer=\''+consumer+'-completed\') WITH CHECK (consumer=\''+consumer+'-completed\')');},
  async reset(){await lab.reset();store=require('../../lib/pgstream/checkpoint').create({typed:true,connection:lab.reader,namespace:lab.replayNamespace,consumer,maxBytes:4*1024*1024,timeIntervalMs:60000});for(const tenant of [lab.A,lab.B])await lab.provision(store.consumer,tenant,null,0,store.digest);await store.admit([lab.A,lab.B]);},
  async row(tenant=lab.A){return (await lab.admin.query('SELECT * FROM '+table()+' WHERE tenant_id=$1 AND consumer=$2',[tenant,store.consumer])).rows[0];},
  async state(tenant=lab.A){return work.state(await this.row(tenant));},
  async seed(tenant,state){await lab.admin.query('UPDATE '+table()+' SET checkpoint=17,work_observed=$3,work_completed=$4,work_observed_at=$5,work_pending_at=$6,work_due_at=$7,work_enabled=$8,work_activity_enabled=$9,work_lifecycle_enabled=$10,projection=$11::jsonb WHERE tenant_id=$1 AND consumer=$2',[tenant,store.consumer,work.array(state.observed),work.array(state.completed),work.array(state.observedAt),state.pendingAt,state.nextDueAt,state.enabled,state.eligibility?.activity??true,state.eligibility?.lifecycle??true,JSON.stringify([{kind:'evaluator-work-v2',output:state.output??null,extra:'retained'}])]);},
  close:()=>lab.close()
 };
};
