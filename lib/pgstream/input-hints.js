'use strict';
// Hints schedule a read of durable truth; they confer no effect authority.
// Listener composition/trust remains the existing internal transport's duty.
const {validate}=require('../server/internal-api/schema');
const contract=require('../server/internal-api/contracts/pgstream-input.json');
const operation=contract.operations.hintEvaluatorInput;
function router({assignment,peers}){
 if(typeof assignment?.owner!=='function'||!Array.isArray(peers)||peers.length!==assignment.members||peers.some(peer=>typeof peer?.hintEvaluatorInput!=='function'))throw new TypeError('PGSTREAM_INPUT_HINT_PEERS');
 const selected=[...peers];
 return async function hint(tenant,kind){
   const request={tenant,kind,assignmentRevision:assignment.revision};validate(operation.request,request);
   const reply=await selected[assignment.owner(tenant)].hintEvaluatorInput(request);
   validate(operation.response,reply);return reply;
 };
}
function handler({assignment,ordinal,wake}){
 if(typeof assignment?.owner!=='function'||!Number.isInteger(ordinal)||ordinal<0||ordinal>=assignment.members||typeof wake!=='function')throw new TypeError('PGSTREAM_INPUT_HINT_HANDLER');
 return async function hintEvaluatorInput(request){
   validate(operation.request,request);
   if(request.assignmentRevision!==assignment.revision||assignment.owner(request.tenant)!==ordinal)throw new Error('PGSTREAM_INPUT_HINT_ASSIGNMENT');
   await wake(request.tenant,request.kind);return {accepted:true};
 };
}
module.exports={router,handler};
