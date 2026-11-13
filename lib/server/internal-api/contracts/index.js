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
  alarmDelivery: freeze(require('./alarm-delivery.json')),
  lifecycleParticipant: freeze(require('./lifecycle-participant.json')),
  ownershipOperations: freeze(require('./ownership-operations.json')),
  connectorInspection: freeze(require('./connector-inspection.json')),
  evaluatorInspection: freeze(require('./evaluator-inspection.json')),
  poolOperations: freeze(require('./pool-operations.json'))
});
