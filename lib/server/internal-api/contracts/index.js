'use strict';

// Runtime dispatch, clients and documentation share these service-owned contracts.
// Freezing prevents a caller from adding operations after a listener is composed.
function freeze (value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
module.exports = Object.freeze({
  socketAuthority: freeze(require('./socket-authority.json')),
  completedOutput: freeze(require('./completed-output.json')),
  alarmDelivery: freeze(require('./alarm-delivery.json')),
  roleHealth: freeze(require('./role-health.json')),
  ownershipOperations: freeze(require('./ownership-operations.json')),
  connectorInspection: freeze(require('./connector-inspection.json')),
  evaluatorInspection: freeze(require('./evaluator-inspection.json')),
  evaluatorReadinessWitness: freeze(require('./evaluator-readiness-witness.json')),
  poolOperations: freeze(require('./pool-operations.json')),
  realtimeInspection: freeze(require('./realtime-inspection.json'))
});
