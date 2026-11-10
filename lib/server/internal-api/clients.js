'use strict';

const contracts = require('./contracts');
const transport = require('./transport');

module.exports = Object.freeze({
  socketAuthority: options => transport.client(options, contracts.socketAuthority),
  alarmDelivery: options => transport.client(options, contracts.alarmDelivery),
  lifecycleParticipant: options => transport.client(options, contracts.lifecycleParticipant),
  ownershipOperations: options => transport.client(options, contracts.ownershipOperations)
});
