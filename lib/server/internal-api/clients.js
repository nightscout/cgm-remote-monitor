'use strict';

const contracts = require('./contracts');
const transport = require('./transport');
const {isDeepStrictEqual:equal}=require('node:util');
function realtimeInspection(options){
  const raw=transport.client(options,contracts.realtimeInspection);
  const methods=Object.assign(Object.create(null),raw);
  methods.inspectRealtimeTenants=async function(body,signal){
    let wire;try{wire=JSON.parse(JSON.stringify(body));}catch{throw Object.assign(Error('SOCKET_IPC_REQUEST_REFUSED'),{code:'SOCKET_IPC_REQUEST_REFUSED'});}
    const selected=wire?.tenants;
    const reply=await raw.inspectRealtimeTenants(wire,signal);
    if(!equal(reply.tenants.map(row=>row.tenant),selected))throw Object.assign(Error('REALTIME_INSPECTION_SELECTION_MISMATCH'),{code:'REALTIME_INSPECTION_SELECTION_MISMATCH'});
    return reply;
  };
  return Object.freeze(methods);
}
function evaluatorReadinessWitness(options){
  const raw=transport.client(options,contracts.evaluatorReadinessWitness);
  return Object.freeze({async inspectReadinessWitness(body,signal){
    let wire;try{wire=JSON.parse(JSON.stringify(body));}catch{throw Object.assign(Error('SOCKET_IPC_REQUEST_REFUSED'),{code:'SOCKET_IPC_REQUEST_REFUSED'});}
    const reply=await raw.inspectReadinessWitness(wire,signal);
    if(reply.runtimeId!==wire.runtimeId||!equal(reply.tenants.map(row=>row.tenant),wire.tenants))throw Object.assign(Error('EVALUATOR_READINESS_SELECTION_MISMATCH'),{code:'EVALUATOR_READINESS_SELECTION_MISMATCH'});
    return reply;
  }});
}

module.exports = Object.freeze({
  socketAuthority: options => transport.client(options, contracts.socketAuthority),
  completedOutput: options => transport.client(options, contracts.completedOutput),
  alarmDelivery: options => transport.client(options, contracts.alarmDelivery),
  ownershipOperations: options => transport.client(options, contracts.ownershipOperations),
  connectorInspection: options => transport.client(options, contracts.connectorInspection),
  evaluatorInspection: options => transport.client(options, contracts.evaluatorInspection),
  evaluatorReadinessWitness,
  realtimeInspection
});
