'use strict';
// Fixed process assignment and cached LOCAL resource availability. This view
// neither discovers peers nor claims that K processes are live. Registry and
// role admission remain separate from the configured hash assignment.
const {idle,bucket,RULE}=require('../pool-membership/slice');
function create({shape,tenants,available}){
 if(!shape||Object.keys(shape).sort().join(',')!=='count,ordinal'||!Array.isArray(tenants)||typeof available!=='function')throw new TypeError('EVALUATOR_STATIC_GATE_CONFIG');
 idle(shape.count,shape.ordinal);shape=Object.freeze({...shape}); // an ordinal >= count admits nothing
 const roster=new Set(tenants);if(roster.size!==tenants.length||tenants.some(tenant=>bucket(tenant,shape.count)!==shape.ordinal))throw new Error('EVALUATOR_STATIC_GATE_ROSTER_REFUSED');let closed=false;
 const owner=tenant=>bucket(tenant,shape.count);
 const eligible=()=>!closed&&available()===true;
 function admits(tenant){if(!eligible())return false;try{return owner(tenant)===shape.ordinal;}catch{return false;}}
 const reason=()=>closed?'EVALUATOR_STATIC_GATE_CLOSED':eligible()?null:'EVALUATOR_OWNER_UNAVAILABLE';
 return Object.freeze({static:true,partitioned:false,admits,reason,
  start(){},async refresh(){return null;},onChange(){return()=>{};},
  addTenant(tenant){if(owner(tenant)!==shape.ordinal)throw new Error('EVALUATOR_ASSIGNMENT_FOREIGN_TENANT');roster.add(tenant);},removeTenant:tenant=>roster.delete(tenant),
  async inspect(){return {kind:'evaluator',configured:{mode:'static',count:shape.count,ordinal:shape.ordinal,rule:RULE,leaseMs:null,configuredTenants:roster.size},
   observed:null,gate:{eligible:eligible(),reason:reason(),members:shape.count,reads:0,refusals:0,changes:0,checkedAgeMs:null,heartbeats:null},owner,admits};},
  close(){closed=true;}
 });
}
module.exports={create};
